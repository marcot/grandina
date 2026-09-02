// ============================================================
// Types: Radar-DPC API responses & internal structures
// ============================================================

/** Generic Radar-DPC API response for findLastProductByType */
export interface ApiResponse {
  total: number;
  lastProducts: LastProduct[];
}

/** Represents the latest radar product of a given type */
export interface LastProduct {
  productType: string;
  time: number; // epoch ms UTC
  period: string; // e.g. "PT5M"
}

/** Response from POST /downloadProduct — pre-signed S3 download URL */
export interface DownloadProductResponse {
  bucket: string;
  key: string;
  url: string;
  expiresSeconds: number;
}

// ---- Hail prediction types ----

export type RiskLevel = 'none' | 'low' | 'medium' | 'high' | 'extreme';

/** Single-point hail prediction result */
export interface HailPrediction {
  confidence: number; // 0–1
  risk: RiskLevel;
  poH: number; // Probability of Hail (0–1)
  vil: number; // Vertically Integrated Liquid (kg/m²)
  etm: number | null; // Echo Top Map (km)
  hrD: number | null; // Heavy Rain Detection index
  vmi: number | null; // Vertical Maximum Intensity (dBZ)
  nearestTimestamp: number; // epoch ms of the latest radar product used
  warningLevel: string | null; // allerta colore (green/yellow/orange)
  warnings: string[]; // contextual warnings (limited coverage, stale data, etc.)
}

/** Aggregate hail prediction over a radius around a center point */
export interface HailZonePrediction extends HailPrediction {
  centerLat: number;
  centerLon: number;
  radiusKm: number;
  samples: number; // number of grid points sampled
  stats: HailStats;
}

/** Min/max/mean statistics for each metric over a zone */
export interface HailStats {
  poH: { min: number; max: number; mean: number };
  vil: { min: number; max: number; mean: number };
  etm: { min: number; max: number; mean: number } | null;
  vmi: { min: number; max: number; mean: number } | null;
}

// ---- Weather alert types ----

/** Alert level color (Italian Protezione Civile convention) */
export type AlertColor = 'green' | 'yellow' | 'orange' | 'red';

/** Detail for a single hazard category within an alert */
export interface AlertDetail {
  description: string;
}

/** Today's or tomorrow's alert state */
export interface AlertDay {
  allerta: {
    colore: AlertColor;
    classe_css: string;
    icona: string;
    descrizione: string;
    livello: number;
  };
  dettagli: {
    idraulico: string;
    temporali: string;
    idrogeologico: string;
  };
}

/** AllertaMeteo single-comune response */
export interface AlertComuneResponse {
  success: true;
  data: {
    comune: string;
    zona: string;
    provincia: string;
    regione: string;
    sigla: string;
    oggi: AlertDay;
    domani: AlertDay;
  };
}

/** Generic AllertaMeteo wrapper (can be error) */
export interface AlertApiResponse {
  success: boolean;
  error?: string;
  data?: AlertComuneResponse['data'];
}

/** Weather alert for a comune */
export interface WeatherAlert {
  comune: string;
  regione: string;
  provincia: string;
  sigla: string;
  today: AlertDay | null;
  tomorrow: AlertDay | null;
  worstColor: AlertColor | null; // highest severity across both days and all hazard types
}

// ---- Nowcasting types ----

/** Forecast for a single future horizon */
export interface HailForecast {
  forecastTime: number; // epoch ms of the forecast time
  minutesFromNow: number; // minutes from current time
  risk: RiskLevel;
  poH: number;
  vil: number;
  etm: number | null;
  vmi: number | null;
  confidence: number; // degrades with time
  displacementKm: number; // estimated displacement from origin
  displacementDirection: string; // cardinal direction of cell movement
}

/** Full nowcasting result for a location */
export interface HailNowcast {
  centerLat: number;
  centerLon: number;
  radiusKm: number;
  baseTimestamp: number; // when the latest product was taken
  baseRisk: RiskLevel; // current risk
  basePrediction: HailPrediction | null;
  displacement: {
    kmPer30min: number; // average speed of convective cells
    degrees: number; // direction in degrees (0=N, 90=E, 180=S, 270=W)
    confidence: number;
  };
  forecasts: HailForecast[]; // predictions for each horizon
  warnings: string[];
}

// ---- Radar product constants ----

/** Products relevant for hail prediction */
export const HAIL_PRODUCT_TYPES = ['POH', 'VIL', 'ETM', 'HRD', 'VMI', 'LTG'] as const;
export type HailProductType = (typeof HAIL_PRODUCT_TYPES)[number];

/** Full list of supported Radar-DPC products */
export const RADAR_PRODUCT_TYPES = [
  'POH', 'VIL', 'ETM', 'HRD', 'VMI', 'LTG',
  'SRI', 'SRT1', 'TMP', 'IR_108',
  'CAPPI_1', 'CAPPI_2', 'CAPPI_3', 'CAPPI_4',
  'CAPPI_5', 'CAPPI_6', 'CAPPI_7', 'CAPPI_8',
  'CAPPI_9', 'CAPPI_10',
] as const;
export type RadarProductType = (typeof RADAR_PRODUCT_TYPES)[number];