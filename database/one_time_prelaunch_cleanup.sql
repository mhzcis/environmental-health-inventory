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
  mat_count int;
  tx_count int;
  pes_id text;
  unexpected_mats int;
  unexpected_txs int;
BEGIN
  SELECT count(*) INTO unexpected_mats
  FROM public.materials
  WHERE lower(btrim(data->>'code')) <> 'pes-1001';
  IF unexpected_mats > 0 THEN
    RAISE EXCEPTION 'PRELAUNCH_CLEANUP_ABORTED_UNEXPECTED_MATERIALS:%', unexpected_mats;
  END IF;

  SELECT count(*), min(id) INTO mat_count, pes_id
  FROM public.materials
  WHERE lower(btrim(data->>'code')) = 'pes-1001';
  IF mat_count <> 1 THEN
    RAISE EXCEPTION 'PRELAUNCH_CLEANUP_ABORTED_PES1001_COUNT:%', mat_count;
  END IF;

  SELECT count(*) INTO unexpected_txs
  FROM public.transactions
  WHERE data->>'itemId' IS DISTINCT FROM pes_id
    AND lower(btrim(coalesce(data->>'itemCode', ''))) <> 'pes-1001';
  IF unexpected_txs > 0 THEN
    RAISE EXCEPTION 'PRELAUNCH_CLEANUP_ABORTED_UNEXPECTED_TRANSACTIONS:%', unexpected_txs;
  END IF;

  SELECT count(*) INTO tx_count FROM public.transactions;
  IF tx_count <> 9 THEN
    RAISE EXCEPTION 'PRELAUNCH_CLEANUP_ABORTED_TX_COUNT:% (expected 9)', tx_count;
  END IF;
END $cleanup_pre$;

-- 1. Delete the 9 test transactions and test material PES-1001
DELETE FROM public.transactions;
DELETE FROM public.materials WHERE lower(btrim(data->>'code')) = 'pes-1001';

-- 2. Remove the single QA test reservation pes-1001 from the permanent code registry
DELETE FROM inventory_private.material_code_registry WHERE code_key = 'pes-1001';

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
      'affectedEntities', jsonb_build_array('materials/PES-1001', 'settings/app_config'),
      'result', 'committed'
    ),
    now()
  );
END $cleanup_post$;

COMMIT;
