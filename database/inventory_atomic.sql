-- Atomic inventory API. No new business/queue table; immutable audit rows are receipts.
-- The private definer is intentional: direct JSON document writes are revoked.
-- Every entry checks the current Auth UID and live profile permissions; never JWT user_metadata.
CREATE UNIQUE INDEX IF NOT EXISTS inventory_material_code_unique ON public.materials (lower(btrim(data->>'code')));
CREATE UNIQUE INDEX IF NOT EXISTS inventory_transaction_number_unique ON public.transactions (lower(btrim(data->>'transactionNumber')));
CREATE UNIQUE INDEX IF NOT EXISTS inventory_generator_date_unique ON public.generator_logs ((data->>'date'));
CREATE INDEX IF NOT EXISTS inventory_ledger_item_warehouse_date ON public.transactions ((data->>'itemId'), (data->>'storehouseId'), (data->>'date'));

CREATE OR REPLACE FUNCTION inventory_private.state_hash() RETURNS text
LANGUAGE sql STABLE SET search_path = '' AS $$
 SELECT encode(sha256(convert_to(coalesce(jsonb_agg(jsonb_build_array(collection,id,x) ORDER BY collection,id)::text,'[]'),'UTF8')),'hex')
 FROM (SELECT 'materials' collection,id,data x FROM public.materials
       UNION ALL SELECT 'transactions',id,data FROM public.transactions
       UNION ALL SELECT 'generator_logs',id,data FROM public.generator_logs
       UNION ALL SELECT 'settings',id,data FROM public.settings
       UNION ALL SELECT 'users',id,data FROM public.users) s;
$$;

