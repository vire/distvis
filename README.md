# distvis

Travel-time visualization on a Leaflet map using Voronoi cells, for **Czechia**.

Pick an origin (click the map, or search e.g. **Prague**) and the surrounding
area — up to a 450 km radius — is tiled with Voronoi cells, each colored by how
long it takes to drive there from the origin. Travel times are **pre-computed**
and served from a database, so the map paints in a single fast request instead of
routing live.

## Architecture

Three independent pieces:

| Component | Lives in | What it is |
|---|---|---|
| **Static frontend** | `index.html`, `js/`, `css/` | A no-build static site (ES modules + CDN Leaflet & d3-delaunay). Renders the map, snaps the origin, colors the cells. |
| **Data store + API** | `db/`, `Dockerfile.db`, `docker-compose.yml` | Self-hosted Postgres + PostGIS holding the seed grid and travel-time matrix, behind a read-only [PostgREST](https://postgrest.org) API. |
| **Precompute pipeline** | `precompute/` | Offline, one-time tooling: a self-hosted [OSRM](https://project-osrm.org) builds the matrix, then SQL loads it with an atomic swap. |

```
                  click / search (set origin)
                            │
 browser ── js/datasource.js ──HTTPS POST──▶ PostgREST ──▶ api.cells_around(lng, lat, radius)
                                                                │  snap to nearest seed (PostGIS)
                                                                │  filter destinations within radius
                                                                ▼
                                                  dist.seed · dist.matrix   (private schema)
                                                                ▲
   precompute/  OSRM table ─▶ matrix.csv ──load.sql (stage → validate → atomic swap)
```

The browser only ever calls one function; it never sees the raw matrix.

## Data model & exposure

- **Seed grid.** A fixed grid (~5 km spacing) clipped to the Czech border
  (`precompute/cz-boundary.geojson`) — ~3,700 points. IDs are derived
  deterministically from geometry, so they're stable across rebuilds.
- **Matrix.** The full seed-to-seed **car-driving** duration matrix (one snapshot
  ≈ N² rows). Unreachable pairs are retained as `NULL`.
- **Private base tables.** `dist.seed`, `dist.matrix`, and `dist.matrix_version`
  live in a private `dist` schema that PostgREST does **not** expose. Only an `api`
  schema is exposed, holding a single function `cells_around(lng, lat, radius_m)`.
  The anonymous role may only **execute** that function (input-clamped and
  statement-timeout-bounded) — it cannot read the tables. PostGIS lives in
  `public` and powers the nearest-seed snap and the radius filter.
- **Versioned snapshots.** Each load records a `matrix_version` row and swaps the
  new seed/matrix tables in inside a single transaction, keeping the previous as
  `*_prev` for rollback — so refreshes are atomic and downtime-free.

## How travel times are computed

The map is **not** a true isochrone — it's a sampled approximation served from a
precomputed store. Knowing the pipeline explains most visual quirks.

### 1. Pre-computation (offline, one-time)

A fixed grid of **seed points** (default 5 km spacing, clipped to the Czech
border) covers Czechia. A self-hosted OSRM computes the full seed-to-seed
**car-driving** travel-time matrix once over
[OpenStreetMap](https://www.openstreetmap.org/copyright) road data. The matrix is
loaded into Postgres/[PostGIS](https://postgis.net) and published as a versioned
snapshot. There is no live routing at view time, so no rate limits and no point
cap. See `precompute/README.md` for the operator runbook.

### 2. Retrieval (per click)

When you set an origin, the app calls one read-only PostgREST function that:

- **Snaps** your clicked point to the nearest seed (a PostGIS nearest-neighbour
  lookup). The map marker moves to that seed and notes how far it snapped — so
  the times you see are measured from the seed, up to ~half the grid spacing
  away from your exact click.
- **Filters** to the destination seeds within your chosen radius and returns
  their precomputed travel times in one response.

Each Voronoi cell shows the travel time **to its seed point** — everything inside
a cell gets that one value.

Important properties of the data:

- **No traffic.** Times are free-flow estimates from OSRM speed profiles, not
  live or historical traffic.
- **Unreachable** seeds (no road connection) render gray.
- **Snapshot, not live.** The data reflects a dated OSM extract; the status line
  shows "road data as of …" so you know its age.

### 3. Coverage

Coverage is **Czechia only**. Clicking outside the country (or far from any seed)
shows an explicit "outside coverage" message rather than a misleading map. A
radius smaller than the grid resolution asks you to zoom out / increase the
radius. If the data service is unreachable, the app says so and you can retry —
there is no straight-line estimate fallback.

### 4. Coloring

Colors run linearly from 0 minutes (green) through yellow/orange/red to purple.
The scale is set to the 98th percentile of the actual data (rounded to a nice
value) so the full palette is used and the legend reflects real times. Hover any
cell for the exact minutes.

## Controls

- **Search / map click** — set the origin point (snapped to the nearest seed).
- **Radius** — how far out to show cells (50–450 km).
- **Opacity** — overlay transparency.

## Running the frontend

The frontend is plain static files (no build step). Point it at your data service
by setting `POSTGREST_BASE` (and `ANON_JWT` if your API requires one) in
`js/config.js`, then serve over HTTP:

```sh
python3 -m http.server 8000
# or: npx serve
```

then open <http://localhost:8000>. Pushes to `main` deploy automatically to
GitHub Pages. Leaflet and d3-delaunay load from CDNs; geocoding uses
[Nominatim](https://nominatim.org).

> Serve the frontend over **HTTPS** in production and give the API an HTTPS
> endpoint too — a browser blocks an HTTPS page from calling an `http://` API
> (mixed content).

## Standing up the backend

The data store + API run as a small container stack (`docker-compose.yml`):

- **`db`** — Postgres + PostGIS, built from `Dockerfile.db`, which bakes
  `db/schema.sql` + `db/rpc.sql` into the image's init scripts. On first boot
  (empty data volume) those create the `dist` + `api` schemas, the `anon` role,
  the tables, and the `cells_around` function.
- **`postgrest`** — exposes **only** the `api` schema, so the base tables stay
  unreachable over HTTP.

Provide the database and `authenticator` credentials via the compose environment
variables (`SERVICE_USER_POSTGRES`, `SERVICE_PASSWORD_POSTGRES`,
`SERVICE_PASSWORD_AUTHENTICATOR`) and bring it up on any container host. Then set
the frontend's `POSTGREST_BASE` to the API's URL.

A fresh backend is **empty** until the matrix is loaded — until then
`cells_around` returns `{status:"unavailable"}` and the map shows "data service
unavailable". No credentials are committed; `scripts/check-no-secrets.sh` guards
against that.

## Building & refreshing the data

The matrix is a **static snapshot** you build once and refresh occasionally
(against a fresh OSM extract). The full operator runbook — OSRM graph build, seed
generation, matrix build, and the staging + atomic-swap load — is in
[`precompute/README.md`](precompute/README.md). `load.sql` stages, validates, and
atomically swaps the new snapshot in (keeping the previous as `*_prev` for
rollback), so a refresh has no API downtime.

The design of record is
`docs/plans/2026-06-15-001-feat-precomputed-distance-store-plan.md`.
