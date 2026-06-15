# AGENTS.md

This file provides guidance to coding agents when working with code in this repository.

## What this is

A travel-time map: pick an origin, and the surrounding area (up to 450 km) is
tiled with Voronoi cells colored by driving/biking/walking time from that point.
It is a **pure static site** — no build step, no bundler, no `package.json`, no
tests, and no Node.js server despite the "nodejs" framing. ES modules load
directly in the browser; Leaflet and d3-delaunay come from CDNs.

## Running

ES modules need to be served over HTTP (file:// won't work):

```sh
python3 -m http.server 8000   # or: npx serve
```

Then open <http://localhost:8000>. There is nothing to build, lint, or test.

Pushing to `main` deploys to GitHub Pages via `.github/workflows/deploy-pages.yml`,
which uploads the repo root verbatim — so paths must stay relative and there is
no compile step between commit and production.

## Architecture

The whole app is one pipeline in `js/main.js` → `compute()`, run on every origin
change or setting change (debounced 350 ms). The stages:

```
sample points  →  Voronoi tessellation  →  travel times  →  color cells
  (geo/nodes)        (d3-delaunay)          (routing.js)      (colors.js)
```

Modules (all browser ES modules, no framework):

- **`js/main.js`** — orchestration, Leaflet map, UI wiring, the `compute()`
  pipeline, result cache, legend, tooltips.
- **`js/geo.js`** — `haversineKm`, `offsetKm`, and `hexGrid` (the default
  sampling).
- **`js/nodes.js`** — alternate "road junctions" sampling via the Overpass API
  (`fetchRoadNodes` + `thinNodes`).
- **`js/routing.js`** — the real data path: OSRM `table` lookups with
  concurrency, retry/backoff, and a straight-line fallback.
- **`js/colors.js`** — the green→purple travel-time scale and legend formatting.

External services are all free, keyless, rate-limited public OSM infrastructure:
OSRM/FOSSGIS (routing), Overpass (junctions), Nominatim (geocoding), OSM tiles.
Be gentle with them; bursts get HTTP 429.

## Invariants you must preserve

These cross-module contracts are subtle and easy to break:

- **Index alignment.** `inner[i]` ↔ `cells[i]` ↔ `durations[i]` ↔ `snapMeters[i]`
  all refer to the same sample point. `inner` (origin + real seeds) is placed
  *first* in the `points` array; off-map `edge` ring points are appended after,
  so Voronoi cell indices `0..inner.length-1` map back to `inner`. Don't reorder.
- **Three-state durations.** In the `durations` array, `undefined` = not routed
  yet, `null` = genuinely unreachable, a number = seconds. Routing batches run
  concurrently and finish **out of order**, so coloring checks each cell's own
  value rather than assuming a contiguous prefix is ready. Preserve this
  distinction (`=== undefined` vs `=== null`).
- **Equirectangular Voronoi.** Cells are tessellated in `lng * cos(lat)`, `lat`
  space so they stay geometrically regular at Czech latitudes, then projected
  back. Any geometry change must apply and undo the `cosLat` scale consistently.
- **Coupled speed constants.** `MODE_SPEED_KMH` in `main.js` and `MODES[*].estimateKmh`
  in `routing.js` are the same per-mode speeds for two different purposes (color
  domain vs. fallback estimate). Change them together.
- **`AbortController` per run.** Each `compute()` aborts the previous one and
  threads its `signal` through OSRM and Overpass. New async work must accept and
  honor that signal, and distinguish `AbortError` (user moved on — swallow) from
  `TimeoutError` (a real failure to fall back from).

## Key knobs

- **`OSRM_BASE`** (`js/routing.js`) — swap the routing backend. Self-hosted OSRM
  is a drop-in (identical `table` request shape); a keyed API (ORS/Mapbox) needs
  `osrmTable()` adapted to its matrix format. This is the lever to escape the
  shared demo server's 429s.
- **`MAX_ROUTE_POINTS`** (`js/main.js`, 1200) — caps routed points; when a radius
  at a given cell size would exceed it, `effectiveSpacingKm()` auto-coarsens the
  cells (the status line announces this).
- **`CONCURRENCY` / `MAX_RETRIES` / `BASE_BACKOFF_MS`** (`js/routing.js`) — the
  rate-limit posture. Raising concurrency against the public server invites 429s.

## Read first

`README.md` documents the travel-time computation in depth (sampling, snapping,
rate limits, the estimate fallback, coloring/rescaling). Read it before changing
anything in the data pipeline — most visual quirks are explained there.
