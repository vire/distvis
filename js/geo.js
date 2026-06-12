// Geographic helpers: distances and sample-point grids.

const EARTH_RADIUS_KM = 6371;
const KM_PER_DEG_LAT = 110.574;
const KM_PER_DEG_LNG_EQUATOR = 111.32;

export function haversineKm(a, b) {
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(s));
}

/** Offset a lat/lng point by east/north kilometers (small-distance approximation). */
export function offsetKm(origin, eastKm, northKm) {
  const lat = origin.lat + northKm / KM_PER_DEG_LAT;
  const lng =
    origin.lng +
    eastKm / (KM_PER_DEG_LNG_EQUATOR * Math.cos((origin.lat * Math.PI) / 180));
  return { lat, lng };
}

/**
 * Hexagonal grid of sample points centered on `origin`, covering a circle of
 * `radiusKm`. Points slightly beyond the radius (one extra ring) are included
 * and flagged `edge: true`; they participate in the Voronoi tessellation so
 * that boundary cells stay hex-sized, but are not routed or rendered.
 */
export function hexGrid(origin, radiusKm, spacingKm) {
  const points = [{ ...origin, distKm: 0, edge: false }];
  const rowStep = spacingKm * (Math.sqrt(3) / 2);
  const maxRow = Math.ceil((radiusKm + spacingKm) / rowStep);
  for (let row = -maxRow; row <= maxRow; row++) {
    const northKm = row * rowStep;
    const xOffset = row % 2 === 0 ? 0 : spacingKm / 2;
    const maxCol = Math.ceil((radiusKm + spacingKm) / spacingKm);
    for (let col = -maxCol; col <= maxCol; col++) {
      const eastKm = col * spacingKm + xOffset;
      if (row === 0 && eastKm === 0) continue;
      const distKm = Math.hypot(eastKm, northKm);
      if (distKm > radiusKm + spacingKm) continue;
      points.push({ ...offsetKm(origin, eastKm, northKm), distKm, edge: distKm > radiusKm });
    }
  }
  return points;
}
