// Travel-time lookup: OSRM table API (FOSSGIS public instances) with a
// straight-line estimate fallback when the API is unreachable.

import { haversineKm } from "./geo.js";

const OSRM_BASE = "https://routing.openstreetmap.de";

const MODES = {
  car: { profile: "routed-car", estimateKmh: 75 },
  bike: { profile: "routed-bike", estimateKmh: 16 },
  foot: { profile: "routed-foot", estimateKmh: 4.5 },
};

// Roads are never straight; inflate the crow-flies distance for estimates.
const DETOUR_FACTOR = 1.3;

// Keep table requests well under public-server limits (1 source + N dests).
const BATCH_SIZE = 99;

/**
 * Returns travel durations in seconds from `origin` to every point in
 * `points` (null = unreachable), plus `snapMeters`: how far OSRM had to move
 * each point to reach the road network (0 for estimated values).
 * `onProgress(done, total, durations, snapMeters)` reports batches with the
 * partially filled arrays.
 * Resolves `{ durations, snapMeters, source }` where source is "osrm" or "estimate".
 */
export async function travelTimes(origin, points, mode, { signal, onProgress } = {}) {
  const { profile } = MODES[mode];
  const durations = new Array(points.length).fill(null);
  const snapMeters = new Array(points.length).fill(0);
  let usedEstimate = false;

  for (let start = 0; start < points.length; start += BATCH_SIZE) {
    signal?.throwIfAborted();
    const batch = points.slice(start, start + BATCH_SIZE);
    try {
      const result = await osrmTable(profile, origin, batch, signal);
      result.durations.forEach((d, i) => { durations[start + i] = d; });
      result.snapMeters.forEach((s, i) => { snapMeters[start + i] = s; });
    } catch (err) {
      if (err.name === "AbortError") throw err;
      usedEstimate = true;
      batch.forEach((p, i) => { durations[start + i] = estimateSeconds(origin, p, mode); });
    }
    onProgress?.(Math.min(start + BATCH_SIZE, points.length), points.length, durations, snapMeters);
  }

  return { durations, snapMeters, source: usedEstimate ? "estimate" : "osrm" };
}

async function osrmTable(profile, origin, destinations, signal) {
  const coords = [origin, ...destinations]
    .map((p) => `${p.lng.toFixed(5)},${p.lat.toFixed(5)}`)
    .join(";");
  const url = `${OSRM_BASE}/${profile}/table/v1/driving/${coords}?sources=0&annotations=duration`;
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`OSRM HTTP ${res.status}`);
  const data = await res.json();
  if (data.code !== "Ok" || !data.durations?.[0]) {
    throw new Error(`OSRM error: ${data.code ?? "no durations"}`);
  }
  // durations[0] = [origin->origin, origin->dest0, ...]; drop the self entry.
  // destinations[i].distance = meters the input point was snapped to a road.
  return {
    durations: data.durations[0].slice(1),
    snapMeters: (data.destinations ?? []).slice(1).map((d) => d?.distance ?? 0),
  };
}

export function estimateSeconds(origin, point, mode) {
  const km = haversineKm(origin, point) * DETOUR_FACTOR;
  return (km / MODES[mode].estimateKmh) * 3600;
}
