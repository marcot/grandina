// ============================================================
// Radar-DPC API client
// ============================================================

import { fromArrayBuffer } from 'geotiff';
import type { GeoTIFFImage } from 'geotiff';
import type {
  ApiResponse,
  LastProduct,
  DownloadProductResponse,
  HailProductType,
} from './types.js';

const RADAR_API = 'https://radar-api.protezionecivile.it';
const ORIGIN = 'https://radar.protezionecivile.it';

/** Round timestamp down to nearest product step (5-minute grid = 300000 ms) */
function roundDown(ms: number, stepMs = 300_000): number {
  return Math.floor(ms / stepMs) * stepMs;
}

/**
 * GET /findLastProductByType
 * Returns the latest product for a given type, or null on 404/empty.
 */
async function getLatestProductRaw(productType: string): Promise<LastProduct | null> {
  const url = `${RADAR_API}/findLastProductByType?type=${encodeURIComponent(productType)}`;
  const res = await fetch(url, {
    headers: { Accept: 'application/json', Origin: ORIGIN },
  });

  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(`Radar-DPC API error: ${res.status} ${res.statusText}`);
  }

  const data = (await res.json()) as ApiResponse;
  if (!data.lastProducts || data.lastProducts.length === 0) return null;
  return data.lastProducts[0];
}

/** Shortcut for POH */
export async function getLatestPOH(): Promise<LastProduct | null> {
  return getLatestProductRaw('POH');
}

/** Shortcut for VIL */
export async function getLatestVIL(): Promise<LastProduct | null> {
  return getLatestProductRaw('VIL');
}

/** Shortcut for ETM */
export async function getLatestETM(): Promise<LastProduct | null> {
  return getLatestProductRaw('ETM');
}

/** Shortcut for HRD */
export async function getLatestHRD(): Promise<LastProduct | null> {
  return getLatestProductRaw('HRD');
}

/** Shortcut for VMI */
export async function getLatestVMI(): Promise<LastProduct | null> {
  return getLatestProductRaw('VMI');
}

/** Shortcut for LTG (lightning) */
export async function getLatestLightning(): Promise<LastProduct | null> {
  return getLatestProductRaw('LTG');
}

/**
 * GET /findLastProductByType for any type
 */
export async function getLatestProduct(
  productType: HailProductType,
): Promise<LastProduct | null> {
  return getLatestProductRaw(productType);
}

/**
 * POST /downloadProduct
 * Returns a pre-signed S3 download URL for the given product and timestamp.
 */
export async function downloadProduct(
  productType: string,
  timestampMs: number,
): Promise<DownloadProductResponse> {
  const rounded = roundDown(timestampMs);
  const res = await fetch(`${RADAR_API}/downloadProduct`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: ORIGIN,
    },
    body: JSON.stringify({
      productType,
      productDate: rounded,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(
      `downloadProduct failed: ${res.status} ${res.statusText} — ${text}`,
    );
  }

  return (await res.json()) as DownloadProductResponse;
}

/**
 * Download a GeoTIFF from a pre-signed URL and return raw bytes.
 */
export async function downloadGeoTIFF(url: string): Promise<Uint8Array> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`GeoTIFF download failed: ${res.status} ${res.statusText}`);
  }
  return new Uint8Array(await res.arrayBuffer());
}

// The Radar-DPC LZW encoder omits the trailing EOI code, so the geotiff
// decoder runs off the buffer end and warns per strip. The data decodes
// correctly; this is a benign library message, so we silence it once.
let warnedPatched = false;
function patchLzwWarnOnce(): void {
  if (warnedPatched) return;
  warnedPatched = true;
  const original = console.warn.bind(console);
  console.warn = (...args: unknown[]): void => {
    const first = args[0];
    if (typeof first === 'string' && first.includes('EOI_CODE')) return;
    original(...args);
  };
}

/**
 * Parse a GeoTIFF byte buffer and return its (first) image, with the
 * benign LZW "EOI_CODE" decoder warning suppressed.
 */
export async function loadGeoTIFFImage(bytes: Uint8Array): Promise<GeoTIFFImage> {
  patchLzwWarnOnce();
  const tiff = await fromArrayBuffer(bytes.buffer as ArrayBuffer);
  return tiff.getImage();
}

/**
 * Download a product and return its GeoTIFF bytes.
 */
export async function downloadProductGeoTIFF(
  productType: string,
  timestampMs: number,
): Promise<Uint8Array> {
  const info = await downloadProduct(productType, timestampMs);
  return downloadGeoTIFF(info.url);
}

/**
 * Geocode an Italian comune name to [lat, lon] using Nominatim (OSM).
 * Returns null if the comune is not found.
 */
export async function geocodeComune(
  comune: string,
): Promise<[number, number] | null> {
  const q = encodeURIComponent(comune);
  const url =
    `https://nominatim.openstreetmap.org/search?q=${q}` +
    `&format=json&limit=1&countrycodes=it`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'grandina/0.1.0 (hail prediction tool)' },
  });
  if (!res.ok) return null;
  const data = (await res.json()) as Array<{ lat: string; lon: string }>;
  if (!data.length) return null;
  const [lat, lon] = [parseFloat(data[0].lat), parseFloat(data[0].lon)];
  if (isNaN(lat) || isNaN(lon)) return null;
  return [lat, lon];
}

/**
 * Get the N most recent products for a given type.
 * Uses /findLastProductByType to get the latest, then repeatedly queries
 * for earlier timestamps by stepping back 30 minutes at a time.
 */
export async function getProductsByType(
  productType: string,
  count: number,
  beforeMs = Date.now(),
): Promise<LastProduct[]> {
  const results: LastProduct[] = [];
  let cursorMs = roundDown(beforeMs);

  for (let i = 0; i < count && cursorMs > 0; i++) {
    const url = `${RADAR_API}/findLastProductByType?type=${encodeURIComponent(
      productType,
    )}`;
    const res = await fetch(url, {
      headers: { Accept: 'application/json', Origin: ORIGIN },
    });

    if (!res.ok) break;

    const data = (await res.json()) as ApiResponse;
    if (!data.lastProducts || data.lastProducts.length === 0) break;

    const latest = data.lastProducts[0];

    // Only add if before our cursor
    if (latest.time <= cursorMs) {
      results.push(latest);
      cursorMs = latest.time - 300_000; // step back 30 min
    } else {
      // No product at this cursor — go back further
      cursorMs -= 300_000;
    }

    if (results.length >= count) break;
  }

  return results;
}