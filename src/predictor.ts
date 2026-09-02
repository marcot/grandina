// ============================================================
// Predictor engine: combines radar metrics + AllertaMeteo alerts
// ============================================================

import { fromArrayBuffer } from 'geotiff';
import type { TypedArray } from 'geotiff';
import {
  getLatestPOH,
  getLatestVIL,
  getLatestETM,
  getLatestVMI,
  getLatestHRD,
  getLatestLightning,
  downloadProductGeoTIFF,
} from './radar-api.js';
import type {
  LastProduct,
  HailPrediction,
  HailZonePrediction,
  HailStats,
  WeatherAlert,
  AlertApiResponse,
  AlertColor,
  RiskLevel,
} from './types.js';
import {
  combinedRisk,
  computeConfidence,
  generateWarnings,
  VIL_SEVERE_THRESHOLD,
  ETM_HAIL_THRESHOLD,
  VIL_UPDRAFT_THRESHOLD,
} from './hail-metrics.js';

// ---- GeoTIFF pixel extraction ----

/**
 * Extract a value from a GeoTIFF at a given lat/lon.
 * Uses geotiff v2 readRasters() with window parameter.
 */
async function extractValueFromGeoTIFF(
  bytes: Uint8Array,
  lat: number,
  lon: number,
): Promise<number | null> {
  const tiff = await fromArrayBuffer(bytes.buffer as ArrayBuffer);
  const image = await tiff.getImage();
  const origin = image.getOrigin();
  const resolution = image.getResolution(image);

  const xOrigin = origin[0];
  const xPixelSize = resolution[0];
  const yOrigin = origin[1];
  const yPixelSize = resolution[1];

  // Convert lat/lon to pixel indices (GeoTIFFs from Radar-DPC are in EPSG:4326)
  const xIndex = Math.floor((lon - xOrigin) / xPixelSize);
  const yIndex = Math.floor((lat - yOrigin) / yPixelSize);

  if (xIndex < 0 || yIndex < 0) return null;

  try {
    // Read a single pixel using window [minX, minY, maxX, maxY]
    const result = await image.readRasters({
      window: [xIndex, yIndex, xIndex + 1, yIndex + 1],
    });

    // result is TypedArray (Float32Array, etc.)
    const arr = result as TypedArray;
    const val = Number((arr as unknown as Float32Array)[0]);
    return isFinite(val) && val >= 0 ? val : null;
  } catch {
    return null;
  }
}

/**
 * Sample a radar product at a specific lat/lon.
 * Downloads the latest product, extracts the value at the given coordinates.
 */
async function sampleRadarPoint(
  productType: string,
  lat: number,
  lon: number,
): Promise<number | null> {
  const latest = await getProductLatest(productType);
  if (!latest) return null;

  try {
    const bytes = await downloadProductGeoTIFF(productType, latest.time);
    return extractValueFromGeoTIFF(bytes, lat, lon);
  } catch (err) {
    console.error(`Failed to extract ${productType} at (${lat}, ${lon}):`, err);
    return null;
  }
}

/** Get the latest product for a given type */
async function getProductLatest(type: string): Promise<LastProduct | null> {
  switch (type) {
    case 'POH': return getLatestPOH();
    case 'VIL': return getLatestVIL();
    case 'ETM': return getLatestETM();
    case 'HRD': return getLatestHRD();
    case 'VMI': return getLatestVMI();
    case 'LTG': return getLatestLightning();
    default: return null;
  }
}

/**
 * Hail prediction for a single point.
 */
export async function hailPredict(
  lat: number,
  lon: number,
  timeRange = 120,
): Promise<HailPrediction> {
  // Sample all relevant products
  const poH = await sampleRadarPoint('POH', lat, lon);
  const vil = await sampleRadarPoint('VIL', lat, lon);
  const etm = await sampleRadarPoint('ETM', lat, lon);
  const hrD = await sampleRadarPoint('HRD', lat, lon);
  const vmi = await sampleRadarPoint('VMI', lat, lon);

  // Get the latest timestamp across all available products
  const latestProducts = [
    await getLatestPOH(),
    await getLatestVIL(),
    await getLatestETM(),
    await getLatestHRD(),
    await getLatestVMI(),
    await getLatestLightning(),
  ].filter(Boolean) as LastProduct[];

  const nearestTimestamp = latestProducts.reduce(
    (max, p) => Math.max(max, p.time),
    0,
  );

  const poHValue = poH ?? 0;
  const vilValue = vil ?? 0;
  const vmiValue = vmi ?? null;

  // Generate warnings for missing data
  const coverageWarnings: string[] = [];
  if (poH === null) coverageWarnings.push('POH data unavailable for this location');
  if (vil === null) coverageWarnings.push('VIL data unavailable for this location');
  if (etm === null) coverageWarnings.push('ETM data unavailable for this location');

  const warnings = generateWarnings(poHValue, vilValue, etm, vmiValue, coverageWarnings);

  // Compute risk metrics
  const risk = combinedRisk(poHValue, vilValue, etm) as RiskLevel;
  const confidence = computeConfidence(poHValue, vilValue ?? 0, etm, vmiValue);

  return {
    confidence,
    risk,
    poH: poHValue,
    vil: vilValue,
    etm,
    hrD,
    vmi: vmiValue,
    nearestTimestamp,
    warningLevel: null, // filled by alert integration
    warnings,
  };
}

