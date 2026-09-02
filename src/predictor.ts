// ============================================================
// Predictor engine: combines radar metrics + AllertaMeteo alerts
// ============================================================

import {
  getLatestPOH,
  getLatestVIL,
  getLatestETM,
  getLatestVMI,
  getLatestHRD,
  getLatestLightning,
  downloadProductGeoTIFF,
  loadGeoTIFFImage,
} from './radar-api.js';
import type {
  LastProduct,
  HailPrediction,
  HailZonePrediction,
  HailStats,
  HailNowcast,
  HailForecast,
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

// ---- Radar frame loading & in-memory sampling ----
//
// Each Radar-DPC product is a GeoTIFF in a projected CRS (meters). The raster
// top-left pixel (0,0) sits at projected coordinates (easting = -600 km,
// northing = +650 km) relative to the projection origin (12.5°E, 42°N), with
// 1 km per pixel. We load each product once into memory and sample pixels,
// rather than re-downloading per grid point.

interface RadarFrame {
  data: Float32Array;
  width: number;
  height: number;
  timestamp: number;
}

/** Projected-km location of the raster top-left pixel (0,0). */
const RADAR_TIE_KM = { easting: -600, northing: 650 };

/**
 * Download the latest product of a given type and parse it into an in-memory
 * frame. Returns null if the product is unavailable or fails to parse.
 */
async function loadRadarFrame(productType: string): Promise<RadarFrame | null> {
  const latest = await getProductLatest(productType);
  if (!latest) return null;
  try {
    const bytes = await downloadProductGeoTIFF(productType, latest.time);
    const image = await loadGeoTIFFImage(bytes);
    const rasters = await image.readRasters();
    const data = rasters[0] as Float32Array;
    return { data, width: image.getWidth(), height: image.getHeight(), timestamp: latest.time };
  } catch {
    return null;
  }
}

/** Load all hail-relevant products in parallel (one download each). */
async function loadAllFrames(): Promise<{
  poh: RadarFrame | null; vil: RadarFrame | null; etm: RadarFrame | null;
  hrd: RadarFrame | null; vmi: RadarFrame | null; nearestTimestamp: number;
}> {
  const [poh, vil, etm, hrd, vmi] = await Promise.all([
    loadRadarFrame('POH'),
    loadRadarFrame('VIL'),
    loadRadarFrame('ETM'),
    loadRadarFrame('HRD'),
    loadRadarFrame('VMI'),
  ]);
  const nearestTimestamp = [poh, vil, etm, hrd, vmi]
    .reduce((max, f) => Math.max(max, f ? f.timestamp : 0), 0);
  return { poh, vil, etm, hrd, vmi, nearestTimestamp };
}

/** Map a lat/lon to a raster pixel (col, row) using the projected CRS. */
function latLonToPixel(lat: number, lon: number): [number, number] {
  const [eastingKm, northingKm] = latLonToProjKm(lat, lon);
  const col = Math.round(eastingKm - RADAR_TIE_KM.easting);
  const row = Math.round(RADAR_TIE_KM.northing - northingKm);
  return [col, row];
}

/** Read the metric value at a lat/lon from an in-memory frame. */
function sampleRadarValue(frame: RadarFrame | null, lat: number, lon: number): number | null {
  if (!frame) return null;
  const [col, row] = latLonToPixel(lat, lon);
  if (col < 0 || col >= frame.width || row < 0 || row >= frame.height) return null;
  const val = frame.data[row * frame.width + col];
  return isFinite(val) && val > -9000 ? val : null;
}

/** Build a HailPrediction from preloaded frames at a single lat/lon. */
function buildPrediction(
  poh: RadarFrame | null, vil: RadarFrame | null, etm: RadarFrame | null,
  hrd: RadarFrame | null, vmi: RadarFrame | null,
  lat: number, lon: number, nearestTimestamp: number,
): HailPrediction {
  const poHraw = sampleRadarValue(poh, lat, lon);
  const vilRaw = sampleRadarValue(vil, lat, lon);
  const etmVal = sampleRadarValue(etm, lat, lon);
  const vmiVal = sampleRadarValue(vmi, lat, lon);
  const hrDVal = sampleRadarValue(hrd, lat, lon);
  const poH = poHraw ?? 0;
  const vilValue = vilRaw ?? 0;

  const coverageWarnings: string[] = [];
  if (poHraw === null) coverageWarnings.push('POH data unavailable for this location');
  if (vilRaw === null) coverageWarnings.push('VIL data unavailable for this location');
  if (etmVal === null) coverageWarnings.push('ETM data unavailable for this location');

  const warnings = generateWarnings(poH, vilValue, etmVal, vmiVal, coverageWarnings);
  const risk = combinedRisk(poH, vilValue, etmVal) as RiskLevel;
  const confidence = computeConfidence(poH, vilValue, etmVal, vmiVal);

  return {
    confidence,
    risk,
    poH,
    vil: vilValue,
    etm: etmVal,
    hrD: hrDVal,
    vmi: vmiVal,
    nearestTimestamp,
    warningLevel: null,
    warnings,
  };
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
): Promise<HailPrediction> {
  const frames = await loadAllFrames();
  if (!frames.poh && !frames.vil && !frames.etm && !frames.hrd && !frames.vmi) {
    return createEmptyPrediction(lat, lon);
  }
  return buildPrediction(frames.poh, frames.vil, frames.etm, frames.hrd, frames.vmi, lat, lon, frames.nearestTimestamp);
}

/**
 * Sample multiple points in a radius around center and aggregate.
 * Downloads each product ONCE, then samples all grid points in-memory.
 */
export async function hailPredictZone(
  centerLat: number,
  centerLon: number,
  radiusKm: number,
  resolutionKm = 1, // 1 km grid — matches radar pixel resolution
): Promise<HailZonePrediction> {
  // Load all products once (5 downloads total, in parallel)
  const frames = await loadAllFrames();
  const empty = !frames.poh && !frames.vil && !frames.etm && !frames.hrd && !frames.vmi;
  if (empty) {
    const fallback = createEmptyPrediction(centerLat, centerLon);
    return {
      ...fallback,
      centerLat,
      centerLon,
      radiusKm,
      samples: 1,
      stats: computeZoneStats([fallback]),
    };
  }

  // Sample the grid in-memory (no per-point downloads)
  const steps = Math.max(1, Math.ceil(radiusKm / resolutionKm));
  const cosLat = Math.cos((centerLat * Math.PI) / 180);
  const samples: HailPrediction[] = [];

  for (let i = -steps; i <= steps; i++) {
    for (let j = -steps; j <= steps; j++) {
      const dxKm = i * resolutionKm;
      const dyKm = j * resolutionKm;
      if (Math.sqrt(dxKm * dxKm + dyKm * dyKm) > radiusKm) continue;

      const dLat = dyKm / 111;
      const dLon = dxKm / (111 * cosLat);

      samples.push(
        buildPrediction(
          frames.poh, frames.vil, frames.etm, frames.hrd, frames.vmi,
          centerLat + dLat, centerLon + dLon, frames.nearestTimestamp,
        ),
      );
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

// ============================================================
// Nowcasting: track convective cells and extrapolate 0-60 min
// ============================================================

/** A detected convective cell with its centroid and intensity */
interface Cell {
  pixelCol: number;
  pixelRow: number;
  xKm: number; // projected X in km (UTM from radar origin)
  yKm: number; // projected Y in km
  vil: number;
}

/** Convert lat/lon to radar projection km coords */
function latLonToProjKm(lat: number, lon: number): [number, number] {
  // Radar-DPC uses Transverse Mercator: origin (12.5°E, 42°N), scale=1
  // Approx: easting ≈ (lon - 12.5) * 111 * cos(midLat) * 1000
  //          northing ≈ (lat - 42) * 111 * 1000
  const midLat = Math.cos(((lat + 42) / 2) * Math.PI / 180);
  const eastingKm = (lon - 12.5) * 111 * midLat;
  const northingKm = (lat - 42) * 111;
  return [eastingKm, northingKm];
}

/** Haversine distance in km between two lat/lon points */
function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Download N historical VIL frames, parsed with geotiff.
 * Steps back 30 min at a time from latest.
 */
async function downloadVilHistory(count: number, beforeMs: number): Promise<{ timestamp: number; data: Float32Array; rows: number; cols: number }[]> {
  const frames: { timestamp: number; data: Float32Array; rows: number; cols: number }[] = [];
  
  for (let i = 0; i < count; i++) {
    const ts = beforeMs - i * 30 * 60 * 1000; // 30 min intervals
    
    try {
      const bytes = await downloadProductGeoTIFF('VIL', ts);
      
      // Parse with geotiff (benign LZW EOI_CODE warning suppressed)
      const image = await loadGeoTIFFImage(bytes);
      const rasters = await image.readRasters();
      const data = rasters[0] as Float32Array;
      
      frames.push({ timestamp: ts, data, rows: image.getHeight(), cols: image.getWidth() });
      
      // Rate limit between requests
      if (i < count - 1) await new Promise(r => setTimeout(r, 100));
    } catch {
      // Frame not available at this timestamp, skip
      if (frames.length === 0) continue;
      break;
    }
  }
  
  return frames;
}

function extractCells(data: Float32Array, rows: number, cols: number, threshold: number = 5): Cell[] {
  const visited = new Uint8Array(rows * cols);
  const cells: Cell[] = [];
  const projectionOrigin = { eastingKm: -600, northingKm: 650 }; // top-left in km from origin
  const pixelSizeKm = 1; // 1km per pixel
  
  // Helper: projection x,y from pixel coords
  // pixel (col, row) → projection: easting = -600000 + col*1000, northing = 650000 - row*1000
  const projToKm = (col: number, row: number): [number, number] => [
    -600 + col * pixelSizeKm,
    650 - row * pixelSizeKm
  ];
  
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const idx = row * cols + col;
      if (visited[idx]) continue;
      
      const vil = data[idx];
      if (vil < threshold || vil <= -9000) continue;
      
      // Flood fill to find this cell. The seed is NOT pre-marked visited so the
      // loop counts it and expands to neighbors; marking it first would skip the
      // seed and never push any neighbors.
      const stack: [number, number][] = [[col, row]];
      let sumVil = 0;
      let sumX = 0;
      let sumY = 0;
      let count = 0;
      
      while (stack.length > 0) {
        const [c, r] = stack.pop()!;
        const ci = r * cols + c;
        if (visited[ci]) continue;
        visited[ci] = 1;
        
        const val = data[ci];
        if (val < threshold || val <= -9000) continue;
        
        sumVil += val;
        count++;
        
        const [x, y] = projToKm(c, r);
        sumX += x;
        sumY += y;
        
        // Add 8-neighbors
        for (let dr = -1; dr <= 1; dr++) {
          for (let dc = -1; dc <= 1; dc++) {
            if (dr === 0 && dc === 0) continue;
            const nr = r + dr;
            const nc = c + dc;
            if (nr >= 0 && nr < rows && nc >= 0 && nc < cols && !visited[nr * cols + nc]) {
              stack.push([nc, nr]);
            }
          }
        }
      }
      
      if (count >= 3) { // Minimum 3 pixels for a valid cell
        cells.push({
          pixelCol: Math.round(sumX - (-600)), // approximate
          pixelRow: Math.round(650 - sumY),
          xKm: sumX / count,
          yKm: sumY / count,
          vil: sumVil / count,
        });
      }
    }
  }
  
  return cells;
}

/**
 * Calculate average displacement vector between two sets of matched cells.
 * Uses nearest-neighbor matching with a distance threshold.
 */
function calcDisplacement(cells1: Cell[], cells2: Cell[]): { dxKm: number; dyKm: number; matches: number; direction: number } {
  let totalDx = 0;
  let totalDy = 0;
  let matches = 0;
  
  const thresholdKm = 15; // Max distance to consider two cells as the same
  
  for (const c2 of cells2) {
    let bestDist = Infinity;
    let bestC1: Cell | null = null;
    
    for (const c1 of cells1) {
      const dx = c2.xKm - c1.xKm;
      const dy = c2.yKm - c1.yKm;
      const dist = Math.sqrt(dx * dx + dy * dy);
      
      if (dist < thresholdKm && dist < bestDist) {
        bestDist = dist;
        bestC1 = c1;
      }
    }
    
    if (bestC1) {
      totalDx += bestC1.xKm - c2.xKm;
      totalDy += bestC1.yKm - c2.yKm;
      matches++;
    }
  }
  
  if (matches === 0) return { dxKm: 0, dyKm: 0, matches: 0, direction: 0 };
  
  const avgDx = totalDx / matches;
  const avgDy = totalDy / matches;
  const direction = (Math.atan2(avgDx, -avgDy) * 180 / Math.PI + 360) % 360;
  
  return { dxKm: avgDx, dyKm: avgDy, matches, direction };
}

/** Convert displacement direction in degrees to cardinal string */
function directionLabel(degrees: number): string {
  if (degrees < 22.5 || degrees >= 337.5) return 'N';
  if (degrees < 67.5) return 'NE';
  if (degrees < 112.5) return 'E';
  if (degrees < 157.5) return 'SE';
  if (degrees < 202.5) return 'S';
  if (degrees < 247.5) return 'SW';
  if (degrees < 292.5) return 'W';
  return 'NW';
}

/**
 * Convert a projected km coordinate back to lat/lon.
 * Inverse of latLonToProjKm, approximated.
 */
function projKmToLatLon(xKm: number, yKm: number): [number, number] {
  // Projection origin: easting=0, northing=0 at (12.5°E, 42°N)
  // easting ≈ (lon - 12.5) * 111 * cos(midLat)
  // northing ≈ (lat - 42) * 111
  const lat = 42 + yKm / 111;
  const midLat = Math.cos((lat + 42) / 2 * Math.PI / 180);
  const lon = 12.5 + xKm / (111 * midLat);
  return [lat, lon];
}

/**
 * Nowcasting: predict hail for future time horizons.
 * Downloads VIL history, tracks convective cell movement,
 * and extrapolates cells forward to estimate hail risk.
 *
 * @param centerLat - center latitude
 * @param centerLon - center longitude
 * @param radiusKm - search radius in km
 * @param horizons - array of future minutes to predict (e.g. [10, 20, 30, 45, 60])
 * @param maxFrames - number of historical frames to use for tracking
 */
export async function nowcastPredict(
  centerLat: number,
  centerLon: number,
  radiusKm: number = 50,
  horizons: number[] = [10, 20, 30, 45, 60],
  maxFrames: number = 4,
): Promise<HailNowcast> {
  const warnings: string[] = [];
  const now = Date.now();
  
  // 1. Get current radar metrics at center point
  const basePrediction = await hailPredict(centerLat, centerLon);
  
  // Short-circuit only when radar is genuinely unavailable (all products failed
  // to load). A quiet center point (no storm) is NOT a failure — nowcasting
  // should still attempt to track approaching cells in the radius.
  if (basePrediction.warnings.includes('No radar data available for this location')) {
    warnings.push('No radar data available for nowcasting');
    return {
      centerLat,
      centerLon,
      radiusKm,
      baseTimestamp: now,
      baseRisk: 'none',
      basePrediction: null,
      displacement: { kmPer30min: 0, degrees: 0, confidence: 0 },
      forecasts: horizons.map(h => ({
        forecastTime: now + h * 60 * 1000,
        minutesFromNow: h,
        risk: 'none',
        poH: 0, vil: 0, etm: null, vmi: null,
        confidence: 0,
        displacementKm: 0,
        displacementDirection: 'N/A',
      })),
      warnings,
    };
  }
  
  // 2. Download VIL history
  let frames: { timestamp: number; data: Float32Array; rows: number; cols: number }[];
  try {
    frames = await downloadVilHistory(maxFrames, now);
  } catch {
    warnings.push('Could not download VIL history for nowcasting');
    return {
      centerLat,
      centerLon,
      radiusKm,
      baseTimestamp: now,
      baseRisk: basePrediction.risk,
      basePrediction,
      displacement: { kmPer30min: 0, degrees: 0, confidence: 0 },
      forecasts: horizons.map(h => ({
        forecastTime: now + h * 60 * 1000,
        minutesFromNow: h,
        risk: basePrediction.risk,
        poH: basePrediction.poH,
        vil: basePrediction.vil,
        etm: basePrediction.etm,
        vmi: basePrediction.vmi,
        confidence: basePrediction.confidence * 0.8,
        displacementKm: 0,
        displacementDirection: 'N/A',
      })),
      warnings,
    };
  }
  
  if (frames.length < 2) {
    warnings.push('Insufficient VIL frames for nowcasting (need at least 2)');
    return {
      centerLat,
      centerLon,
      radiusKm,
      baseTimestamp: now,
      baseRisk: basePrediction.risk,
      basePrediction,
      displacement: { kmPer30min: 0, degrees: 0, confidence: 0 },
      forecasts: horizons.map(h => ({
        forecastTime: now + h * 60 * 1000,
        minutesFromNow: h,
        risk: basePrediction.risk,
        poH: basePrediction.poH,
        vil: basePrediction.vil,
        etm: basePrediction.etm,
        vmi: basePrediction.vmi,
        confidence: basePrediction.confidence * 0.7,
        displacementKm: 0,
        displacementDirection: 'N/A',
      })),
      warnings,
    };
  }
  
  // 3. Extract cells from each frame
  const allCells: Cell[][] = [];
  for (const frame of frames) {
    const cells = extractCells(frame.data, frame.rows, frame.cols, 5);
    allCells.push(cells);
  }
  
  // 4. Calculate displacement between consecutive frames
  let totalDxKm = 0;
  let totalDyKm = 0;
  let totalMatches = 0;
  const numIntervals = Math.min(frames.length - 1, 3);
  
  for (let i = 1; i <= numIntervals; i++) {
    const displacement = calcDisplacement(allCells[i - 1], allCells[i]);
    totalDxKm += displacement.dxKm;
    totalDyKm += displacement.dyKm;
    totalMatches += displacement.matches;
  }
  
  const avgDxKm = numIntervals > 0 ? totalDxKm / numIntervals : 0;
  const avgDyKm = numIntervals > 0 ? totalDyKm / numIntervals : 0;
  const speedKmPer30min = Math.sqrt(avgDxKm ** 2 + avgDyKm ** 2);
  const directionDeg = totalMatches > 0
    ? (Math.atan2(totalDxKm / numIntervals, -(totalDyKm / numIntervals)) * 180 / Math.PI + 360) % 360
    : 0;
  
  const trackingConfidence = Math.min(totalMatches / 5, 1) * (frames.length / 4);
  
  if (speedKmPer30min < 1 && speedKmPer30min > 0) {
    warnings.push('Very slow cell movement detected (< 1 km/30min) — nowcasting limited');
  }
  if (speedKmPer30min > 80) {
    warnings.push('Very fast cell movement (> 80 km/30min) — confidence reduced');
  }
  
  // 5. Convert speed to km/h
  const speedKmPerH = speedKmPer30min * 2;
  
  // 6. Extrapolate cells for each horizon
  const forecasts: HailForecast[] = [];
  
  for (const horizonMin of horizons) {
    const hoursAhead = horizonMin / 60;
    
    // Degradation factor: confidence drops with forecast time
    const timeDecay = 1 / (1 + hoursAhead * 0.5);
    
    // Extrapolate cell positions
    let projectedCells: Cell[] = [];
    
    // Use latest frame cells
    const latestCells = allCells[allCells.length - 1];
    
    for (const cell of latestCells) {
      const projX = cell.xKm + avgDxKm / 30 * horizonMin;
      const projY = cell.yKm + avgDyKm / 30 * horizonMin;
      
      // Convert to lat/lon
      const [cellLat, cellLon] = projKmToLatLon(projX, projY);
      
      // Check distance from user location
      const distToUser = haversineKm(centerLat, centerLon, cellLat, cellLon);
      
      if (distToUser <= radiusKm) {
        projectedCells.push({
          ...cell,
          xKm: projX,
          yKm: projY,
          pixelCol: Math.round(projX + 600), // approximate back to pixel
          pixelRow: Math.round(650 - projY),
        });
      }
    }
    
    // 7. Estimate risk based on projected cells in radius
    let estVil = 0;
    let estPoh = 0;
    let estVmi = 0;
    let estEtm: number | null = null;
    
    if (projectedCells.length > 0) {
      estVil = Math.max(...projectedCells.map(c => c.vil));
      estPoh = Math.min(1, estVil / 50); // rough POH estimate from VIL
      estVmi = estVil * 2.2; // rough VMI estimate
      estEtm = estVil > 20 ? 10 + (estVil - 20) / 5 : null;
    } else {
      // No cells projected to land in radius — but if base has activity,
      // some residual risk remains
      estVil = basePrediction.vil * 0.3;
      estPoh = basePrediction.poH * 0.3;
    }
    
    // Risk level
    let risk: RiskLevel = 'none';
    if (estPoh >= 0.8 || estVil >= 50) risk = 'extreme';
    else if (estPoh >= 0.6 || estVil >= 40) risk = 'high';
    else if (estPoh >= 0.3 || estVil >= 20) risk = 'medium';
    else if (estPoh > 0 || estVil > 0) risk = 'low';
    
    const confidence = basePrediction.confidence * trackingConfidence * timeDecay;
    
    forecasts.push({
      forecastTime: now + horizonMin * 60 * 1000,
      minutesFromNow: horizonMin,
      risk,
      poH: estPoh,
      vil: estVil,
      etm: estEtm,
      vmi: estVmi,
      confidence: Math.min(confidence, 1),
      displacementKm: speedKmPer30min / 30 * horizonMin,
      displacementDirection: directionLabel(directionDeg),
    });
  }
  
  return {
    centerLat,
    centerLon,
    radiusKm,
    baseTimestamp: frames[frames.length - 1].timestamp,
    baseRisk: basePrediction.risk,
    basePrediction,
    displacement: {
      kmPer30min: speedKmPer30min,
      degrees: directionDeg,
      confidence: trackingConfidence,
    },
    forecasts,
    warnings,
  };
}
