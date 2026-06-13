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

A hexagonal grid of sample points is laid over the selected radius
(`js/geo.js`), spaced `radius / 8|12|18` km apart depending on the Detail
setting (e.g. 300 km radius at Medium ⇒ ~25 km spacing ⇒ ~520 points). Each
Voronoi cell simply shows the travel time **to its center point** — everything
inside a cell gets that one value. Coarser detail = bigger cells = blockier,
less accurate picture.

### 2. Routing (the real data path)

Travel times come from the public [FOSSGIS OSRM](https://routing.openstreetmap.de)
`table` service (`js/routing.js`), one HTTP request per batch of ≤99 points:

```
GET /routed-car/table/v1/driving/{origin};{p1};…;{p99}?sources=0&annotations=duration
```

OSRM returns the duration in seconds of the **fastest road route** from the
origin to each point, using OpenStreetMap road data and typical speed limits.
Important properties of this data:

- **Snapping.** OSRM first snaps every grid point to the nearest routable road.
  A point that lands in a forest or lake gets evaluated from a road possibly
  kilometers away; a point next to a motorway exit gets a much better time than
  its neighbor that snapped to a village lane. This is the main reason two
  adjacent cells can differ sharply.
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

Colors are mapped linearly from 0 minutes (green) to a **fixed maximum**
derived from the radius and mode (`radius × 1.3 / mode speed`, rounded up to a
nice value — e.g. 300 km by car ⇒ 6 h scale). The scale is fixed up front so
cells can be colored as batches stream in, but it means the palette is not
stretched to the actual data: if real times top out well below the scale max,
the reds/purples never appear and differences compress into the green–orange
range. Hover any cell for the exact minutes — the tooltip is always the ground
truth.

## Controls

- **Search / map click** — set the origin point.
- **Mode** — car, bike, or foot routing profile.
- **Radius** — how far out to sample (50–450 km).
- **Detail** — grid density (finer = more cells = more API batches).
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
