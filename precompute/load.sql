-- precompute/load.sql
-- Load a precomputed snapshot and publish it atomically (U4).
--
-- Run from the precompute/ directory (so \copy finds seeds.csv / matrix.csv):
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
--     -v extract_date=2026-06-14 -v profile_version='osrm-5.x ch' \
--     -v seed_spacing_km=5 -v seed_set_hash="$(jq -r .seedSetHash seeds.meta.json)" \
--     -f load.sql
--
-- Flow: stage (unindexed COPY) -> index/cluster/analyze on staging -> validation
-- gate (ASSERTs; ON_ERROR_STOP aborts the publish, leaving the live snapshot
-- untouched) -> single-transaction rename swap + active flip -> NOTIFY pgrst.
-- The outgoing snapshot is retained as *_prev for rollback until the next load.

\set ON_ERROR_STOP on

-- 0. Clear leftover staging from any failed prior run (NOT *_prev — that is the
--    rollback target, dropped only at the start of the *next* successful load).
drop table if exists dist.seed_raw;
drop table if exists dist.seed_stage;
drop table if exists dist.matrix_stage;

-- 1. Stage seeds: COPY raw lng/lat, then build geography.
create table dist.seed_raw (id integer, lng double precision, lat double precision);
\copy dist.seed_raw(id,lng,lat) from 'seeds.csv' with (format csv, header true)
create table dist.seed_stage (id integer primary key, geom extensions.geography(Point,4326) not null);
insert into dist.seed_stage(id, geom)
  select id, extensions.st_setsrid(extensions.st_makepoint(lng, lat), 4326)::extensions.geography
  from dist.seed_raw;
drop table dist.seed_raw;
create index seed_stage_geom_gix on dist.seed_stage using gist (geom);

-- 2. Stage matrix: unindexed COPY (a blank seconds field becomes NULL =
--    unreachable, retained per KTD5), then build the access-path PK + cluster.
create table dist.matrix_stage (
  mode smallint not null, origin_seed_id integer not null,
  dest_seed_id integer not null, seconds integer
);
\copy dist.matrix_stage(mode,origin_seed_id,dest_seed_id,seconds) from 'matrix.csv' with (format csv)
alter table dist.matrix_stage add primary key (mode, origin_seed_id, dest_seed_id);
cluster dist.matrix_stage using matrix_stage_pkey;
analyze dist.seed_stage;
analyze dist.matrix_stage;

-- 3. Validation gate (R18). Any failed ASSERT aborts the script (ON_ERROR_STOP)
--    BEFORE the swap, so the live snapshot keeps serving.
do $$
declare
  n         bigint := (select count(*) from dist.seed_stage);
  n_modes   int    := (select count(distinct mode) from dist.matrix_stage);
  bad_ref   bigint;
  bad_diag  bigint;
  bad_card  bigint;
  bad_val   bigint;
begin
  assert n > 0, 'seed_stage is empty';

  -- Referential closure (substitute for a DB-level FK — KTD7 / feasibility F2).
  select count(*) into bad_ref from (
    select origin_seed_id as id from dist.matrix_stage
    union
    select dest_seed_id from dist.matrix_stage
  ) ids
  where not exists (select 1 from dist.seed_stage s where s.id = ids.id);
  assert bad_ref = 0, format('%s matrix seed ids not present in seed_stage', bad_ref);

  -- Zero diagonal: every self-pair present must be 0 (never null/nonzero).
  select count(*) into bad_diag from dist.matrix_stage
   where origin_seed_id = dest_seed_id and seconds is distinct from 0;
  assert bad_diag = 0, format('%s diagonal entries are not zero', bad_diag);

  -- Cardinality: full N x N per mode, nulls retained (KTD5).
  bad_card := (select count(*) from dist.matrix_stage) - (n_modes::bigint * n * n);
  assert bad_card = 0, format('row count off by %s vs modes*N^2 (modes=%s N=%s)', bad_card, n_modes, n);

  -- Per-mode coverage: each present mode has exactly N x N rows.
  assert not exists (
    select 1 from dist.matrix_stage group by mode having count(*) <> n * n
  ), 'a mode does not have exactly N*N rows';

  -- Value sanity: no negatives; nothing implausibly large for the country.
  select count(*) into bad_val from dist.matrix_stage
   where seconds is not null and (seconds < 0 or seconds > 25200);  -- 7 h cap
  assert bad_val = 0, format('%s seconds values out of range [0, 25200]', bad_val);

  raise notice 'U4 validation gate passed (N=% seeds, % modes)', n, n_modes;
end
$$;

-- 4. Record the new snapshot (active=false until the swap commits).
insert into dist.matrix_version
  (extract_date, profile_version, seed_spacing_km, seed_set_hash, modes,
   expected_row_count, actual_row_count, previous_version_id, active)
select
  :'extract_date'::date,
  :'profile_version',
  :'seed_spacing_km'::numeric,
  :'seed_set_hash',
  (select array_agg(distinct mode order by mode) from dist.matrix_stage),
  (select count(distinct mode) from dist.matrix_stage) * (select count(*) from dist.seed_stage)::bigint * (select count(*) from dist.seed_stage)::bigint,
  (select count(*) from dist.matrix_stage),
  (select id from dist.matrix_version where active),
  false
returning id as new_version_id \gset

-- 5. Publish: all renames + the active flip in ONE transaction (KTD7) so a
--    concurrent RPC reads only the whole-old or whole-new snapshot.
begin;
  drop table if exists dist.seed_prev;
  drop table if exists dist.matrix_prev;
  alter table if exists dist.seed   rename to seed_prev;
  alter table if exists dist.matrix rename to matrix_prev;
  alter table dist.seed_stage   rename to seed;
  alter table dist.matrix_stage rename to matrix;
  update dist.matrix_version set active = false where active;
  update dist.matrix_version set active = true  where id = :new_version_id;
commit;

-- 6. PostgREST caches the schema by oid; the rename changes oids, so it MUST be
--    told to reload or it serves stale/erroring results (feasibility F3).
notify pgrst, 'reload schema';

\echo 'load.sql: published version' :new_version_id

-- Rollback (manual): mirror the swap —
--   begin;
--     alter table dist.seed   rename to seed_stage;   -- discard the bad load
--     alter table dist.matrix rename to matrix_stage;
--     alter table dist.seed_prev   rename to seed;
--     alter table dist.matrix_prev rename to matrix;
--     update dist.matrix_version set active=false where active;
--     update dist.matrix_version set active=true where id = <previous_version_id>;
--   commit;
--   notify pgrst, 'reload schema';
