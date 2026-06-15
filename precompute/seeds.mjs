// precompute/seeds.mjs
// Generate the fixed national seed grid for Czechia (U2).
//
// Produces an ABSOLUTE hex grid anchored to a fixed SW corner — not the
// per-click, origin-centered grid of js/geo.js's hexGrid — so each physical
// cell has a stable (row,col) and therefore a deterministic id across
// regenerations (R17). Reuses geo.js's offsetKm/cosLat scaling so the grid
// matches the app's equirectangular convention.
//
// Output:
//   precompute/seeds.csv        -> id,lng,lat   (COPY source for dist.seed)
//   precompute/seeds.meta.json  -> { seedSetHash, count, spacingKm, bbox, ... }
//
// Boundary clip: if precompute/cz-boundary.geojson exists (a simplified CZ
// Polygon/MultiPolygon in lng,lat), seeds outside it are dropped. If absent,
// the script falls back to the bounding box and warns — supply a polygon for a
// tight national fit (the boundary source is an Open Question in the plan).

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { offsetKm, KM_PER_DEG_LAT, KM_PER_DEG_LNG_EQUATOR } from "../js/geo.js";

const HERE = dirname(fileURLToPath(import.meta.url));
// Output dir: defaults to this folder for local runs; the Coolify precompute
// container sets OUT_DIR to a shared volume the load step reads.
const OUT = process.env.OUT_DIR ?? HERE;

// --- Config (launch target: 5 km, KTD10) -----------------------------------
const SPACING_KM = Number(process.env.SEED_SPACING_KM ?? 5);
// Czech Republic bounding box (lng/lat). Generous; the polygon clip tightens it.
const BBOX = { minLng: 12.0, minLat: 48.5, maxLng: 18.9, maxLat: 51.1 };
const ANCHOR = { lat: BBOX.minLat, lng: BBOX.minLng }; // fixed SW corner
const COL_STRIDE = 100000; // id = row * COL_STRIDE + col; col count << stride

// --- Boundary polygon (optional) --------------------------------------------
function loadBoundary() {
  const p = join(HERE, "cz-boundary.geojson");
  if (!existsSync(p)) {
    console.warn(
      "[seeds] cz-boundary.geojson not found — clipping to bbox only. " +
        "Drop a simplified CZ Polygon/MultiPolygon there for a tight fit."
    );
    return null;
  }
  const gj = JSON.parse(readFileSync(p, "utf8"));
  const geom = gj.type === "Feature" ? gj.geometry : gj.type === "FeatureCollection" ? gj.features[0].geometry : gj;
  // Normalize to an array of polygons, each an array of rings [ [lng,lat], ... ].
  return geom.type === "MultiPolygon" ? geom.coordinates : [geom.coordinates];
}

// Ray-casting point-in-ring; a point is inside a polygon if it's in the outer
// ring and in none of the holes.
function pointInRing(lng, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    const intersects = yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}
function pointInPolygons(lng, lat, polygons) {
  if (!polygons) return lng >= BBOX.minLng && lng <= BBOX.maxLng && lat >= BBOX.minLat && lat <= BBOX.maxLat;
  for (const rings of polygons) {
    if (!pointInRing(lng, lat, rings[0])) continue;
    let inHole = false;
    for (let h = 1; h < rings.length; h++) if (pointInRing(lng, lat, rings[h])) { inHole = true; break; }
    if (!inHole) return true;
  }
  return false;
}

// --- Generate ----------------------------------------------------------------
const boundary = loadBoundary();
const rowStepKm = SPACING_KM * (Math.sqrt(3) / 2);
// Span from the SW anchor to the NE corner, in km, via the app's offset convention.
const heightKm = (BBOX.maxLat - BBOX.minLat) * KM_PER_DEG_LAT;
const widthKm = (BBOX.maxLng - BBOX.minLng) * KM_PER_DEG_LNG_EQUATOR * Math.cos((ANCHOR.lat * Math.PI) / 180);
const maxRow = Math.ceil(heightKm / rowStepKm);
const maxCol = Math.ceil(widthKm / SPACING_KM);

const seeds = [];
for (let row = 0; row <= maxRow; row++) {
  const northKm = row * rowStepKm;
  const xOffset = row % 2 === 0 ? 0 : SPACING_KM / 2; // hex stagger
  for (let col = 0; col <= maxCol; col++) {
    const eastKm = col * SPACING_KM + xOffset;
    const { lat, lng } = offsetKm(ANCHOR, eastKm, northKm);
    if (lat > BBOX.maxLat + 0.01 || lng > BBOX.maxLng + 0.01) continue;
    if (!pointInPolygons(lng, lat, boundary)) continue;
    seeds.push({ id: row * COL_STRIDE + col, lng, lat });
  }
}

if (seeds.length === 0) throw new Error("[seeds] no seeds generated — check bbox/boundary");

// --- seed_set_hash: stable over the sorted (id, rounded geom) set ------------
seeds.sort((a, b) => a.id - b.id);
const round6 = (n) => n.toFixed(6);
const hash = createHash("sha256");
for (const s of seeds) hash.update(`${s.id},${round6(s.lng)},${round6(s.lat)}\n`);
const seedSetHash = hash.digest("hex");

// --- Write (to OUT_DIR) ------------------------------------------------------
const csv = "id,lng,lat\n" + seeds.map((s) => `${s.id},${round6(s.lng)},${round6(s.lat)}`).join("\n") + "\n";
writeFileSync(join(OUT, "seeds.csv"), csv);
writeFileSync(
  join(OUT, "seeds.meta.json"),
  JSON.stringify(
    { seedSetHash, count: seeds.length, spacingKm: SPACING_KM, bbox: BBOX, anchor: ANCHOR, colStride: COL_STRIDE, clippedToBoundary: Boolean(boundary) },
    null,
    2
  ) + "\n"
);
// Bare hash file so the load step can pass it to load.sql without a JSON parser.
writeFileSync(join(OUT, "seed_set_hash.txt"), seedSetHash + "\n");

console.log(`[seeds] ${seeds.length} seeds @ ${SPACING_KM} km -> ${OUT}/seeds.csv  (seed_set_hash ${seedSetHash.slice(0, 12)}…)`);
