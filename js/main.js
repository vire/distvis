import { Delaunay } from "https://cdn.jsdelivr.net/npm/d3-delaunay@6/+esm";
import { offsetKm, haversineKm } from "./geo.js";
import { fetchCells } from "./datasource.js";
import { colorFor, cssGradient, niceMaxMinutes, formatMinutes, UNREACHABLE_COLOR } from "./colors.js";

const MODE_SPEED_KMH = { car: 75, bike: 16, foot: 4.5 };

// Cap on rendered cells: a 450 km / 5 km payload is thousands of polygons, so
// the displayed grid is coarsened (uniformly sub-sampled) past this to keep
// Leaflet/Delaunay responsive. This replaces the old routing-volume cap — the
// data resolution itself is fixed by the precomputed seed grid.
const MAX_RENDER_CELLS = 2000;

// Reuse the payload for an identical re-run (toggle a setting back, re-click the
// same spot) instead of re-hitting the RPC. Keyed by mode|radius|coarse-origin;
// a server-side dataset refresh (new version id) clears the whole cache.
const routeCache = new Map();
const ROUTE_CACHE_MAX = 24;
let currentVersionId = null;

function cacheGet(key) {
  const hit = routeCache.get(key);
  if (hit) { routeCache.delete(key); routeCache.set(key, hit); }
  return hit;
}
function cacheSet(key, value) {
  routeCache.set(key, value);
  if (routeCache.size > ROUTE_CACHE_MAX) routeCache.delete(routeCache.keys().next().value);
}

// --- Map setup -------------------------------------------------------------

const map = L.map("map", { zoomControl: true }).setView([49.82, 15.47], 7); // Czech Republic
L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
}).addTo(map);
map.zoomControl.setPosition("bottomleft");

const canvasRenderer = L.canvas({ padding: 0.3 });
const cellLayer = L.layerGroup().addTo(map);
let originMarker = null;

// --- UI elements -----------------------------------------------------------

const ui = {
  panel: document.getElementById("panel"),
  minimizeBtn: document.getElementById("minimize-btn"),
  badge: document.getElementById("panel-badge"),
  badgeLabel: document.getElementById("badge-label"),
  mode: document.getElementById("mode"),
  radius: document.getElementById("radius"),
  opacity: document.getElementById("opacity"),
  status: document.getElementById("status"),
  legend: document.getElementById("legend"),
  legendBar: document.getElementById("legend-bar"),
  legendLabels: document.getElementById("legend-labels"),
  searchForm: document.getElementById("search-form"),
  searchInput: document.getElementById("search-input"),
  searchResults: document.getElementById("search-results"),
};

ui.legendBar.style.background = cssGradient();

// --- Panel collapse (minimize to a badge, mainly for phones) ----------------

const isNarrow = () => window.matchMedia("(max-width: 560px)").matches;

function collapsePanel() {
  ui.panel.classList.add("collapsed");
  ui.badge.hidden = false;
  ui.badge.setAttribute("aria-expanded", "false");
}
function expandPanel() {
  ui.panel.classList.remove("collapsed");
  ui.badge.hidden = true;
  ui.badge.setAttribute("aria-expanded", "true");
}
ui.minimizeBtn.addEventListener("click", collapsePanel);
ui.badge.addEventListener("click", expandPanel);

function setStatus(text, kind = "") {
  ui.status.textContent = text;
  ui.status.className = `status ${kind}`;
}
function fillOpacity() {
  return Number(ui.opacity.value) / 100;
}

// --- State -----------------------------------------------------------------

let origin = null;          // { lat, lng, label } — the clicked point
let abortController = null;  // cancels the in-flight computation

// --- Origin selection ------------------------------------------------------

map.on("click", (e) => setOrigin({ lat: e.latlng.lat, lng: e.latlng.lng, label: "Selected point" }));

