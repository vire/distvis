// Real road-network nodes (motorway exits + significant crossings) from the
// Overpass API, used as Voronoi seeds instead of an arbitrary grid.

import { timeoutSignal } from "./routing.js";

// Overpass can be slow on large areas; cap the wait so the app can fall back
// to the hex grid instead of hanging.
const OVERPASS_TIMEOUT_MS = 45000;

const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
];

// Roads whose junctions count as "significant crossings".
const MAJOR_ROADS = "motorway|trunk|primary";

/**
 * Fetch road nodes within `radiusKm` of `origin`:
 * - `highway=motorway_junction` nodes (exits), plus
 * - nodes shared by 3+ major-road ways (real intersections; the 3+ threshold
 *   skips nodes where a single road is merely split into two OSM ways).
 */
export async function fetchRoadNodes(origin, radiusKm, signal) {
  const around = `(around:${Math.round(radiusKm * 1000)},${origin.lat.toFixed(5)},${origin.lng.toFixed(5)})`;
  const query = `[out:json][timeout:45];
way[highway~"^(${MAJOR_ROADS})$"]${around}->.roads;
(
  node[highway=motorway_junction]${around};
  node(way_cnt.roads:3-)${around};
);
out skel qt;`;

  let lastError;
  for (const endpoint of OVERPASS_ENDPOINTS) {
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        body: new URLSearchParams({ data: query }),
        signal: timeoutSignal(signal, OVERPASS_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`Overpass HTTP ${res.status}`);
      const data = await res.json();
      return (data.elements ?? [])
        .filter((el) => el.type === "node")
        .map((el) => ({ lat: el.lat, lng: el.lon }));
    } catch (err) {
      if (err.name === "AbortError") throw err;
      lastError = err;
    }
  }
  throw lastError ?? new Error("Overpass unavailable");
}

/**
 * Spatially thin nodes to roughly one per `spacingKm` bucket (keeping the
 * node nearest each bucket center) so cells stay readable and the routing
 * request count stays bounded.
 */
export function thinNodes(nodes, origin, spacingKm, maxNodes = 1600) {
  const cosLat = Math.cos((origin.lat * Math.PI) / 180);
  const buckets = new Map();
  for (const node of nodes) {
    const eastKm = (node.lng - origin.lng) * 111.32 * cosLat;
    const northKm = (node.lat - origin.lat) * 110.574;
    const bx = Math.round(eastKm / spacingKm);
    const by = Math.round(northKm / spacingKm);
    const key = `${bx},${by}`;
    const offCenter = Math.hypot(eastKm - bx * spacingKm, northKm - by * spacingKm);
    const current = buckets.get(key);
    if (!current || offCenter < current.offCenter) buckets.set(key, { node, offCenter });
  }
  let thinned = [...buckets.values()].map((b) => b.node);
  if (thinned.length > maxNodes) {
    const step = thinned.length / maxNodes;
    thinned = Array.from({ length: maxNodes }, (_, i) => thinned[Math.floor(i * step)]);
  }
  return thinned;
}
