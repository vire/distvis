# Deploying distvis to Coolify

distvis has three pieces:

| Piece | Where it runs | Notes |
|---|---|---|
| Static frontend (`index.html`, `js/`, `css/`) | GitHub Pages **or** Coolify | A pure static site; only needs `js/config.js` pointed at the API. |
| Postgres + **PostGIS** | **Coolify** | The travel-time matrix + seed grid. |
| **PostgREST** | **Coolify** | The read-only API the browser calls. |
| Precompute (OSRM → `matrix.csv`) | **One-shot batch** | Not part of serving. Runs on demand via the `precompute` profile in the root compose (or locally) to populate/refresh the DB. |

The always-on backend (Postgres/PostGIS + PostgREST) ships as a single
**`docker-compose.yml` at the repo root** — the file Coolify's Docker Compose
deployment looks for by default. The same file also carries the precompute
pipeline under a `precompute` profile, so it is **not** started on a normal
deploy. (The `precompute/docker-compose.yml` is the separate *offline* OSRM
stack for building locally.)

Coolify's UI changes between versions; the resource *types* and *environment
variables* below are what matter — adapt the exact button names to your version.

## First-time bring-up (order matters)

A fresh deploy is **blank** until the matrix is loaded — until then the RPC
returns `{status:"unavailable"}` and the map shows "data service unavailable".
The precompute is **not** in the serving path; it's the step that *populates*
production. Do this once, in order:

1. **Deploy the backend** (§1) — `db` + `postgrest` come up; the schema, RPC, and
   roles are created automatically, but `dist.matrix` is empty.
2. **Restrict CORS + rate limit** (§2) and point `js/config.js` at the API (§4).
3. **Build & load the matrix** (§3) — `docker compose --profile precompute up -d`.
   This is what makes prod usable; the API stays `unavailable` until it finishes
   (one `matrix_version` row goes `active = true`).
4. **Verify** — a central-CZ click colors the map, and `GET /seed` / `/matrix`
   return nothing (only `/rpc/cells_around` works).

After that, serving never runs OSRM or the precompute again — the matrix is a
static snapshot. **Refresh** = re-run step 3 (atomic swap, zero downtime,
previous snapshot kept as `*_prev` for rollback).

## Prerequisites

- A running Coolify instance with a server/destination and a project.
- A domain (or subdomain) for the API; Coolify provisions Let's Encrypt TLS via
  its Traefik proxy.
- Enough headroom on the Coolify host for the one-time OSRM build (the precompute
  profile downloads the ~1 GB CZ extract and `osrm-extract` needs a few GB RAM
  transiently). The matrix itself is built by the profile — you don't need any
  precompute outputs in advance. (Building locally instead is an option — see §3.)

## 1. Deploy the backend (recommended: Docker Compose)

1. In Coolify: **New Resource → Docker Compose**, connect this repo. Coolify uses
   the root `docker-compose.yml` by default.
2. Coolify auto-detects the `SERVICE_*` "magic" variables in the compose and
   generates them for you:
   - `SERVICE_PASSWORD_POSTGRES`, `SERVICE_USER_POSTGRES` — the database
     superuser/owner credentials.
   - `SERVICE_PASSWORD_AUTHENTICATOR` — one value injected into **both** the
     `db-init` reconcile and PostgREST (as `PGPASSWORD`), so they always match.
   - `SERVICE_FQDN_POSTGREST_3000` — a public TLS domain routed to PostgREST's
     port 3000. This URL is your `POSTGREST_BASE`.
3. Deploy. On **first boot** the database runs `db/schema.sql` (PostGIS, the
   private `dist` schema, the exposed `api` schema, RLS, the `anon` role) and
   `db/rpc.sql` (the `api.cells_around` function + grants) from
   `/docker-entrypoint-initdb.d`. These run only on an empty volume.

   The `authenticator` **login** role is handled separately by the `db-init`
   service, which runs on **every** deploy: it creates the role if missing and
   re-sets its password to the current `SERVICE_PASSWORD_AUTHENTICATOR`, then
   grants it `anon`. PostgREST waits for `db-init` to finish. This is what keeps
   the role's password from drifting out of sync with PostgREST (the failure
   mode where PostgREST crash-loops on `password authentication failed for user
   "authenticator"`). Later schema changes in `db/*.sql` are applied by hand —
   see Refreshing.
