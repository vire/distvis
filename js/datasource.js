// js/datasource.js — the single transport-aware module (KTD11).
//
// Calls the PostgREST `cells_around` RPC and returns the frontend's own shape.
// compute() consumes only the return value below and knows nothing about
// PostgREST, the anon JWT, or RPC parameter names — so the backend (PostgREST /
// custom API / static JSON) can be swapped by replacing this module alone.
//
// Return shape (mirrors db/rpc.sql's status-tagged document):
//   { status: "ok", seed:{lat,lng}, snapMeters, version, cells:[{lat,lng,seconds|null}] }
//   { status: "out_of_coverage", snapMeters?, version }
//   { status: "radius_too_small", seed, snapMeters, version }
//   { status: "unavailable", reason }        // service unreachable / error (no fallback — KTD9)

import { POSTGREST_BASE, ANON_JWT } from "./config.js";

export async function fetchCells(origin, radiusKm, { signal } = {}) {
  const headers = { "Content-Type": "application/json", Accept: "application/json" };
  if (ANON_JWT) {
    headers.apikey = ANON_JWT;
    headers.Authorization = `Bearer ${ANON_JWT}`;
  }
  const body = JSON.stringify({
    p_lng: origin.lng,
    p_lat: origin.lat,
    p_radius_m: radiusKm * 1000,
  });

  let res;
  try {
    res = await fetch(`${POSTGREST_BASE}/rpc/cells_around`, { method: "POST", headers, body, signal });
  } catch (err) {
    if (err.name === "AbortError") throw err; // user moved on — let compute() swallow it
    return { status: "unavailable", reason: err.message };
  }
  if (!res.ok) return { status: "unavailable", reason: `HTTP ${res.status}` };

  try {
    return await res.json();
  } catch {
    return { status: "unavailable", reason: "malformed response" };
  }
}
