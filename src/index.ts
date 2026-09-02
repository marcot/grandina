// ============================================================
// Grandina — Library entry point
// ============================================================

export {
  getLatestPOH,
  getLatestVIL,
  getLatestETM,
  getLatestHRD,
  getLatestVMI,
  getLatestLightning,
  getLatestProduct,
  downloadProduct,
  downloadGeoTIFF,
  downloadProductGeoTIFF,
  geocodeComune,
} from './radar-api.js';

export {
  hailPredict,
  hailPredictZone,
  alertForComune,
  nowcastPredict,
} from './predictor.js';

export {
  pohRisk,
  combinedRisk,
  computeConfidence,
  generateWarnings,
  POH_CSI_THRESHOLD,
  POH_DAMAGE_THRESHOLD,
  VIL_UPDRAFT_THRESHOLD,
  VIL_HAIL_THRESHOLD,
  VIL_SEVERE_THRESHOLD,
  VIL_DENSITY_SEVERE_THRESHOLD,
  VIL_DENSITY_SLOW_THRESHOLD,
  ETM_HAIL_THRESHOLD,
  ETM_SEVERE_THRESHOLD,
  VMI_STORM_THRESHOLD,
  VMI_SEVERE_THRESHOLD,
} from './hail-metrics.js';

export type {
  ApiResponse,
  LastProduct,
  DownloadProductResponse,
  HailPrediction,
  HailZonePrediction,
  HailStats,
  AlertColor,
  AlertDetail,
  AlertDay,
  AlertComuneResponse,
  AlertApiResponse,
  WeatherAlert,
  RiskLevel,
  HailProductType,
  RadarProductType,
  HailForecast,
  HailNowcast,
} from './types.js';