-- db/checks.sql
-- Assertion queries that verify the data store. Run against the target Postgres
-- after each stage (psql -v ON_ERROR_STOP=1 -f db/checks.sql). Each section
-- aborts on the first failed ASSERT. Sections are additive across U1-U5.

\set ON_ERROR_STOP on

-- Put the PostGIS schema on the path so the bare KNN operator (<->) in U2
-- resolves; all table/function refs below stay explicitly schema-qualified.
set search_path = public, extensions;

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

  -- RLS survived the swap: the renamed-in live tables must still have it on
  -- (defense-in-depth — load.sql enables RLS on the staging tables).
  assert (select bool_and(relrowsecurity) from pg_class c
          join pg_namespace n on n.oid = c.relnamespace
          where n.nspname='dist' and c.relname in ('seed','matrix')),
    'RLS is not enabled on live dist.seed/dist.matrix after the swap';

  raise notice 'U4 load checks passed (active version %, % rows)', active_id, actual;
end
$$;

-- Atomic-swap correctness (structural): confirm load.sql wraps the renames +
-- active flip in a single BEGIN..COMMIT. Atomicity follows from PG transactional
-- DDL; no concurrent-reader harness is needed (this project has no test runner).

-- ===========================================================================
-- U4b — fault injection: prove the load.sql validation predicates actually
-- CATCH bad data (not just that clean data passes). Self-contained temp tables.
-- ===========================================================================
do $$
declare bad bigint;
begin
  create temp table _seed_fi (id integer primary key) on commit drop;
  insert into _seed_fi values (1), (2);
  create temp table _matrix_fi (mode smallint, origin_seed_id int, dest_seed_id int, seconds int) on commit drop;
  insert into _matrix_fi values
    (0, 1, 1, 5),    -- non-zero diagonal (should be 0)
    (0, 1, 2, 100),
    (0, 2, 1, -3),   -- negative duration
    (0, 2, 3, 50);   -- dangling dest id (3 not in _seed_fi)

  select count(*) into bad from (
    select origin_seed_id as id from _matrix_fi union select dest_seed_id from _matrix_fi
  ) ids where not exists (select 1 from _seed_fi s where s.id = ids.id);
  assert bad > 0, 'referential-closure predicate failed to flag a dangling seed id';

  select count(*) into bad from _matrix_fi where origin_seed_id = dest_seed_id and seconds is distinct from 0;
  assert bad > 0, 'zero-diagonal predicate failed to flag a non-zero diagonal';

  select count(*) into bad from _matrix_fi where seconds is not null and (seconds < 0 or seconds > 25200);
  assert bad > 0, 'value-sanity predicate failed to flag a negative duration';

  raise notice 'U4b fault-injection checks passed (gate predicates catch faults)';
end
$$;

-- ===========================================================================
-- U5 — retrieval RPC (run after db/rpc.sql AND a loaded snapshot)
-- ===========================================================================
do $$
declare
  sig text := 'api.cells_around(double precision,double precision,smallint,double precision)';
  doc jsonb;
begin
  -- Privilege: anon may execute, public may not.
  assert has_function_privilege('anon', sig, 'EXECUTE'),
    'anon cannot EXECUTE api.cells_around';
  assert not has_function_privilege('public', sig, 'EXECUTE'),
    'public must not be able to EXECUTE api.cells_around';

  -- Happy path: central Prague, car, 50 km.
  doc := api.cells_around(14.42, 50.08, 0::smallint, 50000);
  assert doc->>'status' = 'ok', format('expected ok, got %s', doc->>'status');
  assert jsonb_array_length(doc->'cells') >= 3, 'happy-path returned too few cells';
  assert (doc->>'snapMeters') is not null, 'snapMeters missing';
  assert (doc#>>'{version,extractDate}') is not null, 'version.extractDate missing';

  -- Out of coverage: Vienna (lat < 48.5) -> typed state, no exception.
  assert api.cells_around(16.37, 48.21, 0::smallint, 50000)->>'status' = 'out_of_coverage',
    'Vienna should be out_of_coverage';

  -- Input hardening: NaN / null coerce to out_of_coverage, not an error.
  assert api.cells_around('NaN'::double precision, 50.0, 0::smallint, 50000)->>'status' = 'out_of_coverage',
    'NaN lng should be out_of_coverage';
  assert api.cells_around('infinity'::double precision, 50.0, 0::smallint, 50000)->>'status' = 'out_of_coverage',
    'Infinity lng should be out_of_coverage';
  assert api.cells_around(null, null, 0::smallint, 50000)->>'status' = 'out_of_coverage',
    'null coords should be out_of_coverage';
  assert api.cells_around(14.42, 50.08, 0::smallint, null)->>'status' = 'radius_too_small',
    'null radius should clamp to 0 -> radius_too_small';

  -- Mode whitelist: a mode absent from the snapshot.
  assert api.cells_around(14.42, 50.08, 9::smallint, 50000)->>'status' = 'mode_unavailable',
    'unknown mode should be mode_unavailable';

  -- Radius too small: 0 m radius yields < MIN_CELLS.
  assert api.cells_around(14.42, 50.08, 0::smallint, 0)->>'status' = 'radius_too_small',
    'zero radius should be radius_too_small';

  -- Radius clamp: an absurd radius must not error and must stay capped.
  assert api.cells_around(14.42, 50.08, 0::smallint, 9e12)->>'status' = 'ok',
    'oversized radius should clamp, not error';
  assert jsonb_array_length(api.cells_around(14.42, 50.08, 0::smallint, 9e12)->'cells') <= 5000,
    'cell cap (5000) not enforced';

  raise notice 'U5 RPC checks passed';
end
$$;
