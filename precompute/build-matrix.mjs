// precompute/build-matrix.mjs
// Build the full seed-to-seed duration matrix from a SELF-HOSTED OSRM (U3).
//
// Reads precompute/seeds.csv (id,lng,lat in file order) and queries the local
// car osrm-routed `table` service, streaming results to precompute/matrix.csv
// as `origin_id,dest_id,seconds` (seconds blank = unreachable, retained per
// KTD5; COPY reads a blank field as NULL).
//
// Batching: the matrix is TILED — both sources and destinations are chunked, so
// each request's coordinate list is at most SRC_BATCH+DEST_BATCH points. This
// avoids the oversized-URL problem of a single `destinations=all` request over
// thousands of seeds (a refinement of the plan's batching sketch). Consequently
// osrm-routed only needs `--max-table-size >= SRC_BATCH+DEST_BATCH`.
//
// Prereq: the car osrm-routed server is up (see docker-compose.yml /
// README). Run:  node build-matrix.mjs

import { readFileSync, createWriteStream, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { once } from "node:events";

const HERE = dirname(fileURLToPath(import.meta.url));

// Single car OSRM endpoint (one single-profile osrm-routed).
const OSRM_BASE = process.env.OSRM_CAR ?? "http://localhost:5000";
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
console.log(`[matrix] ${N} seeds, tiles ${SRC_BATCH}x${DEST_BATCH}, car only`);

// --- Backpressure-aware CSV sink --------------------------------------------
const out = createWriteStream(join(HERE, "matrix.csv"));
async function emit(line) {
  if (!out.write(line)) await once(out, "drain");
}

async function osrmTableTile(base, srcSeeds, destSeeds, signal) {
  const coords = [...srcSeeds, ...destSeeds].map((p) => `${p.lng.toFixed(6)},${p.lat.toFixed(6)}`).join(";");
  const sources = srcSeeds.map((_, i) => i).join(";");
  // Destinations occupy coord indices [srcSeeds.length .. srcSeeds.length+destSeeds.length).
  // Must iterate destSeeds, not srcSeeds — on a ragged final tile the lengths differ.
  const destinations = destSeeds.map((_, i) => srcSeeds.length + i).join(";");
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
for (let s = 0; s < N; s += SRC_BATCH) {
  const srcSeeds = seeds.slice(s, s + SRC_BATCH);
  for (let d = 0; d < N; d += DEST_BATCH) {
    const destSeeds = seeds.slice(d, d + DEST_BATCH);
    const durations = await withRetry((sig) => osrmTableTile(OSRM_BASE, srcSeeds, destSeeds, sig));
    for (let i = 0; i < srcSeeds.length; i++) {
      const row = durations[i];
      let chunk = "";
      for (let j = 0; j < destSeeds.length; j++) {
        const v = row[j];
        // Force an exact 0 on the diagonal: OSRM's self-distance can round to a
        // small non-zero, which would trip load.sql's zero-diagonal gate.
        let seconds;
        if (srcSeeds[i].id === destSeeds[j].id) seconds = "0";
        else if (v == null) { nulls++; seconds = ""; }
        else seconds = String(Math.round(v));
        chunk += `${srcSeeds[i].id},${destSeeds[j].id},${seconds}\n`;
      }
      await emit(chunk);
      rows += destSeeds.length;
    }
  }
  process.stdout.write(`\r[matrix] sources ${Math.min(s + SRC_BATCH, N)}/${N}   `);
}
console.log();

out.end();
await once(out, "finish");

// Record what was produced for the load step's cardinality gate (U4).
writeFileSync(
  join(HERE, "matrix.meta.json"),
  JSON.stringify({ seeds: N, rows, nulls, expectedRows: N * N }, null, 2) + "\n"
);
console.log(`[matrix] done: ${rows} rows (${nulls} null/unreachable) -> matrix.csv  expected ${N * N}`);
