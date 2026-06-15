-- db/checks.sql
-- Assertion queries that verify the data store. Run against the target Postgres
-- after each stage (psql -v ON_ERROR_STOP=1 -f db/checks.sql). Each section
-- aborts on the first failed ASSERT. Sections are additive across U1-U5.

\set ON_ERROR_STOP on

-- ===========================================================================
-- U1 — schema & PostGIS provisioning
-- ===========================================================================
do $$
begin
  -- PostGIS present.
  assert (select count(*) from pg_extension where extname = 'postgis') = 1,
    'postgis extension is not installed';

  -- Private + api schemas exist.
  assert exists (select 1 from information_schema.schemata where schema_name = 'dist'),
    'schema dist is missing';
  assert exists (select 1 from information_schema.schemata where schema_name = 'api'),
    'schema api is missing';

  -- seed.geom is geography(Point,4326); matrix.seconds is nullable integer.
  assert (select udt_name from information_schema.columns
          where table_schema='dist' and table_name='seed' and column_name='geom') = 'geography',
    'seed.geom is not a geography column';
  assert (select data_type from information_schema.columns
          where table_schema='dist' and table_name='matrix' and column_name='seconds') = 'integer',
    'matrix.seconds is not integer';
  assert (select is_nullable from information_schema.columns
          where table_schema='dist' and table_name='matrix' and column_name='seconds') = 'YES',
    'matrix.seconds must be nullable (null = unreachable)';

  -- GiST index on seed.geom and the matrix access-path PK exist.
  assert exists (select 1 from pg_indexes
                 where schemaname='dist' and tablename='seed' and indexdef ilike '%using gist%'),
    'GiST index on dist.seed.geom is missing';
  assert exists (select 1 from pg_indexes
                 where schemaname='dist' and tablename='matrix' and indexname = 'matrix_pkey'),
    'primary key on dist.matrix is missing';

  -- RLS enabled on every base table (defense-in-depth).
  assert (select bool_and(relrowsecurity) from pg_class c
          join pg_namespace n on n.oid=c.relnamespace
          where n.nspname='dist' and c.relname in ('seed','matrix','matrix_version')),
    'RLS is not enabled on all dist tables';

  -- anon has no direct privilege on the base tables.
  assert not exists (
    select 1 from information_schema.role_table_grants
    where table_schema='dist' and grantee='anon'),
    'anon must not hold any grant on dist tables';

  raise notice 'U1 schema checks passed';
end
$$;

-- NOTE (manual, not SQL-checkable here): confirm PostgREST `db-schemas` lists
-- ONLY `api` (not `dist`/`public`), so a GET /seed or /matrix returns no rows.
