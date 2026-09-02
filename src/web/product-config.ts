// Display configuration for radar products — single source used by the
// overlay renderer (server) and the legend/risk UI (client via /api/meta).
// Values mirror the scientific thresholds in hail-metrics.ts and the display
// ranges historically used by create_radar_anim.py.

export type ProductType = 'POH' | 'VIL' | 'ETM' | 'VMI';

export interface ProductDisplay {
  label: string;
  unit: string;
  vmin: number;
  vmax: number;
  /** Risk thresholds: value at/above -> HIGH / EXTREME in single-metric terms. */
  high: number;
  extreme: number;
  /** Value transform before display (ETM raw raster is meters -> km). */
  convert?: (v: number) => number;
  /** Values below this are not rendered (VMI noise floor). */
  minDetect?: number;
  /** matplotlib colormap name used to generate src/web/colormaps.json. */
  colormap: string;
  /** 5-stop approximation of that colormap (legend gradient + fallback LUT). */
  stops: [string, string, string, string, string];
  format: (v: number) => string;
}

export const PRODUCT_DISPLAY: Record<ProductType, ProductDisplay> = {
  POH: {
    label: 'Probabilità di grandine',
    unit: '',
    vmin: 0,
    vmax: 1,
    high: 0.6,
    extreme: 0.8,
    colormap: 'Purples',
    stops: ['#f7fcfd', '#bfd3e6', '#8c96c6', '#88419d', '#3f007d'],
    format: (v) => `${Math.round(v * 100)}%`,
  },
  VIL: {
    label: 'Contenuto d’acqua (VIL)',
    unit: 'kg/m²',
    vmin: 0,
    vmax: 100,
    high: 40,
    extreme: 50,
    colormap: 'YlOrRd',
    stops: ['#ffffcc', '#fed976', '#fd8d3c', '#e31a1c', '#800026'],
    format: (v) => `${v.toFixed(1)} kg/m²`,
  },
  ETM: {
    label: 'Altezza eco (ETM)',
    unit: 'km',
    vmin: 0,
    vmax: 15,
    high: 10,
    extreme: 12,
    convert: (v) => v / 1000,
    colormap: 'RdYlBu_r',
    stops: ['#4575b4', '#91bfdb', '#fee090', '#fc8d59', '#d73027'],
    format: (v) => `${v.toFixed(1)} km`,
  },
  VMI: {
    label: 'Intensità verticale (VMI)',
    unit: 'dBZ',
    vmin: 0,
    vmax: 70,
    high: 50,
    extreme: 55,
    minDetect: 10,
    colormap: 'YlOrBr',
    stops: ['#ffffd4', '#feb24c', '#fc4e2a', '#bd0026', '#800026'],
    format: (v) => `${v.toFixed(0)} dBZ`,
  },
};

import type { RiskLevel } from '../types.js';

/** UI color per risk level (matches python risk_color mapping). */
export const RISK_COLORS: Record<RiskLevel, string> = {
  none: '#4ade80',
  low: '#fbbf24',
  medium: '#fb923c',
  high: '#f43f5e',
  extreme: '#c026d3',
};

/** UI label per risk level (Italian). */
export const RISK_LABELS: Record<RiskLevel, string> = {
  none: 'Nessun rischio',
  low: 'Rischio basso',
  medium: 'Rischio moderato',
  high: 'Rischio alto',
  extreme: 'Rischio estremo',
};
