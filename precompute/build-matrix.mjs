// precompute/build-matrix.mjs
// Build the full seed-to-seed duration matrix from a SELF-HOSTED OSRM (U3).
//
// Reads precompute/seeds.csv (id,lng,lat in file order) and, for each mode,
// queries the local osrm-routed `table` service, streaming results to
// precompute/matrix.csv as `mode,origin_id,dest_id,seconds` (seconds blank =
// unreachable, retained per KTD5; COPY reads a blank field as NULL).
//
// Batching: the matrix is TILED — both sources and destinations are chunked, so
// each request's coordinate list is at most SRC_BATCH+DEST_BATCH points. This
// avoids the oversized-URL problem of a single `destinations=all` request over
// thousands of seeds (a refinement of the plan's batching sketch). Consequently
// osrm-routed only needs `--max-table-size >= SRC_BATCH+DEST_BATCH`.
//
// Prereq: the three osrm-routed servers are up (see docker-compose.yml /
// README). Run:  node build-matrix.mjs

import { readFileSync, createWriteStream, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { once } from "node:events";

const HERE = dirname(fileURLToPath(import.meta.url));

// Per-mode OSRM endpoints (one single-profile osrm-routed per port).
const MODES = [
  { key: "car", mode: 0, base: process.env.OSRM_CAR ?? "http://localhost:5000" },
  { key: "bike", mode: 1, base: process.env.OSRM_BIKE ?? "http://localhost:5001" },
  { key: "foot", mode: 2, base: process.env.OSRM_FOOT ?? "http://localhost:5002" },
];
const SRC_BATCH = Number(process.env.SRC_BATCH ?? 200);
const DEST_BATCH = Number(process.env.DEST_BATCH ?? 200);
const REQUEST_TIMEOUT_MS = 120000;
const MAX_RETRIES = 3;

// --- Load seeds in file order (index i <-> seeds[i]) -------------------------
const lines = readFileSync(join(HERE, "seeds.csv"), "utf8").trim().split("\n");
if (lines[0] !== "id,lng,lat") throw new Error("seeds.csv: unexpected header — run seeds.mjs first");
const seeds = lines.slice(1).map((l) => {
  const [id, lng, lat] = l.split(",");
  return { id: Number(id), lng: Number(lng), lat: Number(lat) };
});
const N = seeds.length;
console.log(`[matrix] ${N} seeds, tiles ${SRC_BATCH}x${DEST_BATCH}, modes: ${MODES.map((m) => m.key).join(",")}`);

// --- Backpressure-aware CSV sink --------------------------------------------
const out = createWriteStream(join(HERE, "matrix.csv"));
async function emit(line) {
  if (!out.write(line)) await once(out, "drain");
}

async function osrmTableTile(base, srcSeeds, destSeeds, signal) {
  const coords = [...srcSeeds, ...destSeeds].map((p) => `${p.lng.toFixed(6)},${p.lat.toFixed(6)}`).join(";");
  const sources = srcSeeds.map((_, i) => i).join(";");
  const destinations = srcSeeds.map((_, i) => srcSeeds.length + i).join(";");
  const url = `${base}/table/v1/driving/${coords}?sources=${sources}&destinations=${destinations}&annotations=duration`;
  const res = await fetch(url, { signal });
  if (!res.ok) {
    const err = new Error(`OSRM HTTP ${res.status}`);
    err.retryable = res.status === 429 || res.status >= 500;
    throw err;
  }
  const data = await res.json();
  if (data.code !== "Ok" || !Array.isArray(data.durations)) {
    throw new Error(`OSRM error: ${data.code ?? "no durations"} (raise --max-table-size if 'TooBig')`);
  }
  return data.durations; // durations[srcRow][destCol], seconds or null
}

async function withRetry(fn) {
  for (let attempt = 0; ; attempt++) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(new Error("timeout")), REQUEST_TIMEOUT_MS);
    try {
      return await fn(ctl.signal);
    } catch (err) {
      if ((err.retryable || err.message === "timeout") && attempt < MAX_RETRIES) {
        await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
        continue;
      }
      throw err;
    } finally {
      clearTimeout(t);
    }
  }
}

// --- Tile the matrix ---------------------------------------------------------
let rows = 0;
let nulls = 0;
const nullsByMode = {};
for (const { key, mode, base } of MODES) {
  nullsByMode[key] = 0;
  for (let s = 0; s < N; s += SRC_BATCH) {
    const srcSeeds = seeds.slice(s, s + SRC_BATCH);
    for (let d = 0; d < N; d += DEST_BATCH) {
      const destSeeds = seeds.slice(d, d + DEST_BATCH);
      const durations = await withRetry((sig) => osrmTableTile(base, srcSeeds, destSeeds, sig));
      for (let i = 0; i < srcSeeds.length; i++) {
        const row = durations[i];
        let chunk = "";
        for (let j = 0; j < destSeeds.length; j++) {
          const v = row[j];
          if (v == null) { nulls++; nullsByMode[key]++; }
          chunk += `${mode},${srcSeeds[i].id},${destSeeds[j].id},${v == null ? "" : Math.round(v)}\n`;
        }
        await emit(chunk);
        rows += destSeeds.length;
      }
    }
    process.stdout.write(`\r[matrix] ${key}: sources ${Math.min(s + SRC_BATCH, N)}/${N}   `);
  }
  console.log();
}

out.end();
await once(out, "finish");

// Record what was produced for the load step's cardinality gate (U4).
writeFileSync(
  join(HERE, "matrix.meta.json"),
  JSON.stringify({ seeds: N, modes: MODES.map((m) => m.mode), rows, nulls, nullsByMode, expectedRows: MODES.length * N * N }, null, 2) + "\n"
);
console.log(`[matrix] done: ${rows} rows (${nulls} null/unreachable) -> matrix.csv  expected ${MODES.length * N * N}`);
