-- ONE-TIME PRE-LAUNCH CLEANUP SCRIPT (PREPARED ONLY; RUN MANUALLY WITH OWNER APPROVAL).
-- Purpose:
--   Clean the single QA test item PES-1001 and its 9 test transactions before production launch,
--   remove the 'pes-1001' reservation from inventory_private.material_code_registry, reset all
--   voucher counters to 0, clear inventory_private.category_policy and inventory_private.warehouse_usage,
--   validate inventory invariants, and append one immutable audit log entry without altering any
--   existing audit_logs rows.
--
-- Effect:
--   - First newly created pesticide material after launch will receive PES-1001.
--   - All permanent code reservation and sequential numbering constraints remain fully active afterward.
--   - Existing audit_logs history is preserved untouched.
BEGIN;
SET LOCAL lock_timeout = '5s';
SELECT pg_advisory_xact_lock(824671520);

DO $cleanup_pre$
DECLARE
  pes_id constant text := 'mat-1793795662160';
  n int;
BEGIN
  -- Must run AFTER database/migrations/CONDITIONAL_LOCKS_MIGRATION.sql (otherwise the pinned five-category policy
  -- would be re-required and the conditional-lock tables would not exist).
  IF to_regclass('inventory_private.warehouse_usage') IS NULL OR to_regprocedure('inventory_private.reference_usage()') IS NULL
     OR to_regclass('inventory_private.material_code_registry') IS NULL OR to_regclass('inventory_private.category_policy') IS NULL THEN
    RAISE EXCEPTION 'PRELAUNCH_CLEANUP_ABORTED_MIGRATION_NOT_APPLIED';
  END IF;
  -- Exact production shape observed read-only on 2026-11-20: one material, nine ledger rows, one reservation.
  SELECT count(*) INTO n FROM public.materials;
  IF n <> 1 OR NOT EXISTS (SELECT 1 FROM public.materials WHERE id = pes_id AND lower(btrim(data->>'code')) = 'pes-1001') THEN
    RAISE EXCEPTION 'PRELAUNCH_CLEANUP_ABORTED_UNEXPECTED_MATERIALS:% (expected only % PES-1001)', n, pes_id;
  END IF;
  SELECT count(*) INTO n FROM public.transactions;
  IF n <> 9 THEN
    RAISE EXCEPTION 'PRELAUNCH_CLEANUP_ABORTED_TX_COUNT:% (expected 9)', n;
  END IF;
  SELECT count(*) INTO n FROM public.transactions
  WHERE data->>'itemId' IS DISTINCT FROM pes_id OR lower(btrim(coalesce(data->>'itemCode', ''))) <> 'pes-1001';
  IF n > 0 THEN
    RAISE EXCEPTION 'PRELAUNCH_CLEANUP_ABORTED_UNEXPECTED_TRANSACTIONS:%', n;
  END IF;
  SELECT count(*) INTO n FROM inventory_private.material_code_registry;
  IF n <> 1 OR NOT EXISTS (SELECT 1 FROM inventory_private.material_code_registry WHERE code_key = 'pes-1001' AND material_id = pes_id) THEN
    RAISE EXCEPTION 'PRELAUNCH_CLEANUP_ABORTED_UNEXPECTED_REGISTRY:% (expected only pes-1001)', n;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.settings WHERE id = 'app_config') THEN
    RAISE EXCEPTION 'PRELAUNCH_CLEANUP_ABORTED_SETTINGS_MISSING';
  END IF;
END $cleanup_pre$;

-- 1. Delete the 9 test transactions and test material PES-1001
DELETE FROM public.transactions WHERE data->>'itemId' = 'mat-1793795662160';
DELETE FROM public.materials WHERE id = 'mat-1793795662160';

-- 2. Remove the single QA test reservation pes-1001 from the permanent code registry
DELETE FROM inventory_private.material_code_registry WHERE code_key = 'pes-1001' AND material_id = 'mat-1793795662160';

-- 3. Reset all voucher counters to 0 in app_config
UPDATE public.settings
SET data = jsonb_set(
      data,
      '{transactionCounters}',
      '{"inbound":0,"outbound":0,"consumed":0,"transfer":0,"adjustment":0,"opening":0}'::jsonb,
      true
    ),
    updated_at = now()
WHERE id = 'app_config';

-- 4. Clear conditional lock tables (will auto-populate again on first real production use)
DELETE FROM inventory_private.category_policy;
DELETE FROM inventory_private.warehouse_usage;

-- 5. Verify all server invariants hold
DO $cleanup_post$
DECLARE
  audit_id text := 'prelaunch-cleanup-pes1001-' || to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYYMMDDHH24MISSMS');
  stamp text := to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
BEGIN
  PERFORM inventory_private.validate_inventory();
  IF EXISTS (SELECT 1 FROM public.materials) OR EXISTS (SELECT 1 FROM public.transactions)
     OR EXISTS (SELECT 1 FROM inventory_private.material_code_registry) OR EXISTS (SELECT 1 FROM inventory_private.category_policy)
     OR EXISTS (SELECT 1 FROM inventory_private.warehouse_usage) THEN
    RAISE EXCEPTION 'PRELAUNCH_CLEANUP_VERIFY_FAILED';
  END IF;

  -- 6. Append one audit receipt without touching existing audit_logs rows
  INSERT INTO public.audit_logs(id, data, updated_at)
  VALUES (
    audit_id,
    jsonb_build_object(
      'id', audit_id,
      'timestamp', stamp,
      'user', 'النظام (تنظيف ما قبل الإطلاق)',
      'actorUserId', 'system-prelaunch-cleanup',
      'actorDisplayName', 'النظام (تنظيف ما قبل الإطلاق)',
      'action', 'تنظيف بيانات الاختبار قبل الإطلاق',
      'details', 'تم حذف مادة الاختبار PES-1001 وعدد 9 حركات تجريبية وإزالة حجز pes-1001 وتصفير عدادات الأذون وتفريغ جداول الأقفال المشروطة قبل الإطلاق مع الإبقاء على سجل التدقيق السابق وقيود حجز الأكواد.',
      'itemType', 'إعدادات',
      'operationType', 'system',
      'affectedEntities', jsonb_build_array('materials/mat-1793795662160', 'settings/app_config'),
      'result', 'committed'
    ),
    now()
  );
END $cleanup_post$;

COMMIT;
