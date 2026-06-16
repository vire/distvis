// Geographic helpers: distances and sample-point grids.

const EARTH_RADIUS_KM = 6371;
// Exported so offline tooling (precompute/seeds.mjs) shares the same earth model
// instead of duplicating the literals.
export const KM_PER_DEG_LAT = 110.574;
export const KM_PER_DEG_LNG_EQUATOR = 111.32;

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
