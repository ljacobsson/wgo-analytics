/**
 * Approximate viewer location from CloudFront's edge geolocation headers.
 * CloudFront derives them from the viewer IP; we never see or store the IP itself.
 *
 * The headers are only trusted when the request carries the secret header our CloudFront
 * distribution adds on the way to the origin. Otherwise anyone calling an origin directly
 * could forge locations. Without EDGE_SECRET (local dev) the headers are trusted as-is.
 */
export interface Geo {
  country: string | null;
  region: string | null;
  city: string | null;
  lat: number | null;
  lon: number | null;
}

export const NO_GEO: Geo = { country: null, region: null, city: null, lat: null, lon: null };
export const EDGE_HEADER = 'x-wgo-edge';

const text = (v: string | undefined, max = 120): string | null => {
  if (!v) return null;
  let s = v;
  try {
    s = decodeURIComponent(v); // CloudFront URL-encodes non-ASCII names
  } catch {
    /* use raw */
  }
  s = s.trim();
  return s ? s.slice(0, max) : null;
};

/** ~11 km: about the real precision of IP geolocation, and coarse enough not to pinpoint anyone. */
const coord = (v: string | undefined, limit: number): number | null => {
  const n = Number(v);
  return v && Number.isFinite(n) && Math.abs(n) <= limit ? Math.round(n * 10) / 10 : null;
};

export function geoFromHeaders(headers: Record<string, string | undefined> | undefined, edgeSecret = process.env.EDGE_SECRET): Geo {
  if (!headers) return NO_GEO;
  if (edgeSecret && headers[EDGE_HEADER] !== edgeSecret) return NO_GEO;
  const country = headers['cloudfront-viewer-country']?.trim().toUpperCase();
  const lat = coord(headers['cloudfront-viewer-latitude'], 90);
  const lon = coord(headers['cloudfront-viewer-longitude'], 180);
  return {
    country: country && /^[A-Z]{2}$/.test(country) ? country : null,
    region: text(headers['cloudfront-viewer-country-region-name']) ?? text(headers['cloudfront-viewer-country-region'], 8),
    city: text(headers['cloudfront-viewer-city']),
    lat: lat !== null && lon !== null ? lat : null,
    lon: lat !== null && lon !== null ? lon : null,
  };
}
