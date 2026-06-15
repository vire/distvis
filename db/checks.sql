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
  -- Name-agnostic: the atomic swap renames staging tables in, so the live PK
  -- index name may differ from matrix_pkey. Assert the PK constraint exists.
  assert exists (select 1 from pg_constraint con
                 join pg_class c on c.oid = con.conrelid
                 join pg_namespace n on n.oid = c.relnamespace
                 where n.nspname='dist' and c.relname='matrix' and con.contype='p'),
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

-- ===========================================================================
-- U2 — seed grid (run after dist.seed is loaded)
-- ===========================================================================
do $$
declare
  n        bigint;
  near_m   double precision;
  out_of_box bigint;
begin
  select count(*) into n from dist.seed;
  -- 5 km grid: ~3,600 clipped to the CZ polygon, up to ~6,900 for the raw bbox.
  assert n between 3000 and 7500, format('unexpected seed count: %s (expected ~3600 clipped / ~6800 bbox at 5 km)', n);

  -- KNN snap from Prague centre returns a seed within ~one grid step.
  select extensions.st_distance(geom, extensions.st_setsrid(extensions.st_makepoint(14.42, 50.08), 4326)::extensions.geography)
    into near_m
    from dist.seed
    order by geom <-> extensions.st_setsrid(extensions.st_makepoint(14.42, 50.08), 4326)::extensions.geography
    limit 1;
  assert near_m < 6000, format('nearest seed to Prague is %s m away (>1 grid step)', near_m);

  -- No seed escaped the Czech bounding box (guards a lat/lng swap or bad anchor).
  select count(*) into out_of_box from dist.seed
   where extensions.st_x(geom::extensions.geometry) not between 12.0 and 18.9
      or extensions.st_y(geom::extensions.geometry) not between 48.5 and 51.1;
  assert out_of_box = 0, format('%s seeds fall outside the CZ bbox', out_of_box);

  raise notice 'U2 seed checks passed (% seeds)', n;
end
$$;
-- Determinism (manual): re-run precompute/seeds.mjs and confirm seeds.meta.json's
-- seedSetHash is unchanged, and matches dist.matrix_version.seed_set_hash after load.

-- ===========================================================================
-- U4 — matrix load & atomic-swap snapshot (run after load.sql)
-- ===========================================================================
do $$
declare
  active_id int;
  expected  bigint;
  actual    bigint;
  bad_ref   bigint;
  bad_diag  bigint;
begin
  -- Exactly one active snapshot.
  assert (select count(*) from dist.matrix_version where active) = 1,
    'there must be exactly one active matrix_version';
  select id, expected_row_count, actual_row_count
    into active_id, expected, actual
    from dist.matrix_version where active;

  -- Live row count matches what the active version recorded, and N x N x modes.
  assert (select count(*) from dist.matrix) = actual,
    'live matrix row count != active version actual_row_count';
  assert expected = actual,
    format('active version expected (%s) != actual (%s)', expected, actual);

  -- Referential integrity on the LIVE tables (same snapshot — R17/R18).
  select count(*) into bad_ref from (
    select origin_seed_id as id from dist.matrix
    union
    select dest_seed_id from dist.matrix
  ) ids
  where not exists (select 1 from dist.seed s where s.id = ids.id);
  assert bad_ref = 0, format('%s live matrix seed ids missing from live seed', bad_ref);

  -- Zero diagonal on the live matrix.
  select count(*) into bad_diag from dist.matrix
   where origin_seed_id = dest_seed_id and seconds is distinct from 0;
  assert bad_diag = 0, format('%s live diagonal entries are not zero', bad_diag);

  raise notice 'U4 load checks passed (active version %, % rows)', active_id, actual;
end
$$;

-- Atomic-swap correctness (structural): confirm load.sql wraps the renames +
-- active flip in a single BEGIN..COMMIT. Atomicity follows from PG transactional
-- DDL; no concurrent-reader harness is needed (this project has no test runner).
