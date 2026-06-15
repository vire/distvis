-- db/rpc.sql
-- The single read-only retrieval RPC (U5). Run once after db/schema.sql.
--
-- api.cells_around snaps a clicked lng/lat to the nearest seed, then returns
-- that seed's precomputed car-driving times to destinations within a radius, as
-- ONE jsonb document (not a SETOF — so PostgREST's ?select/?order/?limit/Range
-- surface can't reorder or page it). The document is `status`-tagged so the
-- frontend branches without parsing errors:
--
--   {status:"ok", seed:{lat,lng}, snapMeters,
--    version:{id,extractDate,seedSpacingKm},
--    cells:[{lat,lng,seconds|null}, ...]}                  -- happy path
--   {status:"out_of_coverage", snapMeters?, version}       -- outside CZ / snap too far
--   {status:"radius_too_small", seed, snapMeters, version} -- < MIN_CELLS in radius
--   {status:"unavailable"}                                 -- no active snapshot
--
-- search_path = '' (hijack-safe): every object is schema-qualified, and the two
-- KNN uses go through OPERATOR(extensions.<->) since operators cannot be
-- qualified inline. SECURITY DEFINER so it can read the private `dist` schema;
-- the function must be owned by a role with SELECT on dist (the migration runner
-- owns it by default; for least privilege create a dedicated owner with SELECT
-- on dist.* and ALTER FUNCTION ... OWNER TO it).

create or replace function api.cells_around(
  p_lng      double precision,
  p_lat      double precision,
  p_radius_m double precision
) returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  radius_max constant double precision := 450000;  -- pinned ceiling (KTD5)
  cell_cap   constant integer := 5000;             -- hard row cap (R14)
  min_cells  constant integer := 3;                -- need >=3 points to tessellate
  v_version  jsonb;
  v_spacing  double precision;
  v_radius   double precision;
  v_point    extensions.geography;
  v_seed_id  integer;
  v_seed     extensions.geography;
  v_seed_obj jsonb;
  v_snap_m   double precision;
  v_cells    jsonb;
  v_count    integer;
begin
  -- Active snapshot metadata.
  select jsonb_build_object('id', id, 'extractDate', extract_date, 'seedSpacingKm', seed_spacing_km),
         seed_spacing_km
    into v_version, v_spacing
    from dist.matrix_version
   where active;

  if v_version is null then
    return jsonb_build_object('status', 'unavailable');
  end if;

  -- Input hardening (R15): null / NaN / Infinity / out-of-bbox -> typed state.
  if p_lng is null or p_lat is null
     or p_lng <> p_lng or p_lat <> p_lat                                   -- NaN
     or abs(p_lng) = 'infinity'::double precision
     or abs(p_lat) = 'infinity'::double precision
     or p_lng < 12.0 or p_lng > 18.9 or p_lat < 48.5 or p_lat > 51.1 then  -- CZ bbox
    return jsonb_build_object('status', 'out_of_coverage', 'version', v_version);
  end if;

  -- Radius clamp (R15): coerce null/NaN/negative to 0, cap at the ceiling.
  v_radius := coalesce(p_radius_m, 0);
  if v_radius <> v_radius then v_radius := 0; end if;  -- NaN
  v_radius := least(greatest(v_radius, 0), radius_max);

  v_point := extensions.st_setsrid(extensions.st_makepoint(p_lng, p_lat), 4326)::extensions.geography;

  -- Snap to nearest seed (KNN; OPERATOR(...) form required under empty search_path).
  select id, geom
    into v_seed_id, v_seed
    from dist.seed
   order by geom OPERATOR(extensions.<->) v_point
   limit 1;

  v_snap_m := extensions.st_distance(v_seed, v_point);

  -- Coverage cutoff (R9): a click more than one grid step from any seed is out.
  if v_snap_m > v_spacing * 1000 then
    return jsonb_build_object('status', 'out_of_coverage',
             'snapMeters', round(v_snap_m), 'version', v_version);
  end if;

  v_seed_obj := jsonb_build_object(
    'lat', extensions.st_y(v_seed::extensions.geometry),
    'lng', extensions.st_x(v_seed::extensions.geometry));

  -- Destinations within radius. In-radius unreachable seeds are INCLUDED with
  -- seconds=null; out-of-radius seeds are simply absent (KTD5, R7). Capped to
  -- the nearest cell_cap (R14).
  with c as (
    select d.geom as geom, m.seconds as seconds
      from dist.matrix m
      join dist.seed d on d.id = m.dest_seed_id
     where m.origin_seed_id = v_seed_id
       and extensions.st_dwithin(d.geom, v_seed, v_radius)
     order by v_seed OPERATOR(extensions.<->) d.geom
     limit cell_cap
  )
  select jsonb_agg(jsonb_build_object(
           'lat', extensions.st_y(geom::extensions.geometry),
           'lng', extensions.st_x(geom::extensions.geometry),
           'seconds', seconds)),
         count(*)
    into v_cells, v_count
    from c;

  if coalesce(v_count, 0) < min_cells then
    return jsonb_build_object('status', 'radius_too_small',
             'seed', v_seed_obj, 'snapMeters', round(v_snap_m), 'version', v_version);
  end if;

  return jsonb_build_object(
    'status', 'ok',
    'seed', v_seed_obj,
    'snapMeters', round(v_snap_m),
    'version', v_version,
    'cells', coalesce(v_cells, '[]'::jsonb)
  );
end
$$;

-- Least-privilege execution: only anon, never public.
revoke all     on function api.cells_around(double precision, double precision, double precision) from public;
grant  execute on function api.cells_around(double precision, double precision, double precision) to anon;

-- DoS backstop: cap how long an anon query may run.
alter role anon set statement_timeout = '3s';

-- PostgREST must reload to see the new function.
notify pgrst, 'reload schema';
