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

// The FOSSGIS OSRM demo server is a shared free service that rate-limits
// bursts (HTTP 429). Keep concurrency low and retry rate-limited batches with
// backoff so we recover real data instead of dumping to straight-line
// estimates the moment the server pushes back.
const CONCURRENCY = 2;
const MAX_RETRIES = 3;
const BASE_BACKOFF_MS = 600;

// Per-request timeout so a hung public API degrades to fallback instead of
// stalling the app indefinitely.
const REQUEST_TIMEOUT_MS = 30000;

/** Abortable sleep: rejects with the signal's reason if aborted while waiting. */
function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => { clearTimeout(t); reject(signal.reason); }, { once: true });
  });
}

/**
 * Signal that aborts when `parent` aborts (AbortError, propagated) or after
 * `ms` elapses (TimeoutError — deliberately distinct so callers treat a
 * timeout as a failure to fall back from, not as a user cancellation).
 */
export function timeoutSignal(parent, ms) {
  const ctl = new AbortController();
  if (parent) {
    if (parent.aborted) ctl.abort(parent.reason);
    else parent.addEventListener("abort", () => ctl.abort(parent.reason), { once: true });
  }
  setTimeout(() => ctl.abort(new DOMException("Request timed out", "TimeoutError")), ms);
  return ctl.signal;
}

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
  // Holes (undefined) mean "not filled yet"; a written `null` means genuinely
  // unreachable. Keeping them distinct lets callers color only arrived cells,
  // which matters because batches complete out of order under concurrency.
  const durations = new Array(points.length);
  const snapMeters = new Array(points.length).fill(0);
  let usedEstimate = false;
  let completed = 0;

  const starts = [];
  for (let s = 0; s < points.length; s += BATCH_SIZE) starts.push(s);

  // When one batch is rate-limited, hold all workers back until this time so we
  // stop hammering the server instead of each worker tripping 429 in turn.
  let cooldownUntil = 0;

  const runBatch = async (start) => {
    const batch = points.slice(start, start + BATCH_SIZE);
    for (let attempt = 0; ; attempt++) {
      signal?.throwIfAborted();
      const pause = cooldownUntil - Date.now();
      if (pause > 0) await delay(pause, signal);
      try {
        const result = await osrmTable(profile, origin, batch, signal);
        result.durations.forEach((d, i) => { durations[start + i] = d; });
        result.snapMeters.forEach((s, i) => { snapMeters[start + i] = s; });
        break;
      } catch (err) {
        if (err.name === "AbortError") throw err;
        if (err.retryable && attempt < MAX_RETRIES) {
          const backoff = err.retryAfterMs ||
            BASE_BACKOFF_MS * 2 ** attempt + Math.random() * 250;
          cooldownUntil = Math.max(cooldownUntil, Date.now() + backoff);
          await delay(backoff, signal);
          continue;
        }
        // Out of retries (or a non-retryable error): fall back to estimate.
        usedEstimate = true;
        batch.forEach((p, i) => { durations[start + i] = estimateSeconds(origin, p, mode); });
        break;
      }
    }
    completed += batch.length;
    onProgress?.(completed, points.length, durations, snapMeters);
  };

  // Pull batches off a shared queue with a fixed number of workers.
  let next = 0;
  const worker = async () => {
    while (next < starts.length) await runBatch(starts[next++]);
  };
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, starts.length) }, worker));

  return { durations, snapMeters, source: usedEstimate ? "estimate" : "osrm" };
}

async function osrmTable(profile, origin, destinations, signal) {
  const coords = [origin, ...destinations]
    .map((p) => `${p.lng.toFixed(5)},${p.lat.toFixed(5)}`)
    .join(";");
  const url = `${OSRM_BASE}/${profile}/table/v1/driving/${coords}?sources=0&annotations=duration`;
  const res = await fetch(url, { signal: timeoutSignal(signal, REQUEST_TIMEOUT_MS) });
  if (!res.ok) {
    // 429 (rate limited) and 5xx (transient server) are worth retrying.
    const retryable = res.status === 429 || res.status >= 500;
    const err = new Error(`OSRM HTTP ${res.status}`);
    err.retryable = retryable;
    const retryAfter = Number(res.headers.get("retry-after"));
    if (retryAfter > 0) err.retryAfterMs = retryAfter * 1000;
    throw err;
  }
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
