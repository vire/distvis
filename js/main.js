import { Delaunay } from "https://cdn.jsdelivr.net/npm/d3-delaunay@6/+esm";
import { hexGrid, haversineKm } from "./geo.js";
import { fetchRoadNodes, thinNodes } from "./nodes.js";
import { travelTimes } from "./routing.js";
import { colorFor, cssGradient, niceMaxMinutes, formatMinutes, UNREACHABLE_COLOR } from "./colors.js";

const MODE_SPEED_KMH = { car: 75, bike: 16, foot: 4.5 };
const DENSITY_DIVISOR = { coarse: 8, medium: 12, fine: 18 };

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
  mode: document.getElementById("mode"),
  sampling: document.getElementById("sampling"),
  radius: document.getElementById("radius"),
  density: document.getElementById("density"),
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

function setStatus(text, kind = "") {
  ui.status.textContent = text;
  ui.status.className = `status ${kind}`;
}

function fillOpacity() {
  return Number(ui.opacity.value) / 100;
}

// --- State -----------------------------------------------------------------

let origin = null;          // { lat, lng, label }
let abortController = null; // cancels the in-flight computation

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
  compute();
}

for (const el of [ui.mode, ui.sampling, ui.radius, ui.density]) {
  el.addEventListener("change", () => { if (origin) compute(); });
}

ui.opacity.addEventListener("input", () => {
  cellLayer.eachLayer((layer) => layer.setStyle({ fillOpacity: fillOpacity() }));
});

// --- Core: sample points -> voronoi -> travel times -> colored cells --------

