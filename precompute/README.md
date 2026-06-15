# Precompute runbook

Offline tooling that builds the Czech travel-time matrix and loads it into your
self-hosted Postgres. **Not part of the deployed static site** — these scripts
run on a machine with Docker + Node 18+, and the outputs (`seeds.csv`,
`matrix.csv`, `*.osrm*`, the extract) are gitignored.

Pipeline: **seeds → OSRM extract/contract → build matrix → load + atomic swap**.
Launch target: 5 km spacing, **car only** — ~3,600 seeds (CZ polygon) and ~13M
ordered pairs.

## 0. Prerequisites

- Docker (for OSRM) and Node 18+ (built-in `fetch`; no npm deps).
- A reachable Postgres with PostGIS and a PostgREST in front of it (see the
  exposure model in `db/schema.sql`).
- Optional but recommended: `precompute/cz-boundary.geojson` — a simplified
  Czech outline (Polygon/MultiPolygon, lng/lat). Without it the seed grid clips
  to the bounding box only (~6,800 seeds instead of ~3,600).

## 1. Generate the seed grid (U2)

```sh
SEED_SPACING_KM=5 node seeds.mjs
```

Writes `seeds.csv` (`id,lng,lat`) and `seeds.meta.json` (carries `seedSetHash`,
`count`, `spacingKm` — consumed by the load step). Re-running with the same
inputs is deterministic: `seedSetHash` is stable.

## 2. Build the OSRM graph (car)

Download the extract (pin the dated file for a reproducible snapshot; note its
`osmosis_replication_timestamp` for `extract_date`):

```sh
mkdir -p osrm-data/car
curl -L -o czech-republic-latest.osm.pbf \
  https://download.geofabrik.de/europe/czech-republic-latest.osm.pbf
cp czech-republic-latest.osm.pbf osrm-data/car/
```

Extract + contract the car profile (CH — the documented fit for one-shot large
matrices):

```sh
docker run --rm -t -v "$PWD/osrm-data/car:/data" ghcr.io/project-osrm/osrm-backend \
  osrm-extract -p /opt/car.lua /data/czech-republic-latest.osm.pbf
docker run --rm -t -v "$PWD/osrm-data/car:/data" ghcr.io/project-osrm/osrm-backend \
  osrm-contract /data/czech-republic-latest.osrm
```

## 3. Build the matrix (U3)

Start the car routed server and stream the matrix:

```sh
docker compose up -d          # car:5000
node build-matrix.mjs         # -> matrix.csv (+ matrix.meta.json)
docker compose down
```

`build-matrix.mjs` tiles the matrix (chunks sources AND destinations), so each
request's coordinate list stays small and `--max-table-size` only needs to
exceed `SRC_BATCH + DEST_BATCH` (compose sets 8000). Unreachable pairs are
written as a blank `seconds` field (retained, never dropped — KTD5). `annotations=duration`
only (durations work on CH; distance tables would not — KTD2). Smoke-test first:
`SRC_BATCH=10 DEST_BATCH=10` against a few seeds and confirm a zero diagonal and
a plausible Prague→Brno car time before the full run.

## 4. Load + publish atomically (U4)

Apply the schema once, then load each snapshot via the staging + atomic-swap
flow (validation gate aborts a bad publish; the live snapshot is untouched on
failure):

```sh
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f ../db/schema.sql      # once
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f ../db/rpc.sql         # once (U5)
# load: COPY seeds + matrix into staging, validate, swap (see load.sql)
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
  -v extract_date="$EXTRACT_DATE" -v profile_version="$PROFILE_VERSION" \
  -f load.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f ../db/checks.sql      # assert
```

`load.sql` ends with `NOTIFY pgrst, 'reload schema'` — PostgREST caches the
schema and won't pick up the swapped tables otherwise.

## 5. Refresh (new OSM data)

Re-run steps 1–4 against a fresh extract. The atomic swap retains the prior
snapshot as `*_prev`. **Matrix-only** refresh (same grid) vs **grid-changing**
refresh (spacing/bbox/anchor changed → `seed_set_hash` differs): a grid change
swaps `seed` and `matrix` together. Rollback is the mirror rename in `load.sql`.

## 6. Secrets, exposure, monitoring

- **Never commit** the PostgREST JWT signing secret or DB owner/superuser creds
  (gitignored; the deploy uploads the repo root verbatim). `js/config.js` ships
  only the **public** anon JWT + base URL.
- Put a **reverse proxy** in front of PostgREST for TLS, a CORS allow-list
  restricted to your Pages origin, and a per-IP rate limit (the abuse control —
  KTD12).
- A recommended uptime probe on `<base>/rpc/cells_around` is the early warning
  to `git revert` the frontend swap if the data service goes down (there is no
  estimate fallback after the hard cutover — KTD9).