CREATE OR REPLACE FUNCTION inventory_private.validate_inventory() RETURNS void
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE cfg jsonb; row_data jsonb; v_date text;
BEGIN
 SELECT data INTO cfg FROM public.settings WHERE id='app_config';
 IF cfg IS NULL OR jsonb_typeof(cfg->'storehouseEntities') IS DISTINCT FROM 'array' OR jsonb_array_length(cfg->'storehouseEntities')=0
    OR jsonb_typeof(cfg->'units') IS DISTINCT FROM 'array' OR jsonb_typeof(cfg->'categories') IS DISTINCT FROM 'array'
 THEN RAISE EXCEPTION 'INVENTORY_SETTINGS_INVALID' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(cfg->'storehouseEntities') w
           WHERE nullif(btrim(w->>'id'),'') IS NULL OR nullif(btrim(w->>'name'),'') IS NULL OR jsonb_typeof(w->'active') IS DISTINCT FROM 'boolean')
    OR EXISTS(SELECT 1 FROM jsonb_array_elements(cfg->'storehouseEntities') w GROUP BY w->>'id' HAVING count(*)>1)
    OR EXISTS(SELECT 1 FROM jsonb_array_elements(cfg->'storehouseEntities') w GROUP BY lower(btrim(w->>'name')) HAVING count(*)>1)
 THEN RAISE EXCEPTION 'INVENTORY_WAREHOUSE_INVALID' USING ERRCODE='23514'; END IF;
 -- QA-20261109 R8 CFG-02: validate category names, prefixes, and non-overlapping numeric ranges when configured.
 IF jsonb_array_length(cfg->'categories')=0 OR jsonb_array_length(cfg->'categories')>6
    OR EXISTS(SELECT 1 FROM jsonb_array_elements(cfg->'categories') c
      WHERE jsonb_typeof(c) IS DISTINCT FROM 'object' OR nullif(btrim(c->>'name'),'') IS NULL
        OR (c ? 'prefix' AND (jsonb_typeof(c->'prefix') IS DISTINCT FROM 'string' OR btrim(c->>'prefix') !~ '^[A-Za-z0-9]{2,12}$'))
        OR ((c ? 'startRange' OR c ? 'endRange') AND (
            jsonb_typeof(c->'startRange') IS DISTINCT FROM 'number' OR jsonb_typeof(c->'endRange') IS DISTINCT FROM 'number'
            OR (c->>'startRange')::numeric <> trunc((c->>'startRange')::numeric)
            OR (c->>'endRange')::numeric <> trunc((c->>'endRange')::numeric)
            OR (c->>'startRange')::numeric < 0 OR (c->>'startRange')::numeric > (c->>'endRange')::numeric)))
    OR EXISTS(SELECT 1 FROM jsonb_array_elements(cfg->'categories') c GROUP BY lower(btrim(c->>'name')) HAVING count(*)>1)
    OR EXISTS(SELECT 1 FROM jsonb_array_elements(cfg->'categories') c WHERE nullif(btrim(c->>'prefix'),'') IS NOT NULL GROUP BY lower(btrim(c->>'prefix')) HAVING count(*)>1)
    OR EXISTS(SELECT 1 FROM jsonb_array_elements(cfg->'categories') WITH ORDINALITY a(c,i)
      JOIN jsonb_array_elements(cfg->'categories') WITH ORDINALITY b(c,j) ON a.i < b.j
      WHERE a.c ? 'startRange' AND a.c ? 'endRange' AND b.c ? 'startRange' AND b.c ? 'endRange'
        AND (a.c->>'startRange')::numeric <= (b.c->>'endRange')::numeric
        AND (a.c->>'endRange')::numeric >= (b.c->>'startRange')::numeric)
 THEN RAISE EXCEPTION 'INVENTORY_CATEGORY_INVALID' USING ERRCODE='23514'; END IF;  -- QA-20261109 R8 CFG-02: validate category names, prefixes, and non-overlapping numeric ranges when configured.  IF jsonb_array_length(cfg->'categories')=0 OR jsonb_array_length(cfg->'categories')>6     OR EXISTS(SELECT 1 FROM jsonb_array_elements(cfg->'categories') c       WHERE jsonb_typeof(c) IS DISTINCT FROM 'object' OR nullif(btrim(c->>'name'),'') IS NULL         OR (c ? 'prefix' AND (jsonb_typeof(c->'prefix') IS DISTINCT FROM 'string' OR btrim(c->>'prefix') !~ '^[A-Za-z0-9]{2,12}$'))         OR ((c ? 'startRange' OR c ? 'endRange') AND (             jsonb_typeof(c->'startRange') IS DISTINCT FROM 'number' OR jsonb_typeof(c->'endRange') IS DISTINCT FROM 'number'             OR (c->>'startRange')::numeric <> trunc((c->>'startRange')::numeric)             OR (c->>'endRange')::numeric <> trunc((c->>'endRange')::numeric)             OR (c->>'startRange')::numeric < 0 OR (c->>'startRange')::numeric > (c->>'endRange')::numeric)))     OR EXISTS(SELECT 1 FROM jsonb_array_elements(cfg->'categories') c GROUP BY lower(btrim(c->>'name')) HAVING count(*)>1)     OR EXISTS(SELECT 1 FROM jsonb_array_elements(cfg->'categories') c WHERE nullif(btrim(c->>'prefix'),'') IS NOT NULL GROUP BY lower(btrim(c->>'prefix')) HAVING count(*)>1)     OR EXISTS(SELECT 1 FROM jsonb_array_elements(cfg->'categories') WITH ORDINALITY a(c,i)       JOIN jsonb_array_elements(cfg->'categories') WITH ORDINALITY b(c,j) ON a.i < b.j       WHERE a.c ? 'startRange' AND a.c ? 'endRange' AND b.c ? 'startRange' AND b.c ? 'endRange'         AND (a.c->>'startRange')::numeric <= (b.c->>'endRange')::numeric         AND (a.c->>'endRange')::numeric >= (b.c->>'startRange')::numeric)  THEN RAISE EXCEPTION 'INVENTORY_CATEGORY_INVALID' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT 1 FROM public.materials m WHERE nullif(btrim(m.data->>'code'),'') IS NULL
     OR nullif(btrim(m.data->>'name'),'') IS NULL OR nullif(btrim(m.data->>'category'),'') IS NULL
     OR nullif(btrim(m.data->>'unit'),'') IS NULL OR m.data->>'id' IS DISTINCT FROM m.id
     OR jsonb_typeof(m.data->'minimumStock') IS DISTINCT FROM 'number' OR (m.data->>'minimumStock')::numeric<0
     OR (m.data ? 'initialStock' AND (jsonb_typeof(m.data->'initialStock') IS DISTINCT FROM 'number' OR (m.data->>'initialStock')::numeric<0))
     OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(cfg->'storehouseEntities') w WHERE w->>'id'=m.data->>'primaryStorehouseId')
     OR NOT (cfg->'units' @> jsonb_build_array(m.data->>'unit'))
       OR (m.data ? 'archived' AND jsonb_typeof(m.data->'archived') IS DISTINCT FROM 'boolean')
     OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(cfg->'categories') c WHERE c->>'name'=m.data->>'category'
        AND (NOT (c ? 'prefix' AND c ? 'startRange' AND c ? 'endRange') OR (
          upper(split_part(btrim(m.data->>'code'),'-',1))=upper(btrim(c->>'prefix'))
          AND split_part(btrim(m.data->>'code'),'-',2) ~ '^[0-9]+$'
          AND split_part(btrim(m.data->>'code'),'-',3)=''
          AND (split_part(btrim(m.data->>'code'),'-',2))::numeric BETWEEN (c->>'startRange')::numeric AND (c->>'endRange')::numeric))))
 THEN RAISE EXCEPTION 'INVENTORY_MATERIAL_INVALID' USING ERRCODE='23514'; END IF;
 FOR row_data IN SELECT data FROM public.transactions LOOP
   v_date:=row_data->>'date';
   IF v_date IS NULL OR v_date !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' OR to_char(v_date::date,'YYYY-MM-DD')<>v_date
   THEN RAISE EXCEPTION 'INVENTORY_DATE_INVALID' USING ERRCODE='23514'; END IF;
 END LOOP;
 IF EXISTS(SELECT 1 FROM public.transactions t WHERE t.data->>'id' IS DISTINCT FROM t.id
     OR nullif(btrim(t.data->>'transactionNumber'),'') IS NULL
     OR jsonb_typeof(t.data->'quantity') IS DISTINCT FROM 'number' OR (t.data->>'quantity')::numeric<=0
     OR coalesce(t.data->>'transactionType','') NOT IN ('وارد','صادر','مستهلك','افتتاحي','تسوية','تحويل')
     OR (t.data->>'transactionType' IN ('تسوية','تحويل') AND coalesce(t.data->>'transferType','') NOT IN ('in','out'))
     OR NOT EXISTS(SELECT 1 FROM public.materials m WHERE m.id=t.data->>'itemId')
     OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(cfg->'storehouseEntities') w WHERE w->>'id'=t.data->>'storehouseId'))
 THEN RAISE EXCEPTION 'INVENTORY_TRANSACTION_INVALID' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT 1 FROM public.transactions t WHERE t.data->>'transactionType'='تحويل' AND
    (nullif(t.data->>'operationId','') IS NULL OR NOT EXISTS(
      SELECT 1 FROM public.transactions p WHERE p.id=t.data->>'pairedTransactionId'
      AND p.data->>'pairedTransactionId'=t.id AND p.data->>'operationId'=t.data->>'operationId'
      AND p.data->>'transactionType'='تحويل' AND p.data->>'itemId'=t.data->>'itemId'
      AND p.data->>'date'=t.data->>'date' AND p.data->'quantity'=t.data->'quantity'
      AND p.data->>'storehouseId'<>t.data->>'storehouseId' AND p.data->>'transferType'<>t.data->>'transferType')))
    OR EXISTS(SELECT 1 FROM public.transactions t WHERE t.data->>'transactionType'='تحويل' GROUP BY t.data->>'operationId' HAVING count(*)<>2)
 THEN RAISE EXCEPTION 'INVENTORY_TRANSFER_INVALID' USING ERRCODE='23514'; END IF;
 IF EXISTS(
   WITH effects AS (
     SELECT t.id,t.data->>'itemId' item,t.data->>'storehouseId' warehouse,t.data->>'date' dt,
       coalesce(t.data->>'createdAt','') created,
       (t.data->>'quantity')::numeric * CASE WHEN t.data->>'transactionType' IN ('وارد','افتتاحي')
         OR (t.data->>'transactionType' IN ('تسوية','تحويل') AND t.data->>'transferType'='in') THEN 1 ELSE -1 END delta
     FROM public.transactions t
     UNION ALL
     SELECT '',m.id,m.data->>'primaryStorehouseId','0000-01-01','',coalesce((m.data->>'initialStock')::numeric,0)
     FROM public.materials m WHERE NOT EXISTS(SELECT 1 FROM public.transactions t WHERE t.data->>'itemId'=m.id AND (t.data->>'transactionType'='افتتاحي' OR t.id LIKE 'tr-init%'))
   ), balances AS (SELECT sum(delta) OVER(PARTITION BY item,warehouse ORDER BY dt,created,id ROWS UNBOUNDED PRECEDING) balance FROM effects)
   SELECT 1 FROM balances WHERE balance < -0.000000001
 ) THEN RAISE EXCEPTION 'INVENTORY_NEGATIVE_BALANCE' USING ERRCODE='23514'; END IF;
 FOR row_data IN SELECT data FROM public.generator_logs LOOP
   v_date:=row_data->>'date';
   IF v_date IS NULL OR v_date !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' OR to_char(v_date::date,'YYYY-MM-DD')<>v_date
      OR jsonb_typeof(row_data->'currentReading') IS DISTINCT FROM 'number'
      OR jsonb_typeof(row_data->'previousReading') IS DISTINCT FROM 'number'
      OR jsonb_typeof(row_data->'operatingHours') IS DISTINCT FROM 'number'
      OR (row_data->>'previousReading')::numeric<0 OR (row_data->>'currentReading')::numeric<(row_data->>'previousReading')::numeric
      OR abs((row_data->>'operatingHours')::numeric-((row_data->>'currentReading')::numeric-(row_data->>'previousReading')::numeric))>0.000000001
   THEN RAISE EXCEPTION 'INVENTORY_GENERATOR_INVALID' USING ERRCODE='23514'; END IF;
 END LOOP;
 IF EXISTS(SELECT 1 FROM(SELECT data,lag((data->>'currentReading')::numeric) OVER(ORDER BY data->>'date',id) previous FROM public.generator_logs) g
           WHERE previous IS NOT NULL AND abs(previous-(data->>'previousReading')::numeric)>0.000000001)
 THEN RAISE EXCEPTION 'INVENTORY_GENERATOR_CHAIN_INVALID' USING ERRCODE='23514'; END IF;