async function compute() {
  abortController?.abort();
  const controller = new AbortController();
  abortController = controller;
  const { signal } = controller;

  const mode = ui.mode.value;
  const radiusKm = Number(ui.radius.value);
  const spacingKm = Math.max(2, radiusKm / DENSITY_DIVISOR[ui.density.value]);
  // A point this far from any road gets its cell grayed as unreliable.
  const snapLimitMeters = Math.max(1500, spacingKm * 600);

  // Sample points: real road junctions (default) or a plain hex grid.
  let inner = null;
  let samplingUsed = ui.sampling.value;
  let samplingNote = "";
  if (samplingUsed === "nodes") {
    setStatus("Finding road junctions…", "working");
    try {
      const nodes = await fetchRoadNodes(origin, radiusKm, signal);
      if (signal.aborted) return;
      const thinned = thinNodes(nodes, origin, spacingKm);
      if (thinned.length < 12) throw new Error("too few junctions in this area");
      inner = [{ lat: origin.lat, lng: origin.lng }, ...thinned];
    } catch (err) {
      if (err.name === "AbortError") return;
      samplingUsed = "grid";
      samplingNote = " — junction lookup failed, using hex grid";
    }
  }
  const grid = hexGrid(origin, radiusKm, spacingKm);
  if (!inner) inner = grid.filter((p) => !p.edge);
  // The off-map edge ring bounds the outermost Voronoi cells in both modes.
  const points = [...inner, ...grid.filter((p) => p.edge)];

  // Conservative color domain so cells can be colored as batches arrive;
  // rescaled to the actual data once routing completes.
  let domainMax = niceMaxMinutes(((radiusKm * 1.3) / MODE_SPEED_KMH[mode]) * 60);
  renderLegend(domainMax);

  // Voronoi in locally-corrected equirectangular coordinates so cells are
  // geometrically regular (longitude degrees shrink with latitude).
  const cosLat = Math.cos((origin.lat * Math.PI) / 180);
  const delaunay = Delaunay.from(points, (p) => p.lng * cosLat, (p) => p.lat);
  const pad = spacingKm / 100; // degrees, roughly
  const xs = points.map((p) => p.lng * cosLat);
  const ys = points.map((p) => p.lat);
  const voronoi = delaunay.voronoi([
    Math.min(...xs) - pad, Math.min(...ys) - pad,
    Math.max(...xs) + pad, Math.max(...ys) + pad,
  ]);

  cellLayer.clearLayers();
  // cells[i] corresponds to inner[i] (inner points are first in `points`).
  const cells = inner.map((point, i) => {
    const polygon = voronoi.cellPolygon(i);
    if (!polygon) return { point, layer: null, minutes: null, unreliable: false, done: false };
    const latlngs = polygon.map(([x, y]) => [y, x / cosLat]);
    const layer = L.polygon(latlngs, {
      renderer: canvasRenderer,
      stroke: false,
      fillColor: UNREACHABLE_COLOR,
      fillOpacity: fillOpacity() * 0.35, // dim until its travel time arrives
      interactive: true,
    }).addTo(cellLayer);
    return { point, layer, minutes: null, unreliable: false, done: false };
  });

  const cellStyle = (cell) => ({
    fillColor: cell.minutes === null || cell.unreliable
      ? UNREACHABLE_COLOR
      : colorFor(cell.minutes / domainMax),
    fillOpacity: fillOpacity(),
  });

  const colorize = (durations, snapMeters, upTo) => {
    for (let i = 0; i < upTo; i++) {
      const cell = cells[i];
      if (!cell?.layer || cell.done) continue;
      cell.minutes = durations[i] === null ? null : durations[i] / 60;
      cell.unreliable = snapMeters[i] > snapLimitMeters;
      cell.done = true;
      cell.layer.setStyle(cellStyle(cell));
      cell.layer.bindTooltip(tooltipHtml(cell, snapMeters[i]), { sticky: true });
    }
  };

  setStatus(`Routing ${inner.length} sample points…`, "working");

  try {
    const { durations, snapMeters, source } = await travelTimes(origin, inner, mode, {
      signal,
      onProgress: (done, total, partialDurations, partialSnaps) => {
        if (signal.aborted) return;
        colorize(partialDurations, partialSnaps, done);
        setStatus(`Routing… ${done}/${total} points`, "working");
      },
    });
    if (signal.aborted) return;
    colorize(durations, snapMeters, durations.length);

    // Stretch the palette over the actual data (98th percentile dodges outliers).
    const dataMax = dataDomainMax(cells);
    if (dataMax && dataMax !== domainMax) {
      domainMax = dataMax;
      renderLegend(domainMax);
      for (const cell of cells) {
        if (cell.done && cell.layer) cell.layer.setStyle(cellStyle(cell));
      }
    }

    const sourceNote = source === "estimate"
      ? " — routing API unreachable, showing straight-line estimates"
      : "";
    const cellsNote = samplingUsed === "nodes" ? "road-junction" : "hex-grid";
    setStatus(
      `${inner.length} ${cellsNote} cells from “${origin.label}” by ${mode}${samplingNote}${sourceNote}.`,
      source === "estimate" || samplingNote ? "error" : "");
  } catch (err) {
    if (err.name !== "AbortError") setStatus(`Failed: ${err.message}`, "error");
  }
}

function dataDomainMax(cells) {
  const minutes = cells
    .filter((c) => c.done && c.minutes !== null && !c.unreliable)
    .map((c) => c.minutes)
    .sort((a, b) => a - b);
  if (minutes.length === 0) return null;
  const p98 = minutes[Math.min(minutes.length - 1, Math.floor(minutes.length * 0.98))];
  return niceMaxMinutes(p98);
}

function tooltipHtml(cell, snapM) {
  const dist = haversineKm(origin, cell.point).toFixed(0);
  if (cell.minutes === null) {
    return `<b>unreachable</b><br>${dist} km from ${origin.label}`;
  }
  if (cell.unreliable) {
    return `<b>~${formatMinutes(cell.minutes)}</b> (nearest road ${(snapM / 1000).toFixed(1)} km away)<br>${dist} km from ${origin.label}`;
  }
  return `<b>${formatMinutes(cell.minutes)}</b><br>${dist} km from ${origin.label}`;
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
