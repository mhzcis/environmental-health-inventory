# Reproducible inventory repair checks

Run `npm ci`, then `npm run typecheck:app`, `npm run test:deployment`,
`npm run test:atomic`, and `npm run test:repairs`.

The atomic checks use pinned PGlite only in development. `baseline-schema.json`
contains schema, RLS, and grants, without production records or credentials.
The candidate SQL is applied inside an isolated in-memory database. The integration
suite uses the actual application services, adapter, and IndexedDB queue; only the
Supabase network transport is replaced by calls to this database. These checks do
not establish live Auth, REST, Realtime, or two-device browser acceptance.

Set `QA_SQL_OUTPUT` to an absolute JSON output path; the default is
`/tmp/inventory-atomic-security.json`. `QA_PDF_DATA_DIR` optionally saves synthetic
report inputs from the report acceptance suite. Never point these outputs at a
production backup or commit actual user records.
