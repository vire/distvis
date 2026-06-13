# distvis

Travel-time visualization on a Leaflet map using Voronoi cells.

Pick an origin (click the map, or search e.g. **Prague**) and the surrounding
area — up to a 450 km radius, enough to cover the whole Czech Republic — is
tiled with Voronoi cells, each colored by how long it takes to travel there
from the origin.

## How it works

1. A hexagonal grid of sample points is generated around the origin
   (`js/geo.js`). An extra ring of points just outside the radius keeps the
   boundary cells regularly shaped.
2. Travel times from the origin to every sample point are fetched from the
   public [FOSSGIS OSRM](https://routing.openstreetmap.de) `table` API in
   batches (`js/routing.js`). If the API is unreachable, the app falls back to
   straight-line estimates (haversine distance × detour factor / mode speed).
3. A Voronoi tessellation of the sample points is computed with
   [d3-delaunay](https://github.com/d3/d3-delaunay) and rendered as canvas
   polygons on [Leaflet](https://leafletjs.com), colored green → yellow →
   orange → red → purple by travel time (`js/main.js`, `js/colors.js`).
   Cells fill in progressively as routing batches complete; hover a cell for
   the exact time and distance.

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
