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
create table dist.seed_stage (id integer primary key, geom public.geography(Point,4326) not null);
-- Enable RLS on staging so the renamed-in live table keeps schema.sql's
-- defense-in-depth posture after the swap (the table owner bypasses RLS, so the
-- load below is unaffected).
alter table dist.seed_stage enable row level security;
insert into dist.seed_stage(id, geom)
  select id, public.st_setsrid(public.st_makepoint(lng, lat), 4326)::public.geography
  from dist.seed_raw;
drop table dist.seed_raw;
create index seed_stage_geom_gix on dist.seed_stage using gist (geom);

-- 2. Stage matrix: unindexed COPY (a blank seconds field becomes NULL =
--    unreachable, retained per KTD5), then build the access-path PK + cluster.
create table dist.matrix_stage (
  origin_seed_id integer not null, dest_seed_id integer not null, seconds integer
);
alter table dist.matrix_stage enable row level security;  -- preserved through the swap
\copy dist.matrix_stage(origin_seed_id,dest_seed_id,seconds) from 'matrix.csv' with (format csv)
set maintenance_work_mem = '1GB';  -- keep the PK build + CLUSTER in memory at tens of millions of rows
alter table dist.matrix_stage add primary key (origin_seed_id, dest_seed_id);
cluster dist.matrix_stage using matrix_stage_pkey;
analyze dist.seed_stage;
analyze dist.matrix_stage;

-- 3. Validation gate (R18). Any failed ASSERT aborts the script (ON_ERROR_STOP)
--    BEFORE the swap, so the live snapshot keeps serving.
do $$
declare
  n         bigint := (select count(*) from dist.seed_stage);
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

  -- Cardinality: full N x N, nulls retained (KTD5).
  bad_card := (select count(*) from dist.matrix_stage) - (n * n);
  assert bad_card = 0, format('row count off by %s vs N^2 (N=%s)', bad_card, n);

  -- Value sanity: no negatives; nothing implausibly large for the country.
  select count(*) into bad_val from dist.matrix_stage
   where seconds is not null and (seconds < 0 or seconds > 36000);  -- 10 h cap
   -- (CZ extremes + remote-seed access detours legitimately reach ~8 h; >10 h would signal a unit/placement bug)
  assert bad_val = 0, format('%s seconds values out of range [0, 25200]', bad_val);

  raise notice 'U4 validation gate passed (N=% seeds)', n;
end
$$;

-- 4+5. Record the new snapshot AND publish in ONE transaction (KTD7): the
--      version INSERT, all renames, and the active flip commit together, so a
--      failed swap leaves no orphan version row and a concurrent RPC reads only
--      the whole-old or whole-new snapshot.
begin;
  -- New snapshot row (active=false), capturing its id and the outgoing active id.
  insert into dist.matrix_version
    (extract_date, profile_version, seed_spacing_km, seed_set_hash,
     expected_row_count, actual_row_count, previous_version_id, active)
  select
    :'extract_date'::date,
    :'profile_version',
    :'seed_spacing_km'::numeric,
    :'seed_set_hash',
    (select count(*) from dist.seed_stage)::bigint * (select count(*) from dist.seed_stage)::bigint,
    (select count(*) from dist.matrix_stage),
    (select id from dist.matrix_version where active),
    false
  returning id as new_version_id \gset

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
