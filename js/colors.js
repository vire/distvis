// Travel-time color scale: green (near) through yellow/orange/red to purple (far).

const STOPS = [
  [0.0, [34, 197, 94]],    // green
  [0.25, [234, 222, 59]],  // yellow
  [0.5, [249, 115, 22]],   // orange
  [0.75, [220, 38, 38]],   // red
  [1.0, [109, 40, 217]],   // purple
];

export const UNREACHABLE_COLOR = "#9ca3af";

/** t in [0, 1] -> css rgb() color. */
export function colorFor(t) {
  const x = Math.min(1, Math.max(0, t));
  for (let i = 1; i < STOPS.length; i++) {
    const [t1, c1] = STOPS[i];
    if (x <= t1) {
      const [t0, c0] = STOPS[i - 1];
      const f = (x - t0) / (t1 - t0);
      const rgb = c0.map((v, k) => Math.round(v + (c1[k] - v) * f));
      return `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`;
    }
  }
  return `rgb(${STOPS.at(-1)[1].join(",")})`;
}

export function cssGradient() {
  return `linear-gradient(to right, ${STOPS.map(([t, c]) => `rgb(${c.join(",")}) ${t * 100}%`).join(", ")})`;
}

/** Round a minute count up to a "nice" legend maximum. */
export function niceMaxMinutes(minutes) {
  const steps = [15, 30, 45, 60, 90, 120, 180, 240, 300, 360, 480, 600, 720, 960, 1440];
  for (const s of steps) if (minutes <= s) return s;
  return Math.ceil(minutes / 720) * 720;
}

export function formatMinutes(min) {
  if (min < 60) return `${Math.round(min)} min`;
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}