4. **Verify exposure** once it's up: `GET https://<api-domain>/seed` and
   `/matrix` must return nothing (404 / empty) — only `/rpc/cells_around` is
   reachable. This is the `db-schemas=api` boundary (KTD8 / code-review #13);
   make it a manual go-live check.

The compose connects PostgREST to the DB over Coolify's internal network and
supplies the password via `PGPASSWORD` (not inline in the URI), so no credential
is ever committed — the deploy secret-guard (`scripts/check-no-secrets.sh`)
enforces that.

## 2. CORS + rate limit (Traefik middleware)

The browser calls the API cross-origin, so restrict CORS to your frontend origin
and add a per-IP rate limit (the abuse control — KTD12). In Coolify, add **custom
Traefik labels** to the PostgREST service:

```
traefik.http.middlewares.distvis-cors.headers.accesscontrolalloworiginlist=https://<your-frontend-origin>
traefik.http.middlewares.distvis-cors.headers.accesscontrolallowmethods=POST,GET,OPTIONS
traefik.http.middlewares.distvis-cors.headers.accesscontrolallowheaders=content-type,apikey,authorization
traefik.http.middlewares.distvis-ratelimit.ratelimit.average=20
traefik.http.middlewares.distvis-ratelimit.ratelimit.burst=40
traefik.http.routers.<router-name>.middlewares=distvis-cors,distvis-ratelimit
```

Replace `<your-frontend-origin>` with the GitHub Pages origin (or the Coolify
frontend domain from step 4) and `<router-name>` with the router Coolify
generated for the PostgREST service. CORS is defense-in-depth; the real boundary
is the RPC hardening in `db/rpc.sql`.

## 3. Build & load the matrix (precompute profile)

The matrix build is a **one-shot batch job** baked into the same compose under
the `precompute` profile — so it does **not** run on a normal deploy. Trigger it
on demand from the Coolify resource's **terminal** (or a Coolify Scheduled Task
for periodic refreshes):

```sh
# Detached so the one-shots run to completion without tearing down db/postgrest.
# Chain: download CZ extract → osrm-extract+contract → serve → seeds.mjs +
# build-matrix.mjs → load.sql + checks.sql.
docker compose --profile precompute up -d
docker compose logs -f precompute-load   # watch until it exits 0 ("U5 RPC checks passed")

# Then free the OSRM server's RAM (db + postgrest stay running):
docker compose stop osrm-routed
```

> Don't use `--abort-on-container-exit` here — it would stop the always-on `db`
> and `postgrest` when the load step finishes. Detached `up -d` lets the one-shot
> steps exit on their own while the production services keep serving.

What happens, and why it's safe to leave in the production compose:

- The OSM extract, contracted graph, and CSV outputs persist in named volumes
  (`osrm-graph`, `precompute-out`), so re-runs skip the download/extract.
- The Node step writes to the shared `precompute-out` volume; the load step
  (Postgres image) runs `load.sql` against the live `db` **as the DB owner**
  (the staging + atomic swap need owner privileges) and then `db/checks.sql`.
- `load.sql` ends with `NOTIFY pgrst, 'reload schema'`. If PostgREST doesn't pick
  up the swapped tables, **restart the PostgREST service in Coolify**.

To refresh later, re-run the same command (optionally set `EXTRACT_DATE` on the
`precompute-load` service to the extract's real date; it defaults to the run
date). Delete the `osrm-graph` volume first if you want a fresh OSM download.

> Prefer to build locally instead? The same scripts run on your machine via
> `precompute/docker-compose.yml` (OSRM) + `node seeds.mjs && node
> build-matrix.mjs`, then `psql … -f precompute/load.sql` against the Coolify DB.
> See `precompute/README.md`.

## 4. Frontend

**Option A — GitHub Pages (recommended).** Leave the frontend on Pages. Set
`POSTGREST_BASE` in `js/config.js` to the Coolify API domain and set the step-2
CORS origin to the Pages URL.

**Option B — host on Coolify too.** New Resource → Application → **Static** build
pack (or a small `nginx` Dockerfile), source = this repo, publish directory =
repo root. Assign a domain; set `POSTGREST_BASE` to the API domain and the CORS
origin to this frontend domain.

Either way, `js/config.js` ships only the **public** base URL and anon JWT.

## 5. Refreshing the data

Re-run the precompute against a fresh OSM extract, then re-run step 3. `load.sql`
stages, validates, and atomically swaps the new snapshot in (retaining the
previous as `*_prev` for rollback) — no API downtime. (Schema/function changes
in `db/*.sql` are applied by hand against the running DB; the initdb scripts only
run on a fresh volume.)

## Secrets

Database password, `authenticator` password, and any `PGRST_JWT_SECRET` live
**only** in Coolify (generated by the `SERVICE_*` magic variables or set as env
vars) — never in the repo. `scripts/check-no-secrets.sh` runs in the GitHub Pages
deploy and fails the build if a credential is committed.

## Monitoring (R20)

Because the hard cutover removed the estimate fallback, an API outage shows a
blank map. Point a Coolify health check (or an external uptime probe) at a known
RPC call — a `POST` to `https://<api-domain>/rpc/cells_around` with a central-CZ
point — and alert on non-200 / timeout. The recovery action is a `git revert` of
the frontend cutover commit (it restores the prior live-OSRM site).