ui.searchForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const query = ui.searchInput.value.trim();
  if (!query) return;
  setStatus("Searching…", "working");
  ui.searchResults.hidden = true;
  try {
    const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=5&q=${encodeURIComponent(query)}`;
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const results = await res.json();
    if (results.length === 0) {
      setStatus(`No results for “${query}”.`, "error");
      return;
    }
    if (results.length === 1) {
      pickSearchResult(results[0]);
      return;
    }
    ui.searchResults.innerHTML = "";
    for (const r of results) {
      const li = document.createElement("li");
      li.textContent = r.display_name;
      li.addEventListener("click", () => {
        ui.searchResults.hidden = true;
        pickSearchResult(r);
      });
      ui.searchResults.appendChild(li);
    }
    ui.searchResults.hidden = false;
    setStatus("Pick a result.");
  } catch (err) {
    setStatus(`Search failed: ${err.message}`, "error");
  }
});

function pickSearchResult(r) {
  const point = { lat: Number(r.lat), lng: Number(r.lon), label: r.display_name.split(",")[0] };
  map.flyTo([point.lat, point.lng], Math.max(map.getZoom(), 7), { duration: 0.8 });
  setOrigin(point);
}

function setOrigin(point) {
  origin = point;
  if (originMarker) originMarker.remove();
  originMarker = L.marker([point.lat, point.lng], { title: point.label })
    .addTo(map)
    .bindTooltip(point.label, { direction: "top", offset: [-15, -10] });
  ui.badgeLabel.textContent = point.label;
  if (isNarrow()) collapsePanel();
  startCompute();
}

/** Run compute() and surface any failure in the status line instead of dying silently. */
function startCompute() {
  compute().catch((err) => {
    if (err?.name === "AbortError") return;
    console.error(err);
    setStatus(`Something went wrong: ${err?.message ?? err}. Click the map or change a setting to retry.`, "error");
  });
}

// Debounce rapid setting changes so flipping through options fires one request.
let settingsTimer;
for (const el of [ui.mode, ui.radius]) {
  el.addEventListener("change", () => {
    if (!origin) return;
    clearTimeout(settingsTimer);
    settingsTimer = setTimeout(startCompute, 300);
  });
}

window.addEventListener("unhandledrejection", (e) => {
  if (e.reason?.name === "AbortError") return;
  console.error(e.reason);
  setStatus(`Unexpected error: ${e.reason?.message ?? e.reason}`, "error");
});
window.addEventListener("error", (e) => {
  setStatus(`Unexpected error: ${e.message}`, "error");
});

ui.opacity.addEventListener("input", () => {
  cellLayer.eachLayer((layer) => layer.setStyle({ fillOpacity: fillOpacity() }));
});

// --- Core: fetch precomputed cells -> voronoi -> colored cells --------------

async function compute() {
  abortController?.abort();
  const controller = new AbortController();
  abortController = controller;
  const { signal } = controller;

  const mode = ui.mode.value;
  const radiusKm = Number(ui.radius.value);

  // Identical re-runs reuse the cached payload (no RPC). Coarse origin key
  // (~100 m) collapses near-identical re-clicks; version change clears the cache.
  const key = `${mode}|${radiusKm}|${origin.lat.toFixed(3)},${origin.lng.toFixed(3)}`;
  const cached = cacheGet(key);
  if (cached) {
    renderPayload(cached, mode, radiusKm);
    return;
  }

  setStatus("Loading travel times…", "working");
  const payload = await fetchCells(origin, mode, radiusKm, { signal });
  if (signal.aborted) return;

  // Reflect which modes the active snapshot actually has (R12).
  if (payload.modes?.length) reflectModes(payload.modes);

  switch (payload.status) {
    case "ok":
      // A new dataset version invalidates every cached payload.
      if (payload.version?.id !== currentVersionId) {
        routeCache.clear();
        currentVersionId = payload.version?.id ?? null;
      }
      cacheSet(key, payload);
      renderPayload(payload, mode, radiusKm);
      return;
    case "mode_unavailable":
      clearCells();
      setStatus(`“${mode}” isn’t available in this dataset. Pick another mode.`, "error");
      return;
    case "out_of_coverage": {
      clearCells();
      const near = payload.snapMeters ? ` (nearest data ~${Math.round(payload.snapMeters / 1000)} km away)` : "";
      setStatus(`Outside coverage — choose a point inside Czechia${near}.`, "error");
      return;
    }
    case "radius_too_small":
      clearCells();
      setStatus("Radius is smaller than the data resolution — increase the radius.", "error");
      return;
    case "unavailable":
      clearCells();
      setStatus(`Data service unavailable${payload.reason ? ` (${payload.reason})` : ""}. Click the map or retry.`, "error");
      return;
    default:
      clearCells();
      setStatus("Unexpected response from the data service.", "error");
  }
}

/** Clear rendered cells and hide the legend — used by every non-ok state so a
 *  stale legend never lingers (the default arm previously forgot the legend). */
function clearCells() {
  cellLayer.clearLayers();
  ui.legend.hidden = true;
}

function reflectModes(modes) {
  for (const opt of ui.mode.options) opt.disabled = !modes.includes(opt.value);
}

/** Build a ring of off-map points one grid step beyond the returned cells so the
 *  outermost Voronoi cells stay bounded (replaces hexGrid's edge ring). */
function edgeRing(seed, cellPoints, spacingKm) {
  let maxKm = 0;
  for (const p of cellPoints) maxKm = Math.max(maxKm, haversineKm(seed, p));
  const ringKm = maxKm + spacingKm;
  // 16–128 points: enough to bound the outer cells at any radius without feeding
  // hundreds of phantom points to Delaunay at large radii.
  const n = Math.min(128, Math.max(16, Math.ceil((2 * Math.PI * ringKm) / spacingKm)));
  const ring = [];
  for (let i = 0; i < n; i++) {
    const a = (2 * Math.PI * i) / n;
    ring.push(offsetKm(seed, ringKm * Math.cos(a), ringKm * Math.sin(a)));
  }
  return ring;
}

function renderPayload(payload, mode, radiusKm) {
  const seed = payload.seed;
  const spacingKm = payload.version?.seedSpacingKm ?? 5;

  // Move the marker to the snapped seed and note how far the click was moved (R9).
  const snapKm = (payload.snapMeters ?? 0) / 1000;
  if (originMarker) {
    originMarker.setLatLng([seed.lat, seed.lng]);
    originMarker.setTooltipContent(`${origin.label}${snapKm >= 0.05 ? ` (snapped ~${snapKm.toFixed(1)} km)` : ""}`);
  }

  // Render-cost cap: coarsen the displayed grid at large radii (R10).
  const total = payload.cells.length;
  let cells = payload.cells;
  let coarsenedNote = "";
  if (total > MAX_RENDER_CELLS) {
    const step = Math.ceil(total / MAX_RENDER_CELLS);
    cells = cells.filter((_, i) => i % step === 0);
    coarsenedNote = ` (showing ${cells.length} of ${total} cells to stay responsive)`;
  }

  // Geometry strictly from the payload order: cellPoints[i] <-> seconds[i] (R8).
  const cellPoints = cells.map((c) => ({ lat: c.lat, lng: c.lng }));
  const minutes = cells.map((c) => (c.seconds == null ? null : c.seconds / 60));
  const points = [...cellPoints, ...edgeRing(seed, cellPoints, spacingKm)];

  // Color domain from the actual data (98th percentile), with a radius/mode
  // fallback when nothing is reachable.
  const domainMax = dataDomainMax(minutes) || niceMaxMinutes(((radiusKm * 1.3) / MODE_SPEED_KMH[mode]) * 60);

  // Voronoi in locally-corrected equirectangular space (cosLat from the seed).
  const cosLat = Math.cos((seed.lat * Math.PI) / 180);
  const delaunay = Delaunay.from(points, (p) => p.lng * cosLat, (p) => p.lat);
  const pad = spacingKm / 100;
  const xs = points.map((p) => p.lng * cosLat);
  const ys = points.map((p) => p.lat);
  const voronoi = delaunay.voronoi([
    Math.min(...xs) - pad, Math.min(...ys) - pad,
    Math.max(...xs) + pad, Math.max(...ys) + pad,
  ]);

  cellLayer.clearLayers();
  let built = 0;
  for (let i = 0; i < cellPoints.length; i++) {
    const polygon = voronoi.cellPolygon(i);
    if (!polygon) continue;
    const m = minutes[i];
    const latlngs = polygon.map(([x, y]) => [y, x / cosLat]);
    const layer = L.polygon(latlngs, {
      renderer: canvasRenderer,
      stroke: false,
      fillColor: m === null ? UNREACHABLE_COLOR : colorFor(m / domainMax),
      fillOpacity: fillOpacity(),
      interactive: true,
    }).addTo(cellLayer);
    layer.bindTooltip(tooltipHtml(cellPoints[i], m, seed), { sticky: true });
    built++;
  }
  if (built === 0) {
    setStatus("Could not build map cells for this area.", "error");
    return;
  }

  renderLegend(domainMax);
  const extractDate = payload.version?.extractDate;
  setStatus(
    `${total} cells from “${origin.label}” by ${mode}${coarsenedNote}` +
      `${extractDate ? ` · road data as of ${extractDate}` : ""}.`
  );
}

/** 98th-percentile minutes, rounded to a nice legend max. null if nothing reachable. */
function dataDomainMax(minutes) {
  const vals = minutes.filter((m) => m !== null).sort((a, b) => a - b);
  if (vals.length === 0) return null;
  const p98 = vals[Math.min(vals.length - 1, Math.floor(vals.length * 0.98))];
  return niceMaxMinutes(p98);
}

function tooltipHtml(point, minutes, seed) {
  const dist = haversineKm(seed, point).toFixed(0);
  if (minutes === null) return `<b>unreachable</b><br>${dist} km from origin`;
  return `<b>${formatMinutes(minutes)}</b><br>${dist} km from origin`;
}

function renderLegend(maxMinutes) {
  ui.legend.hidden = false;
  ui.legendLabels.innerHTML = "";
  for (const f of [0, 0.25, 0.5, 0.75, 1]) {
    const span = document.createElement("span");
    span.textContent = formatMinutes(maxMinutes * f) + (f === 1 ? "+" : "");
    ui.legendLabels.appendChild(span);
  }
}
