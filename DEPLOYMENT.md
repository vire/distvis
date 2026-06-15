# Deploying distvis to Coolify

distvis has three pieces:

| Piece | Where it runs | Notes |
|---|---|---|
| Static frontend (`index.html`, `js/`, `css/`) | GitHub Pages **or** Coolify | A pure static site; only needs `js/config.js` pointed at the API. |
| Postgres + **PostGIS** | **Coolify** | The travel-time matrix + seed grid. |
| **PostgREST** | **Coolify** | The read-only API the browser calls. |
| Precompute (OSRM → `matrix.csv`) | **Offline / one-off** | Not hosted — run locally per `precompute/README.md`, then load into the Coolify DB. |

The always-on backend (Postgres/PostGIS + PostgREST) ships as a single
**`docker-compose.yml` at the repo root** — the file Coolify's Docker Compose
deployment looks for by default. (The `precompute/docker-compose.yml` is the
separate *offline* OSRM stack and is not deployed.)

Coolify's UI changes between versions; the resource *types* and *environment
variables* below are what matter — adapt the exact button names to your version.

## Prerequisites

- A running Coolify instance with a server/destination and a project.
- A domain (or subdomain) for the API; Coolify provisions Let's Encrypt TLS via
  its Traefik proxy.
- The precompute outputs ready locally: `precompute/seeds.csv`,
  `precompute/matrix.csv`, `precompute/seeds.meta.json` (see
  `precompute/README.md`).

## 1. Deploy the backend (recommended: Docker Compose)

1. In Coolify: **New Resource → Docker Compose**, connect this repo. Coolify uses
   the root `docker-compose.yml` by default.
2. Coolify auto-detects the `SERVICE_*` "magic" variables in the compose and
   generates them for you:
   - `SERVICE_PASSWORD_POSTGRES`, `SERVICE_USER_POSTGRES` — the database
     superuser/owner credentials.
   - `SERVICE_PASSWORD_AUTHENTICATOR` — one value injected into **both** the DB
     (to set the `authenticator` role's password on first boot) and PostgREST
     (as `PGPASSWORD`), so they always match.
   - `SERVICE_FQDN_POSTGREST_3000` — a public TLS domain routed to PostgREST's
     port 3000. This URL is your `POSTGREST_BASE`.
3. Deploy. On **first boot** the database runs, in order, the files mounted into
   `/docker-entrypoint-initdb.d`:
   - `db/schema.sql` — PostGIS, the private `dist` schema, the exposed `api`
     schema, RLS, and the `anon` role.
   - `db/rpc.sql` — the `api.cells_around` read function + grants.
   - `initdb/30-authenticator.sh` — creates the `authenticator` login role with
     the generated password and `grant anon to authenticator`.

   (These init scripts run only when the data volume is empty. Schema changes
   later are applied by hand — see Refreshing.)
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

## 3. Load the precomputed matrix

1. Build the matrix locally (Docker OSRM, car profile) per
   `precompute/README.md` → `precompute/seeds.csv` + `precompute/matrix.csv`.
2. From the `precompute/` directory, load and publish against the Coolify
   database (so `\copy` finds the CSVs), then verify. Use the DB connection
   Coolify shows for the resource:

   ```sh
   cd precompute
   psql "$COOLIFY_DB_URL" -v ON_ERROR_STOP=1 \
     -v extract_date="2026-06-14" \
     -v profile_version="osrm-5.x ch (car)" \
     -v seed_spacing_km=5 \
     -v seed_set_hash="$(jq -r .seedSetHash seeds.meta.json)" \
     -f load.sql
   psql "$COOLIFY_DB_URL" -v ON_ERROR_STOP=1 -f ../db/checks.sql
   ```

   `load.sql` ends with `NOTIFY pgrst, 'reload schema'`. If PostgREST doesn't
   pick up the swapped tables, **restart the PostgREST service in Coolify**.

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
