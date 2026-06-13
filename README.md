# distvis

Travel-time visualization on a Leaflet map using Voronoi cells.

Pick an origin (click the map, or search e.g. **Prague**) and the surrounding
area — up to a 450 km radius, enough to cover the whole Czech Republic — is
tiled with Voronoi cells, each colored by how long it takes to travel there
from the origin.

## How travel times are computed

The map is **not** a true isochrone — it's a sampled approximation. Knowing the
pipeline explains most visual quirks:

### 1. Sampling

Each Voronoi cell shows the travel time **to its seed point** — everything
inside a cell gets that one value. The **Cell size** setting picks the target
spacing (5–40 km, default 10 km). To stay responsive, the number of routed
points is capped at ~1200: at large radii the cell size is automatically
enlarged to fit (the status line says so), so e.g. a 50–200 km radius gets
true 10 km cells while a 450 km radius coarsens to ~25 km. Two seeding
strategies (the **Cells** selector):

- **Hex grid (default, fast).** A uniform hexagonal grid over the radius
  (`js/geo.js`). No extra network call, so the map responds immediately on
  click. Points snapped far from any road are grayed (see Snapping below).
- **Road junctions.** Real road-network nodes fetched from the
  [Overpass API](https://overpass-api.de) (`js/nodes.js`): motorway exits
  (`highway=motorway_junction`) plus significant crossings — nodes shared by
  3+ motorway/trunk/primary ways — then spatially thinned to one node per
  cell-size bucket. Cells follow the actual road network and every seed lies
  *on* a road, so there are no snapping artifacts. The trade-off is the
  Overpass query (heavy for large radii, several seconds); results are cached
  per area, and the app falls back to the hex grid if the lookup fails or the
  area has too few major roads.

### 2. Routing (the real data path)

Travel times come from the public [FOSSGIS OSRM](https://routing.openstreetmap.de)
`table` service (`js/routing.js`), in batches of ≤99 points run up to 4 at a
time so routing isn't a long serial wait:

```
GET /routed-car/table/v1/driving/{origin};{p1};…;{p99}?sources=0&annotations=duration
```

OSRM returns the duration in seconds of the **fastest road route** from the
origin to each point, using OpenStreetMap road data and typical speed limits.
Important properties of this data:

- **Snapping.** OSRM first snaps every sample point to the nearest routable
  road. With road-junction seeding this is a no-op (the seeds are already on
  roads), but in hex-grid mode a point that lands in a forest or lake gets
  evaluated from a road possibly kilometers away. Cells whose point had to be
  moved more than ~0.6 × the cell spacing (min 1.5 km) are rendered gray as
  unreliable, with the snap distance shown in the tooltip.
- **No traffic.** Times are free-flow estimates from speed profiles, not live
  or historical traffic.
- **`null` = unreachable** (no road connection found) — rendered gray.
- The bike/foot modes use the corresponding OSRM profiles (`routed-bike`,
  `routed-foot`).

### 3. Fallback (the fake data path)

If the OSRM request fails (offline, rate-limited, CORS), the app silently
degrades to a crow-flies estimate:

```
time = haversine_distance × 1.3 (detour factor) / speed   (car 75, bike 16, foot 4.5 km/h)
```

This produces smooth concentric rings that ignore roads entirely. **The status
line under the controls tells you which source you're looking at** — if it says
"routing API unreachable — showing straight-line estimates", the colors are
geometry, not reality.

### 4. Coloring

Colors run linearly from 0 minutes (green) through yellow/orange/red to purple.
While batches stream in, a conservative provisional maximum derived from the
radius and mode (`radius × 1.3 / mode speed`) anchors the scale; once routing
completes, the scale is **rescaled to the 98th percentile of the actual data**
(rounded to a nice value) and all cells are repainted, so the full palette is
always used and the legend reflects real times. Hover any cell for the exact
minutes — the tooltip is always the ground truth.

## Controls

- **Search / map click** — set the origin point.
- **Mode** — car, bike, or foot routing profile.
- **Cells** — Voronoi seeds: uniform hex grid (default, fast) or road junctions.
- **Radius** — how far out to sample (50–450 km).
- **Cell size** — target spacing of the cells (5–40 km; auto-enlarged at large radii).
- **Opacity** — overlay transparency.

## Running

Pushes to `main` deploy automatically to GitHub Pages via
`.github/workflows/deploy-pages.yml`.

For local development — plain static files, no build step — ES modules just
need an HTTP server:

```sh
python3 -m http.server 8000
# or: npx serve
```

then open <http://localhost:8000>.

Leaflet and d3-delaunay are loaded from CDNs; routing and geocoding use free
public OSM services (please be gentle with them).