END;
$$;

CREATE OR REPLACE FUNCTION inventory_private.commit_inventory(p_mutation_id text,p_payload jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE actor public.users%ROWTYPE; op jsonb; ops jsonb; receipt jsonb; digest text; old jsonb; val jsonb;
 col text; doc text; kind text; needed text; mode text; stamp text; saved public.audit_logs%ROWTYPE;
 affected jsonb:='[]'; results jsonb:='[]'; removed jsonb:='[]'; corr jsonb:='[]'; cfg jsonb; backup jsonb; entry jsonb; old_permissions jsonb;
BEGIN
 IF auth.uid() IS NULL THEN RAISE EXCEPTION 'INVENTORY_AUTH_REQUIRED' USING ERRCODE='42501'; END IF;
 -- One short serializable writer boundary. This also fences permission revocation through users.
 PERFORM pg_advisory_xact_lock(824671520);
 SELECT * INTO actor FROM public.users WHERE auth_uid=auth.uid()::text AND active FOR UPDATE;
 IF actor.id IS NULL THEN RAISE EXCEPTION 'INVENTORY_ACCOUNT_DISABLED' USING ERRCODE='42501'; END IF;
 IF p_mutation_id IS NULL OR p_mutation_id !~ '^[A-Za-z0-9:_-]{8,160}$' OR jsonb_typeof(p_payload) IS DISTINCT FROM 'object'
    OR octet_length(p_payload::text)>4000000 THEN RAISE EXCEPTION 'INVENTORY_ENVELOPE_INVALID' USING ERRCODE='22023'; END IF;
 digest:=encode(sha256(convert_to(p_payload::text,'UTF8')),'hex');
 SELECT * INTO saved FROM public.audit_logs WHERE id=p_mutation_id;
 IF FOUND THEN
   IF saved.data->>'actorUserId'<>actor.id OR saved.data->>'mutationDigest' IS DISTINCT FROM digest
   THEN RAISE EXCEPTION 'INVENTORY_MUTATION_ID_REUSED' USING ERRCODE='23505'; END IF;
   RETURN jsonb_build_object('audit',saved.data,'replayed',true,'results',coalesce(saved.data->'mutationResults','[]'));
 END IF;
 stamp:=to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
 mode:=coalesce(p_payload->>'mode','mutation'); ops:=p_payload->'operations';
 IF mode='restore' THEN
   IF NOT (actor.permissions @> '["users_manage","settings_edit","system_reset"]'::jsonb)
   THEN RAISE EXCEPTION 'INVENTORY_RESTORE_DENIED' USING ERRCODE='42501'; END IF;
   IF p_payload->>'expectedState' IS DISTINCT FROM inventory_private.state_hash()
   THEN RAISE EXCEPTION 'INVENTORY_RESTORE_STALE' USING ERRCODE='40001'; END IF;
   backup:=p_payload->'backup';
   IF jsonb_typeof(backup->'materials') IS DISTINCT FROM 'array' OR jsonb_typeof(backup->'transactions') IS DISTINCT FROM 'array'
      OR jsonb_typeof(backup->'generatorLogs') IS DISTINCT FROM 'array' OR jsonb_typeof(backup->'users') IS DISTINCT FROM 'array' OR jsonb_typeof(backup->'settings') IS DISTINCT FROM 'object'
   THEN RAISE EXCEPTION 'INVENTORY_BACKUP_INVALID' USING ERRCODE='22023'; END IF;
   IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(backup->'users') u WHERE u->>'id'=actor.id
       AND u->>'authUid'=actor.auth_uid AND u->'active'='true'::jsonb AND u->'permissions' @> '["users_manage","settings_edit","system_reset"]'::jsonb)
   THEN RAISE EXCEPTION 'INVENTORY_RESTORE_WOULD_LOCK_ADMIN' USING ERRCODE='23514'; END IF;
   -- Authentication identities and immutable audit history are never restored/deleted.
   DELETE FROM public.transactions; DELETE FROM public.materials; DELETE FROM public.generator_logs;
   DELETE FROM public.users WHERE NOT EXISTS(SELECT 1 FROM jsonb_array_elements(backup->'users') u WHERE u->>'id'=public.users.id);
   ops:='[]';
   FOR col IN SELECT unnest(ARRAY['settings','materials','transactions','generator_logs','users']) LOOP
     FOR val IN SELECT value FROM jsonb_array_elements(CASE col WHEN 'settings' THEN jsonb_build_array((backup->'settings')||'{"id":"app_config"}')
       WHEN 'generator_logs' THEN backup->'generatorLogs' ELSE backup->col END) LOOP
       ops:=ops||jsonb_build_array(jsonb_build_object('collection',col,'docId',val->>'id','kind','set','value',val));
     END LOOP;
   END LOOP;
 ELSE
   -- QA-20261109 TX-03: 'correction' is a distinct mode so that a server WITHOUT correction support
   -- (e.g. SQL rolled back to #8, which accepts only mutation/audit) rejects the whole request atomically
   -- instead of committing it with an incomplete audit receipt.
   IF mode NOT IN ('mutation','audit','correction') OR jsonb_typeof(ops) IS DISTINCT FROM 'array' OR jsonb_array_length(ops)>450 OR jsonb_array_length(ops)=0
   THEN RAISE EXCEPTION 'INVENTORY_OPERATIONS_INVALID' USING ERRCODE='22023'; END IF;
 END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(ops) x GROUP BY x->>'collection',x->>'docId' HAVING count(*)>1)
 THEN RAISE EXCEPTION 'INVENTORY_DUPLICATE_OPERATION' USING ERRCODE='22023'; END IF;
 FOR op IN SELECT value FROM jsonb_array_elements(ops) LOOP
   col:=op->>'collection';doc:=op->>'docId';kind:=op->>'kind';val:=op->'value';old:=NULL;
   IF col NOT IN ('settings','materials','transactions','generator_logs','users','audit_logs') OR nullif(btrim(doc),'') IS NULL OR length(doc)>200 OR kind NOT IN ('set','delete')
   THEN RAISE EXCEPTION 'INVENTORY_OPERATION_INVALID' USING ERRCODE='22023'; END IF;
   IF mode='audit' THEN
     IF col<>'audit_logs' OR kind<>'set' OR jsonb_array_length(ops)<>1 THEN RAISE EXCEPTION 'INVENTORY_AUDIT_MODE_INVALID' USING ERRCODE='22023'; END IF;
     CONTINUE;
   END IF;
   IF col='audit_logs' THEN RAISE EXCEPTION 'INVENTORY_AUDIT_IMMUTABLE' USING ERRCODE='42501'; END IF;
   EXECUTE format('SELECT data FROM public.%I WHERE id=$1 FOR UPDATE',col) INTO old USING doc;
   IF mode<>'restore' AND (NOT op ? 'expected' OR coalesce(op->'expected'->>'kind','') NOT IN ('present','missing') OR (op->'expected'->>'kind'='present' AND NOT op->'expected' ? 'data')) THEN RAISE EXCEPTION 'INVENTORY_BASELINE_REQUIRED' USING ERRCODE='40001'; END IF;
   IF mode<>'restore' AND op ? 'expected' THEN
     IF (op->'expected'->>'kind'='missing' AND old IS NOT NULL)
                OR (op->'expected'->>'kind'='present' AND (old IS NULL OR (op->'expected' ? 'data' AND (
            CASE WHEN col='materials' THEN (op->'expected'->'data')-'currentStock'-'warehouseStocks'-'warehouseStocksById'-'updatedAt'
                 ELSE op->'expected'->'data' END
            IS DISTINCT FROM
            CASE WHEN col='materials' THEN old-'currentStock'-'warehouseStocks'-'warehouseStocksById'-'updatedAt'
                 ELSE old END))))
     THEN RAISE EXCEPTION 'INVENTORY_CONFLICT' USING ERRCODE='40001'; END IF;
   END IF;
   IF kind='set' AND (jsonb_typeof(val) IS DISTINCT FROM 'object' OR val->>'id' IS DISTINCT FROM doc)
   THEN RAISE EXCEPTION 'INVENTORY_DOCUMENT_INVALID' USING ERRCODE='22023'; END IF;
   IF mode<>'restore' THEN
     needed:=CASE col WHEN 'transactions' THEN CASE WHEN kind='delete' THEN 'transactions_delete' ELSE 'transactions_create' END
       WHEN 'generator_logs' THEN 'generator_log' WHEN 'users' THEN 'users_manage'
       WHEN 'settings' THEN 'settings_edit'
       WHEN 'materials' THEN CASE WHEN kind='delete' THEN 'materials_delete' WHEN old IS NULL THEN 'materials_create' ELSE 'materials_edit' END END;
     IF NOT actor.permissions ? needed THEN
       IF col='settings' AND kind='set' AND old IS NOT NULL AND actor.permissions ? 'transactions_create'
          AND val-'transactionCounters'-'updatedAt' = old-'transactionCounters'-'updatedAt'
          AND EXISTS(SELECT 1 FROM jsonb_array_elements(ops) x WHERE x->>'collection'='transactions')
          AND jsonb_typeof(val->'transactionCounters')='object'
          AND NOT EXISTS(SELECT 1 FROM jsonb_object_keys(coalesce(old->'transactionCounters','{}')) k WHERE NOT val->'transactionCounters' ? k)
          AND NOT EXISTS(SELECT 1 FROM jsonb_each(val->'transactionCounters') c
            WHERE c.key NOT IN ('inbound','outbound','consumed','transfer','adjustment','opening')
              OR jsonb_typeof(c.value) IS DISTINCT FROM 'number'
              OR (c.value::text)::numeric <> trunc((c.value::text)::numeric)
              OR (c.value::text)::numeric < coalesce((old->'transactionCounters'->>c.key)::numeric,0)
              OR (c.value::text)::numeric > coalesce((old->'transactionCounters'->>c.key)::numeric,0)
                + (SELECT count(*) FROM jsonb_array_elements(ops) x WHERE x->>'collection'='transactions' AND x->>'kind'='set'
                    AND x->'expected'->>'kind'='missing' AND x->'value'->>'transactionType'=CASE c.key WHEN 'inbound' THEN 'وارد' WHEN 'outbound' THEN 'صادر' WHEN 'consumed' THEN 'مستهلك' WHEN 'transfer' THEN 'تحويل' WHEN 'adjustment' THEN 'تسوية' ELSE 'افتتاحي' END)
                + (SELECT count(*) FROM public.transactions t WHERE t.data->>'transactionType'=CASE c.key WHEN 'inbound' THEN 'وارد' WHEN 'outbound' THEN 'صادر' WHEN 'consumed' THEN 'مستهلك' WHEN 'transfer' THEN 'تحويل' WHEN 'adjustment' THEN 'تسوية' ELSE 'افتتاحي' END
                    AND split_part(t.data->>'transactionNumber','-',2) ~ '^[0-9]+$'
                    AND (split_part(t.data->>'transactionNumber','-',2))::numeric > coalesce((old->'transactionCounters'->>c.key)::numeric,0))) THEN NULL;
       ELSIF col='materials' AND kind='set' AND old IS NOT NULL AND actor.permissions ? 'transactions_delete'
          AND val-'initialStock'-'updatedAt' = old-'initialStock'-'updatedAt'
          AND val->'initialStock'='0'::jsonb AND EXISTS(SELECT 1 FROM jsonb_array_elements(ops) x WHERE x->>'collection'='transactions' AND x->>'kind'='delete' AND x->'expected'->'data'->>'itemId'=doc AND (x->'expected'->'data'->>'transactionType'='افتتاحي' OR x->>'docId' LIKE 'tr-init%')) THEN NULL;
       ELSE RAISE EXCEPTION 'INVENTORY_PERMISSION_DENIED:%',needed USING ERRCODE='42501'; END IF;
     END IF;
     IF col='settings' AND (doc<>'app_config' OR kind='delete') THEN RAISE EXCEPTION 'INVENTORY_SETTINGS_DELETE_DENIED' USING ERRCODE='42501'; END IF;
     IF col='transactions' AND kind='set' AND old IS NOT NULL AND
        (SELECT jsonb_agg(old->k ORDER BY k) FROM unnest(ARRAY['itemId','transactionType','transferType','quantity','date','storehouseId','transactionNumber','operationId','pairedTransactionId']) k)
        IS DISTINCT FROM (SELECT jsonb_agg(val->k ORDER BY k) FROM unnest(ARRAY['itemId','transactionType','transferType','quantity','date','storehouseId','transactionNumber','operationId','pairedTransactionId']) k)
     THEN RAISE EXCEPTION 'INVENTORY_LEDGER_IDENTITY_IMMUTABLE' USING ERRCODE='23514'; END IF;
     IF col IN ('materials','transactions') AND kind='set' AND (old IS NULL OR (col='materials' AND val->>'primaryStorehouseId' IS DISTINCT FROM old->>'primaryStorehouseId')) THEN
       SELECT data INTO cfg FROM public.settings WHERE id='app_config';
       IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(cfg->'storehouseEntities') w WHERE w->>'id'=CASE col WHEN 'materials' THEN val->>'primaryStorehouseId' ELSE val->>'storehouseId' END AND w->'active'='true'::jsonb)
       THEN RAISE EXCEPTION 'INVENTORY_WAREHOUSE_INACTIVE' USING ERRCODE='23514'; END IF;
     END IF;
     IF col='materials' AND kind='set' AND old IS NOT NULL AND (val->'initialStock' IS DISTINCT FROM old->'initialStock' OR (val->>'primaryStorehouseId' IS DISTINCT FROM old->>'primaryStorehouseId' AND coalesce((old->>'initialStock')::numeric,0)<>0))
        AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(ops) x WHERE x->>'collection'='transactions' AND (x->'value'->>'itemId'=doc OR x->'expected'->'data'->>'itemId'=doc))
     THEN RAISE EXCEPTION 'INVENTORY_OPENING_LEDGER_REQUIRED' USING ERRCODE='23514'; END IF;
   END IF;
   IF col='users' THEN
     IF kind='set' AND (val->>'authUid' IS DISTINCT FROM doc
         OR nullif(btrim(val->>'fullName'),'') IS NULL OR nullif(btrim(val->>'role'),'') IS NULL
         OR jsonb_typeof(val->'active') IS DISTINCT FROM 'boolean'
         OR jsonb_typeof(val->'permissions') IS DISTINCT FROM 'array'
         OR EXISTS(SELECT 1 FROM jsonb_array_elements(val->'permissions') p WHERE jsonb_typeof(p) IS DISTINCT FROM 'string'))
     THEN RAISE EXCEPTION 'INVENTORY_PROFILE_INVALID' USING ERRCODE='23514'; END IF;
     IF val ?| ARRAY['password','passwordHash','access_token','refresh_token','service_role'] THEN RAISE EXCEPTION 'INVENTORY_PROFILE_SECRET_REJECTED' USING ERRCODE='22023'; END IF;
     IF kind='delete' THEN RAISE EXCEPTION 'INVENTORY_USER_DELETE_DENIED' USING ERRCODE='42501'; END IF;
     IF NOT EXISTS(SELECT 1 FROM auth.users a WHERE a.id::text=coalesce(val->>'authUid',doc) AND lower(a.email)=lower(val->>'username'))
     THEN RAISE EXCEPTION 'INVENTORY_AUTH_IDENTITY_MISSING' USING ERRCODE='23514'; END IF;
     INSERT INTO public.users(id,auth_uid,username,full_name,role,permissions,active,created_at,data,updated_at)
     VALUES(doc,coalesce(val->>'authUid',doc),val->>'username',val->>'fullName',val->>'role',val->'permissions',coalesce((val->>'active')::boolean,true),coalesce(val->>'createdAt',stamp),val,now())
     ON CONFLICT(id) DO UPDATE SET auth_uid=excluded.auth_uid,username=excluded.username,full_name=excluded.full_name,role=excluded.role,permissions=excluded.permissions,active=excluded.active,data=excluded.data,updated_at=now();
   ELSIF kind='delete' THEN
     IF old IS NULL THEN RAISE EXCEPTION 'INVENTORY_DELETE_MISSING' USING ERRCODE='40001'; END IF;
     EXECUTE format('DELETE FROM public.%I WHERE id=$1',col) USING doc;
   ELSE
     EXECUTE format('INSERT INTO public.%I(id,data,updated_at) VALUES($1,$2,now()) ON CONFLICT(id) DO UPDATE SET data=excluded.data,updated_at=now()',col) USING doc,val;
   END IF;
   affected:=affected||jsonb_build_array(col||'/'||doc);
   -- QA-20261108 TX-03 (isolated only): keep the ORIGINAL values of a cancelled ledger entry in the receipt and link a correction to it.
   IF mode<>'restore' AND col='transactions' AND kind='delete' AND old IS NOT NULL THEN
     removed:=removed||jsonb_build_array(jsonb_build_object('id',doc,'transactionNumber',old->>'transactionNumber','transactionType',old->>'transactionType',
       'quantity',old->'quantity','date',old->>'date','itemId',old->>'itemId','itemCode',old->>'itemCode','storehouseId',old->>'storehouseId','unit',old->>'unit'));
   END IF;
   -- QA-20261109 TX-03: a NEW replacement row carrying correctionOf is only accepted in correction mode.
   IF col='transactions' AND kind='set' AND old IS NULL AND mode='mutation' AND jsonb_typeof(val->'correctionOf')='object'
   THEN RAISE EXCEPTION 'INVENTORY_CORRECTION_MODE_REQUIRED' USING ERRCODE='22023'; END IF;
   IF mode='correction' AND col='transactions' AND kind='set' AND old IS NULL AND jsonb_typeof(val->'correctionOf')='object' THEN
     corr:=corr||jsonb_build_array(jsonb_build_object('originalId',val->'correctionOf'->>'id','originalNumber',val->'correctionOf'->>'transactionNumber',
       'originalQuantity',val->'correctionOf'->'quantity','replacementId',doc,'replacementNumber',val->>'transactionNumber','replacementQuantity',val->'quantity',
       'reason',left(coalesce(val->'correctionOf'->>'reason',''),500)));
   END IF;
 END LOOP;
 IF mode='correction' AND jsonb_array_length(corr)=0 THEN RAISE EXCEPTION 'INVENTORY_CORRECTION_LINK_INVALID' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(corr) c WHERE NOT EXISTS(SELECT 1 FROM jsonb_array_elements(removed) r
     WHERE r->>'id'=c->>'originalId' AND r->>'transactionNumber' IS NOT DISTINCT FROM c->>'originalNumber'
       AND (r->>'quantity')::numeric IS NOT DISTINCT FROM (c->>'originalQuantity')::numeric))
 THEN RAISE EXCEPTION 'INVENTORY_CORRECTION_LINK_INVALID' USING ERRCODE='23514'; END IF;
 IF mode<>'audit' THEN
           PERFORM inventory_private.validate_inventory();
   SELECT data INTO cfg FROM public.settings WHERE id='app_config';
   UPDATE public.materials m
   SET data = jsonb_set(
         jsonb_set(m.data, '{currentStock}', to_jsonb(coalesce(calc.total_stock, 0)), true),
         '{warehouseStocks}', coalesce(calc.wh_stocks, '{}'::jsonb), true
       ),
       updated_at = now()
   FROM (
     SELECT m2.id AS mat_id,
       coalesce(sum(wh.bal) FILTER (WHERE wh.active), 0) AS total_stock,
       coalesce(jsonb_object_agg(wh.name, wh.bal) FILTER (WHERE wh.active AND wh.name IS NOT NULL), '{}'::jsonb) AS wh_stocks
     FROM public.materials m2
     LEFT JOIN LATERAL (
       SELECT w->>'id' AS wid, w->>'name' AS name, (w->'active'='true'::jsonb) AS active,
         sum(e.delta) AS bal
       FROM (
         SELECT t.data->>'storehouseId' AS storehouse_id,
           (t.data->>'quantity')::numeric * CASE WHEN t.data->>'transactionType' IN ('وارد','افتتاحي')
             OR (t.data->>'transactionType' IN ('تسوية','تحويل') AND t.data->>'transferType'='in') THEN 1 ELSE -1 END AS delta
         FROM public.transactions t WHERE t.data->>'itemId'=m2.id
         UNION ALL
         SELECT m2.data->>'primaryStorehouseId', coalesce((m2.data->>'initialStock')::numeric, 0)
         WHERE coalesce((m2.data->>'initialStock')::numeric, 0) > 0
           AND NOT EXISTS(SELECT 1 FROM public.transactions t0 WHERE t0.data->>'itemId'=m2.id AND (t0.data->>'transactionType'='افتتاحي' OR t0.id LIKE 'tr-init%'))
       ) e
       JOIN jsonb_array_elements(cfg->'storehouseEntities') w ON w->>'id'=e.storehouse_id
       GROUP BY w->>'id', w->>'name', (w->'active'='true'::jsonb)
     ) wh ON true
     GROUP BY m2.id
   ) calc
   WHERE m.id = calc.mat_id
     AND (m.data->'currentStock' IS DISTINCT FROM to_jsonb(coalesce(calc.total_stock, 0))
          OR m.data->'warehouseStocks' IS DISTINCT FROM coalesce(calc.wh_stocks, '{}'::jsonb));
   SELECT data INTO cfg FROM public.settings WHERE id='app_config';
   UPDATE public.materials m
   SET data = jsonb_set(
         jsonb_set(m.data, '{currentStock}', to_jsonb(coalesce(calc.total_stock, 0)), true),
         '{warehouseStocks}', coalesce(calc.wh_stocks, '{}'::jsonb), true
       ),
       updated_at = now()
   FROM (
     SELECT m2.id AS mat_id,
       coalesce(sum(wh.bal) FILTER (WHERE wh.active), 0) AS total_stock,
       coalesce(jsonb_object_agg(wh.name, wh.bal) FILTER (WHERE wh.active AND wh.name IS NOT NULL), '{}'::jsonb) AS wh_stocks
     FROM public.materials m2
     LEFT JOIN LATERAL (
       SELECT w->>'id' AS wid, w->>'name' AS name, (w->'active'='true'::jsonb) AS active,
         sum(e.delta) AS bal
       FROM (
         SELECT t.data->>'storehouseId' AS storehouse_id,
           (t.data->>'quantity')::numeric * CASE WHEN t.data->>'transactionType' IN ('وارد','افتتاحي')
             OR (t.data->>'transactionType' IN ('تسوية','تحويل') AND t.data->>'transferType'='in') THEN 1 ELSE -1 END AS delta
         FROM public.transactions t WHERE t.data->>'itemId'=m2.id
         UNION ALL
         SELECT m2.data->>'primaryStorehouseId', coalesce((m2.data->>'initialStock')::numeric, 0)
         WHERE coalesce((m2.data->>'initialStock')::numeric, 0) > 0
           AND NOT EXISTS(SELECT 1 FROM public.transactions t0 WHERE t0.data->>'itemId'=m2.id AND (t0.data->>'transactionType'='افتتاحي' OR t0.id LIKE 'tr-init%'))
       ) e
       JOIN jsonb_array_elements(cfg->'storehouseEntities') w ON w->>'id'=e.storehouse_id
       GROUP BY w->>'id', w->>'name', (w->'active'='true'::jsonb)
     ) wh ON true
     GROUP BY m2.id
   ) calc
   WHERE m.id = calc.mat_id
     AND (m.data->'currentStock' IS DISTINCT FROM to_jsonb(coalesce(calc.total_stock, 0))
          OR m.data->'warehouseStocks' IS DISTINCT FROM coalesce(calc.wh_stocks, '{}'::jsonb));
   SELECT data INTO cfg FROM public.settings WHERE id='app_config';
   UPDATE public.materials m
   SET data = jsonb_set(
         jsonb_set(m.data, '{currentStock}', to_jsonb(coalesce(calc.total_stock, 0)), true),
         '{warehouseStocks}', coalesce(calc.wh_stocks, '{}'::jsonb), true
       ),
       updated_at = now()
   FROM (
     SELECT m2.id AS mat_id,
       coalesce(sum(wh.bal) FILTER (WHERE wh.active), 0) AS total_stock,
       coalesce(jsonb_object_agg(wh.name, wh.bal) FILTER (WHERE wh.active AND wh.name IS NOT NULL), '{}'::jsonb) AS wh_stocks
     FROM public.materials m2
     LEFT JOIN LATERAL (
       SELECT w->>'id' AS wid, w->>'name' AS name, (w->'active'='true'::jsonb) AS active,
         sum(e.delta) AS bal
       FROM (
         SELECT t.data->>'storehouseId' AS storehouse_id,
           (t.data->>'quantity')::numeric * CASE WHEN t.data->>'transactionType' IN ('وارد','افتتاحي')
             OR (t.data->>'transactionType' IN ('تسوية','تحويل') AND t.data->>'transferType'='in') THEN 1 ELSE -1 END AS delta
         FROM public.transactions t WHERE t.data->>'itemId'=m2.id
         UNION ALL
         SELECT m2.data->>'primaryStorehouseId', coalesce((m2.data->>'initialStock')::numeric, 0)
         WHERE coalesce((m2.data->>'initialStock')::numeric, 0) > 0
           AND NOT EXISTS(SELECT 1 FROM public.transactions t0 WHERE t0.data->>'itemId'=m2.id AND (t0.data->>'transactionType'='افتتاحي' OR t0.id LIKE 'tr-init%'))
       ) e
       JOIN jsonb_array_elements(cfg->'storehouseEntities') w ON w->>'id'=e.storehouse_id
       GROUP BY w->>'id', w->>'name', (w->'active'='true'::jsonb)
     ) wh ON true
     GROUP BY m2.id
   ) calc
   WHERE m.id = calc.mat_id
     AND (m.data->'currentStock' IS DISTINCT FROM to_jsonb(coalesce(calc.total_stock, 0))
          OR m.data->'warehouseStocks' IS DISTINCT FROM coalesce(calc.wh_stocks, '{}'::jsonb));
   SELECT data INTO cfg FROM public.settings WHERE id='app_config';
   UPDATE public.materials m
   SET data = jsonb_set(
         jsonb_set(m.data, '{currentStock}', to_jsonb(coalesce(calc.total_stock, 0)), true),
         '{warehouseStocks}', coalesce(calc.wh_stocks, '{}'::jsonb), true
       ),
       updated_at = now()
   FROM (
     SELECT m2.id AS mat_id,
       coalesce(sum(wh.bal) FILTER (WHERE wh.active), 0) AS total_stock,
       coalesce(jsonb_object_agg(wh.name, wh.bal) FILTER (WHERE wh.active AND wh.name IS NOT NULL), '{}'::jsonb) AS wh_stocks
     FROM public.materials m2
     LEFT JOIN LATERAL (
       SELECT w->>'id' AS wid, w->>'name' AS name, (w->'active'='true'::jsonb) AS active,
         sum(e.delta) AS bal
       FROM (
         SELECT t.data->>'storehouseId' AS storehouse_id,
           (t.data->>'quantity')::numeric * CASE WHEN t.data->>'transactionType' IN ('وارد','افتتاحي')
             OR (t.data->>'transactionType' IN ('تسوية','تحويل') AND t.data->>'transferType'='in') THEN 1 ELSE -1 END AS delta
         FROM public.transactions t WHERE t.data->>'itemId'=m2.id
         UNION ALL
         SELECT m2.data->>'primaryStorehouseId', coalesce((m2.data->>'initialStock')::numeric, 0)
         WHERE coalesce((m2.data->>'initialStock')::numeric, 0) > 0
           AND NOT EXISTS(SELECT 1 FROM public.transactions t0 WHERE t0.data->>'itemId'=m2.id AND (t0.data->>'transactionType'='افتتاحي' OR t0.id LIKE 'tr-init%'))
       ) e
       JOIN jsonb_array_elements(cfg->'storehouseEntities') w ON w->>'id'=e.storehouse_id
       GROUP BY w->>'id', w->>'name', (w->'active'='true'::jsonb)
     ) wh ON true
     GROUP BY m2.id
   ) calc
   WHERE m.id = calc.mat_id
     AND (m.data->'currentStock' IS DISTINCT FROM to_jsonb(coalesce(calc.total_stock, 0))
          OR m.data->'warehouseStocks' IS DISTINCT FROM coalesce(calc.wh_stocks, '{}'::jsonb));
   IF NOT EXISTS(SELECT 1 FROM public.users WHERE active AND permissions @> '["users_manage","settings_edit","system_reset"]'::jsonb)
   THEN RAISE EXCEPTION 'INVENTORY_LAST_ADMIN_REQUIRED' USING ERRCODE='23514'; END IF;
 END IF;
 receipt:=jsonb_build_object('id',p_mutation_id,'timestamp',stamp,'user',actor.full_name,'actorUserId',actor.id,'actorDisplayName',actor.full_name,
   'action',CASE WHEN mode='restore' THEN 'استعادة بيانات التطبيق' WHEN mode='audit' THEN left(ops->0->'value'->>'action',200) WHEN jsonb_array_length(corr)>0 THEN 'تصحيح حركة مخزنية (إلغاء وبديل)' ELSE 'اعتماد عملية مخزنية' END,
   'details',CASE mode WHEN 'audit' THEN left(ops->0->'value'->>'details',8000) ELSE 'تم اعتماد العملية وجميع سجلاتها معًا.' END,
   'itemType',CASE mode WHEN 'audit' THEN coalesce(ops->0->'value'->>'itemType','عام') WHEN 'restore' THEN 'إعدادات' ELSE 'حركة' END,
   'operationType',CASE WHEN mode='restore' THEN 'backup' ELSE 'system' END,'affectedEntities',affected,
   'result',CASE WHEN mode='audit' THEN 'reported' ELSE 'committed' END,'mutationDigest',digest,'mutationLabel',left(p_payload->>'label',160))
   ||CASE WHEN jsonb_array_length(removed)>0 THEN jsonb_build_object('removedTransactions',removed) ELSE '{}'::jsonb END
   ||CASE WHEN jsonb_array_length(corr)>0 THEN jsonb_build_object('corrections',corr) ELSE '{}'::jsonb END;
 INSERT INTO public.audit_logs(id,data,updated_at) VALUES(p_mutation_id,receipt,now());
 RETURN jsonb_build_object('audit',receipt,'replayed',false,'results',results);
