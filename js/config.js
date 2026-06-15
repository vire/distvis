// js/config.js — public deployment config.
//
// These values are PUBLIC by design: the read endpoint is hardened in
// db/rpc.sql (private base tables, anon may only EXECUTE the clamped RPC).
// NEVER put the PostgREST JWT signing secret or any DB owner/superuser
// credential here — this file ships verbatim to GitHub Pages (R16).

// Base URL of the PostgREST instance in front of your self-hosted Postgres
// (behind a reverse proxy that terminates TLS and restricts CORS to this site).
export const POSTGREST_BASE = "https://CHANGE-ME.example.org";

// Anonymous JWT, if your PostgREST requires one for the anon role. Leave "" if
// the anon role is reachable without a token. This is the PUBLIC anon key only.
export const ANON_JWT = "";