/**
 * Sample multiple points in a radius around center and aggregate.
 */
export async function hailPredictZone(
  centerLat: number,
  centerLon: number,
  radiusKm: number,
  resolutionKm = 0.1, // 100m grid
): Promise<HailZonePrediction> {
  const steps = Math.max(1, Math.ceil(radiusKm / resolutionKm));
  const samples: HailPrediction[] = [];

  for (let i = -steps; i <= steps; i++) {
    for (let j = -steps; j <= steps; j++) {
      const dx = i * resolutionKm;
      const dy = j * resolutionKm;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist > radiusKm) continue;

      // Convert km offset to degrees (rough approximation)
      const dLat = dy / 111;
      const dLon = dx / (111 * Math.cos((centerLat * Math.PI) / 180));

      const pred = await hailPredict(centerLat + dLat, centerLon + dLon);
      samples.push(pred);
    }
  }

  const stats = computeZoneStats(samples);
  const worstRisk = samples.reduce(
    (worst, s) => {
      const order: Record<string, number> = { none: 0, low: 1, medium: 2, high: 3, extreme: 4 };
      return order[s.risk] > order[worst.risk] ? s : worst;
    },
    samples[0] ?? createEmptyPrediction(centerLat, centerLon),
  );

  return {
    ...worstRisk,
    centerLat,
    centerLon,
    radiusKm,
    samples: samples.length,
    stats,
  };
}

function createEmptyPrediction(lat: number, lon: number): HailPrediction {
  return {
    confidence: 0,
    risk: 'none',
    poH: 0,
    vil: 0,
    etm: null,
    hrD: null,
    vmi: null,
    nearestTimestamp: 0,
    warningLevel: null,
    warnings: ['No radar data available for this location'],
  };
}

function computeZoneStats(samples: HailPrediction[]): HailStats {
  const poHValues = samples.map((s) => s.poH);
  const vilValues = samples.map((s) => s.vil);
  const etmValues = samples.map((s) => s.etm).filter((v): v is number => v !== null);
  const vmiValues = samples.map((s) => s.vmi).filter((v): v is number => v !== null);

  const mean = (arr: number[]) =>
    arr.length === 0 ? 0 : arr.reduce((a, b) => a + b, 0) / arr.length;

  return {
    poH: { min: Math.min(...poHValues), max: Math.max(...poHValues), mean: mean(poHValues) },
    vil: { min: Math.min(...vilValues), max: Math.max(...vilValues), mean: mean(vilValues) },
    etm: etmValues.length > 0
      ? { min: Math.min(...etmValues), max: Math.max(...etmValues), mean: mean(etmValues) }
      : null,
    vmi: vmiValues.length > 0
      ? { min: Math.min(...vmiValues), max: Math.max(...vmiValues), mean: mean(vmiValues) }
      : null,
  };
}

// ---- AllertaMeteo integration ----

const ALERT_API = 'https://allertameteo.app';

/**
 * Fetch current weather alerts for a comune by name.
 * Uses the working /api/alert/{comune} endpoint directly.
 */
export async function alertForComune(comune: string): Promise<WeatherAlert> {
  // The /api/alert/{nome} endpoint works directly without pre-searching
  const alertRes = await fetch(
    `${ALERT_API}/api/alert/${encodeURIComponent(comune)}`,
    { headers: { Accept: 'application/json' } },
  );

  if (!alertRes.ok) {
    return {
      comune, regione: '', provincia: '', sigla: '',
      today: null, tomorrow: null, worstColor: null,
    };
  }

  const alertData = (await alertRes.json()) as AlertApiResponse;

  if (!alertData.success || !alertData.data) {
    return {
      comune, regione: '', provincia: '', sigla: '',
      today: null, tomorrow: null, worstColor: null,
    };
  }

  const data = alertData.data;
  const worstColor = findWorstColor(data.oggi, data.domani);

  return {
    comune: data.comune,
    regione: data.regione,
    provincia: data.provincia,
    sigla: data.sigla,
    today: data.oggi,
    tomorrow: data.domani,
    worstColor,
  };
}

function findWorstColor(
  oggi: WeatherAlert['today'],
  domani: WeatherAlert['tomorrow'],
): AlertColor | null {
  const levels: Record<AlertColor, number> = { green: 1, yellow: 2, orange: 3, red: 4 };
  let worst: AlertColor | null = null;

  const check = (day: WeatherAlert['today']): void => {
    if (!day) return;
    const c = day.allerta.colore as AlertColor;
    if (worst === null || levels[c] > levels[worst]) worst = c;
  };

  check(oggi);
  check(domani);

  return worst;
}