END;
$$;

CREATE OR REPLACE FUNCTION public.inventory_commit(p_mutation_id text,p_payload jsonb) RETURNS jsonb
LANGUAGE sql SECURITY INVOKER SET search_path = '' AS $$ SELECT inventory_private.commit_inventory(p_mutation_id,p_payload); $$;

CREATE OR REPLACE FUNCTION inventory_private.restore_preview(p_backup jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE actor public.users%ROWTYPE; diffs jsonb:='{}'; col text; key text; old_count int; new_count int; added int; removed int; changed int;
BEGIN
 SELECT * INTO actor FROM public.users WHERE auth_uid=auth.uid()::text AND active;
 IF actor.id IS NULL OR NOT actor.permissions @> '["users_manage","settings_edit","system_reset"]'::jsonb
 THEN RAISE EXCEPTION 'INVENTORY_RESTORE_DENIED' USING ERRCODE='42501'; END IF;
 IF octet_length(p_backup::text)>4000000 OR jsonb_typeof(p_backup->'settings') IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'INVENTORY_BACKUP_INVALID' USING ERRCODE='22023'; END IF;
 PERFORM pg_advisory_xact_lock(824671520);
 FOR col IN SELECT unnest(ARRAY['materials','transactions','generator_logs','users']) LOOP
   key:=CASE WHEN col='generator_logs' THEN 'generatorLogs' ELSE col END;
   IF jsonb_typeof(p_backup->key) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'INVENTORY_BACKUP_INVALID' USING ERRCODE='22023'; END IF;
   EXECUTE format('SELECT count(*),count(*) FILTER(WHERE NOT EXISTS(SELECT 1 FROM jsonb_array_elements($1) b WHERE b->>''id''=t.id)),count(*) FILTER(WHERE EXISTS(SELECT 1 FROM jsonb_array_elements($1) b WHERE b->>''id''=t.id AND b IS DISTINCT FROM t.data)) FROM public.%I t',col)
     INTO old_count,removed,changed USING p_backup->key;
   EXECUTE format('SELECT count(*) FROM jsonb_array_elements($1) b WHERE NOT EXISTS(SELECT 1 FROM public.%I t WHERE t.id=b->>''id'')',col) INTO added USING p_backup->key;
   diffs:=diffs||jsonb_build_object(col,jsonb_build_object('current',old_count,'backup',jsonb_array_length(p_backup->key),'added',added,'removed',removed,'changed',changed));
 END LOOP;
 diffs:=diffs||jsonb_build_object('settings',jsonb_build_object('current',(SELECT count(*) FROM public.settings WHERE id='app_config'),'backup',1,'added',0,'removed',0,'changed',CASE WHEN (SELECT data-'id' FROM public.settings WHERE id='app_config') IS DISTINCT FROM ((p_backup->'settings')-'id') THEN 1 ELSE 0 END));
 RETURN jsonb_build_object('expectedState',inventory_private.state_hash(),'diffs',diffs,'auditHistory','preserved','authIdentities','preserved');
END;
$$;
CREATE OR REPLACE FUNCTION public.inventory_restore_preview(p_backup jsonb) RETURNS jsonb
LANGUAGE sql SECURITY INVOKER SET search_path = '' AS $$ SELECT inventory_private.restore_preview(p_backup); $$;

REVOKE ALL ON FUNCTION inventory_private.state_hash(),inventory_private.validate_inventory(),inventory_private.commit_inventory(text,jsonb),inventory_private.restore_preview(jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION inventory_private.commit_inventory(text,jsonb),inventory_private.restore_preview(jsonb) TO authenticated;
REVOKE ALL ON FUNCTION public.inventory_commit(text,jsonb),public.inventory_restore_preview(jsonb) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.inventory_commit(text,jsonb),public.inventory_restore_preview(jsonb) TO authenticated;
REVOKE INSERT,UPDATE,DELETE,TRUNCATE ON public.materials,public.transactions,public.generator_logs,public.settings,public.audit_logs,public.users FROM authenticated;
REVOKE TRUNCATE ON public.users FROM authenticated;
REVOKE ALL ON public.materials,public.transactions,public.generator_logs,public.settings,public.audit_logs,public.users FROM anon,PUBLIC;
-- Existing read RLS remains in force. Service role and Auth provisioning are unchanged.
