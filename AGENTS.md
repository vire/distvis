# AGENTS.md

This file provides guidance to coding agents when working with code in this repository.

## What this is

A travel-time map for **Czechia**: pick an origin and the surrounding area (up to
a 450 km radius) is tiled with Voronoi cells colored by driving/biking/walking
time from that point. Travel times are **pre-computed** (not fetched live) and
served from Postgres/PostGIS via a PostgREST read endpoint.

The **frontend** is still a pure static site — no build step, no bundler, ES
modules load directly in the browser; Leaflet and d3-delaunay come from CDNs;
GitHub Pages serves it. The **backend** is new: a self-hosted Postgres+PostGIS
holding the precomputed seed-to-seed travel-time matrix, exposed read-only
through PostgREST. The matrix is built offline by `precompute/` tooling and is
not part of the deployed site.

## Running

Frontend (static, served over HTTP — `file://` won't work for ES modules):

```sh
python3 -m http.server 8000   # or: npx serve
```

Set `POSTGREST_BASE` (and `ANON_JWT` if required) in `js/config.js` to point at
your PostgREST endpoint, or the map will show "data service unavailable".

Pushing to `main` deploys to GitHub Pages via `.github/workflows/deploy-pages.yml`,
which uploads the repo root verbatim after a **secret-guard** step
(`scripts/check-no-secrets.sh`) — so paths stay relative, there's no compile
step, and no privileged credential may be tracked.

Backend/data: see `precompute/README.md` for the full runbook (seed grid →
self-hosted OSRM → matrix → load + atomic swap). SQL lives in `db/`.

## Architecture

Two data paths. Only the online one runs in the deployed site.

```
OFFLINE (one-time / on refresh, precompute/ + db/):
  CZ extract + seed grid → self-hosted OSRM (per profile) → matrix.csv
    → COPY into Postgres staging → validate → atomic swap (versioned snapshot)

ONLINE (per origin, the deployed app):
  click → datasource.fetchCells → PostgREST api.cells_around
    → snap origin to nearest seed (PostGIS KNN) + radius filter
    → {seed, snapMeters, cells, modes, version} → Voronoi → color
```

Frontend modules (browser ES modules, no framework):

- **`js/main.js`** — orchestration, Leaflet map, UI wiring, the `compute()`
  pipeline (fetch payload → build Voronoi → color), result cache, legend, tooltips.
- **`js/datasource.js`** — the ONLY transport-aware module: calls the PostgREST
  RPC and returns the frontend's own `{ seed, snapMeters, cells, modes, version }`
  shape. The backend can be swapped here without touching `compute()`.
- **`js/config.js`** — public deploy config (PostgREST base URL + anon JWT). No secrets.
- **`js/geo.js`** — `haversineKm`, `offsetKm`, and the `KM_PER_DEG_LAT` /
  `KM_PER_DEG_LNG_EQUATOR` earth-model constants. The equirectangular `cosLat`
  scale is applied inline in `main.js` and `seeds.mjs` — a convention, not an
  export. A **shared kernel**: imported by both the browser app and the Node
  `precompute/seeds.mjs`, so it must stay environment-neutral.
- **`js/colors.js`** — the green→purple travel-time scale and legend formatting.

Backend:

- **`db/schema.sql`** — PostGIS, the private `dist` schema (seed, matrix,
  matrix_version), and the exposed `api` schema.
- **`db/rpc.sql`** — `api.cells_around`, the single read function.
- **`db/checks.sql`** — assertion queries (schema/seed/load/RPC sections).
- **`precompute/`** — `seeds.mjs`, `build-matrix.mjs`, `docker-compose.yml`,
  `load.sql`, and the runbook.

External services: PostgREST (your endpoint), Nominatim (geocoding), OSM tiles.
OSRM is used only during the offline precompute (self-hosted, no rate limit).

## Invariants you must preserve

- **Payload-order index alignment.** Voronoi geometry is built from the RPC
  payload's `cells` array in its own order: `cellPoints[i]` ↔ `cells[i].seconds`.
  Pair coordinate and duration from the same array element — never zip two
  independently ordered lists. Synthetic edge-ring points are appended *after*
  the payload cells and are excluded from coloring (they only bound the outer
  Voronoi cells, replacing the old `hexGrid` edge ring).
- **Seconds three-state.** A cell's `seconds` is a number (reachable), `null`
  (in-radius but unreachable → gray), or the seed is simply absent from `cells`
  (out-of-radius). Absent never means unreachable. Preserve this distinction
  end to end (RPC → payload → coloring).
- **Snapped origin.** The clicked point snaps to the nearest precomputed seed;
  the marker shows the seed with a "snapped ~N km" note and tooltip distances
  are measured from the seed, not the click. `snapMeters` is origin-snap
  confidence (whole-result), not a per-cell road-snap distance.
- **Snapshot consistency.** At all times the live `dist.seed`, live `dist.matrix`,
  and the active `dist.matrix_version` row describe the *same* build (same
  `seed_set_hash`, `profile_version`, `extract_date`). Publish and rollback
  transition all three atomically in one transaction; readers never see a mix.
- **Private base tables.** `dist.*` is never added to PostgREST's `db-schemas`;
  `anon` may only EXECUTE `api.cells_around`. Any new RPC must repeat the U5
  hardening (search_path, clamps, row cap, grants) — the public endpoint is only
  as safe as that.
- **`AbortController` per run.** Each `compute()` aborts the previous one and
  threads its `signal` through `fetchCells`. New async work must honor it and
  swallow `AbortError` (user moved on) distinctly from real failures.
- **Equirectangular Voronoi.** Cells are tessellated in `lng * cos(lat)`, `lat`
  space (cosLat from the snapped seed) and projected back. Apply and undo the
  `cosLat` scale consistently.
- **Coupled speed constants.** `MODE_SPEED_KMH` in `main.js` is the color-domain
  fallback per mode; the precompute uses OSRM's own profiles. They serve
  different purposes — don't assume they must match.

## Key knobs

- **`POSTGREST_BASE` / the `js/datasource.js` body** (`DATA_SOURCE` seam) — the
  successor to the old `OSRM_BASE` lever. Swap the backend (PostgREST ↔ custom
  API ↔ static precomputed JSON) by changing `datasource.js`; the return shape is
  the fixed contract, the transport is not.
- **`SEED_SPACING_KM`** (`precompute/seeds.mjs`, default 5) — grid resolution.
  Storage and precompute cost grow as `modes × seeds²`; on self-hosted Postgres
  the ceiling is disk, not a tier.
- **`SRC_BATCH` / `DEST_BATCH`** (`precompute/build-matrix.mjs`) — matrix tile
  size; `--max-table-size` in `docker-compose.yml` must exceed their sum.
- **`MAX_RENDER_CELLS`** (`main.js`, 2000) — coarsens the displayed grid at large
  radii so a national payload stays responsive.
- **`--max-table-size`** (`docker-compose.yml`) — OSRM matrix request cap.

## Read first

`docs/plans/2026-06-15-001-feat-precomputed-distance-store-plan.md` is the design
of record (decisions, requirements, scope, open questions). `precompute/README.md`
is the operator runbook. `README.md` documents the data path for users.
