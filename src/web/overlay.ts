// Radar overlay renderer: warp a product frame (custom TM grid) into an
// EPSG:3857-aligned PNG at 1 km/px, colormapped with alpha.
//
// Correct overlay alignment on Leaflet requires an output raster whose rows
// are lines of constant mercator y and columns constant mercator x — Leaflet
// then draws it 1:1 between the projected corner bounds. We compute the
// output grid from the frame's footprint mercator bbox and back-project each
// output pixel to a source raster pixel (tmerc forward).
//
// Cost control: a full 1500x1500 warp is ~2.3M proj4 conversions (~7 s). We
// sample the projection on a control grid every 8 px (~35k conversions) and
// bilinearly interpolate source coordinates in between. TM curvature error
// over an 8 km cell is < 100 m, i.e. sub-pixel at 1 km resolution.

import { PNG } from 'pngjs';
import colormapData from './colormaps.json' with { type: 'json' };
import { RADAR_PROJ4 } from './projection.js';
import proj4 from 'proj4';
import type { RadarFrame } from '../predictor.js';
import { PRODUCT_DISPLAY, type ProductType } from './product-config.js';
import {
  lonLatToMercator,
  mercatorToLonLat,
  radarFrameBounds,
  radarMetersToPixel,
} from './projection.js';

type RGB = readonly [number, number, number];
const LUTS = colormapData as unknown as Record<ProductType, RGB[]>;

const GRID_STEP = 8; // control-grid spacing in px (bilinear interpolation span)
const MAX_DIM = 2000; // output size cap (bound memory & render time)
const PIXEL_M = 1000;

/**
 * Warp one product frame into a 3857-aligned RGBA PNG buffer.
 * Values that are nodata (<= -9000), out of frame, or below the product's
 * minDetect floor are left transparent; opacity otherwise scales with
 * intensity (alpha = 255 * t^0.75), so weak echoes stay subtle.
 */
export function renderOverlayPng(type: ProductType, frame: RadarFrame): Buffer {
  const cfg = PRODUCT_DISPLAY[type];
  const lut = LUTS[type];

  // Footprint mercator bbox (mercator x/y are separable in lon/lat, so the
  // lat/lon-aligned bounds map to an axis-aligned mercator rectangle).
  const bounds = radarFrameBounds(frame.width, frame.height);
  const xmin = lonLatToMercator(bounds.west, bounds.north)[0];
  const xmax = lonLatToMercator(bounds.east, bounds.north)[0];
  const ymin = lonLatToMercator(bounds.west, bounds.south)[1];
  const ymax = lonLatToMercator(bounds.west, bounds.north)[1];
  const nx = Math.min(Math.round((xmax - xmin) / PIXEL_M), MAX_DIM);
  const ny = Math.min(Math.round((ymax - ymin) / PIXEL_M), MAX_DIM);
  if (nx <= 0 || ny <= 0) throw new Error('empty radar footprint');

  // Control points along each axis: 0, GRID_STEP, ... plus the final pixel.
  const controlPositions = (n: number): number[] => {
    const pos: number[] = [];
    for (let p = 0; p < n; p += GRID_STEP) pos.push(p);
    if (pos[pos.length - 1] !== n - 1) pos.push(n - 1);
    return pos;
  };
  const cols = controlPositions(nx);
  const rows = controlPositions(ny);
  const cw = cols.length;
  const ch = rows.length;

  // Per control point: projected source pixel (col, row) as floats.
  const srcCol = new Float32Array(cw * ch);
  const srcRow = new Float32Array(cw * ch);
  for (let j = 0; j < ch; j++) {
    const lat = mercatorToLonLat(0, ymin + (rows[j] + 0.5) * PIXEL_M).lat;
    for (let i = 0; i < cw; i++) {
      const lon = mercatorToLonLat(xmin + (cols[i] + 0.5) * PIXEL_M, 0).lon;
      const [e, n] = proj4('WGS84', RADAR_PROJ4, [lon, lat]);
      const [c, r] = radarMetersToPixel(e, n);
      srcCol[j * cw + i] = c;
      srcRow[j * cw + i] = r;
    }
  }

  const png = new PNG({ width: nx, height: ny });
  const out = png.data;
  const fdata = frame.data;
  const fw = frame.width;
  const fh = frame.height;
  const { vmin, vmax, convert, minDetect } = cfg;

  for (let y = 0; y < ny; y++) {
    const kyj = Math.min(Math.floor(y / GRID_STEP), ch - 2);
    const segY = rows[kyj + 1] - rows[kyj];
    const v = segY > 0 ? (y - rows[kyj]) / segY : 0;
    const rowBase = kyj * cw;
    const rowNext = (kyj + 1) * cw;
    for (let x = 0; x < nx; x++) {
      const kxi = Math.min(Math.floor(x / GRID_STEP), cw - 2);
      const segX = cols[kxi + 1] - cols[kxi];
      const u = segX > 0 ? (x - cols[kxi]) / segX : 0;
      const w00 = (1 - u) * (1 - v);
      const w10 = u * (1 - v);
      const w01 = (1 - u) * v;
      const w11 = u * v;
      const colF = srcCol[rowBase + kxi] * w00 + srcCol[rowBase + kxi + 1] * w10
        + srcCol[rowNext + kxi] * w01 + srcCol[rowNext + kxi + 1] * w11;
      const rowF = srcRow[rowBase + kxi] * w00 + srcRow[rowBase + kxi + 1] * w10
        + srcRow[rowNext + kxi] * w01 + srcRow[rowNext + kxi + 1] * w11;
      const c = Math.round(colF);
      const r = Math.round(rowF);
      if (c < 0 || c >= fw || r < 0 || r >= fh) continue;
      let val = fdata[r * fw + c];
      if (!Number.isFinite(val) || val <= -9000) continue;
      if (convert) val = convert(val);
      if (minDetect !== undefined && val < minDetect) continue;
      const t = (val - vmin) / (vmax - vmin);
      const tc = t < 0 ? 0 : t > 1 ? 1 : t;
      const rgb = lut[Math.floor(tc * 255.999)];
      const o = (y * nx + x) * 4;
      out[o] = rgb[0];
      out[o + 1] = rgb[1];
      out[o + 2] = rgb[2];
      // L'intensità governa anche l'opacità: i valori deboli restano quasi
      // trasparenti, quelli forti pieni (gamma 0.75 per la leggibilità).
      out[o + 3] = Math.round(255 * Math.pow(tc, 0.75));
    }
  }

  return PNG.sync.write(png);
}

// PNG cache: one rendered buffer per product, invalidated when the frame
// timestamp changes. Frame data itself is cached upstream in predictor.ts.
const pngCache = new Map<ProductType, { ts: number; buffer: Buffer }>();

/** Render (or return cached) PNG for a product's latest frame. */
export function overlayPngForFrame(type: ProductType, frame: RadarFrame): Buffer {
  const cached = pngCache.get(type);
  if (cached && cached.ts === frame.timestamp) return cached.buffer;
  const buffer = renderOverlayPng(type, frame);
  pngCache.set(type, { ts: frame.timestamp, buffer });
  return buffer;
}
