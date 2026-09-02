// ============================================================
// Radar-DPC API client
// ============================================================

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