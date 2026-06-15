# distvis

Travel-time visualization on a Leaflet map using Voronoi cells, for **Czechia**.

Pick an origin (click the map, or search e.g. **Prague**) and the surrounding
area — up to a 450 km radius — is tiled with Voronoi cells, each colored by how
long it takes to travel there from the origin. Travel times are **pre-computed**
and served from a database, so the map paints in a single fast request instead of
routing live.

## How travel times are computed

The map is **not** a true isochrone — it's a sampled approximation served from a
precomputed store. Knowing the pipeline explains most visual quirks.

### 1. Pre-computation (offline, one-time)

A fixed grid of **seed points** (default 5 km spacing) covers Czechia. A
self-hosted [OSRM](https://project-osrm.org) computes the full seed-to-seed
travel-time matrix once, per mode (car/bike/foot), over
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
- **Mode** — car, bike, or foot (only modes present in the dataset are enabled).
- **Radius** — how far out to show cells (50–450 km).
- **Opacity** — overlay transparency.

## Running

The frontend is plain static files (no build step). Point it at your data
service by setting `POSTGREST_BASE` (and `ANON_JWT` if required) in
`js/config.js`, then serve over HTTP:

```sh
python3 -m http.server 8000
# or: npx serve
```

then open <http://localhost:8000>. Pushes to `main` deploy automatically to
GitHub Pages.

Leaflet and d3-delaunay load from CDNs; geocoding uses
[Nominatim](https://nominatim.org). Travel-time data comes from your
Postgres/PostGIS + PostgREST backend.

## Building the data

Standing up the backend (self-hosted Postgres + PostGIS + PostgREST) and building
the matrix (self-hosted OSRM precompute → COPY → atomic swap) is described
end-to-end in [`precompute/README.md`](precompute/README.md). The design of
record is `docs/plans/2026-06-15-001-feat-precomputed-distance-store-plan.md`.
