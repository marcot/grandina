// Projection helpers: radar raster grid <-> lat/lon <-> EPSG:3857 (mercator).
//
// Radar-DPC GeoTIFFs use a custom Transverse Mercator on WGS84:
//   origin (12.5°E, 42°N), scale 1, false easting/northing 0
// Raster is 1200 cols x 1400 rows at 1000 m/px; pixel (0,0) sits at
// projected (E=-600000 m, N=+650000 m). Pixel (col,row):
//   easting  = -600000 + col * 1000
//   northing =  650000 - row * 1000
// Leaflet draws EPSG:3857-aligned rasters without distortion, so overlay
// render output is a mercator-aligned grid whose corner bounds map 1:1 to
// the image on screen.

import proj4 from 'proj4';

export const RADAR_PROJ4 = '+proj=tmerc +lat_0=42 +lon_0=12.5 +k=1 +x_0=0 +y_0=0 +datum=WGS84 +units=m +no_defs';
export const RADAR_TIE = { eastingM: -600000, northingM: 650000 };
export const RADAR_PIXEL_M = 1000;

const R = 6378137; // EPSG:3857 sphere radius (meters)

export interface LonLat {
  lon: number;
  lat: number;
}

export interface LatLngBounds {
  north: number;
  south: number;
  east: number;
  west: number;
}

/** Raster pixel (col, row) -> radar projected meters (easting, northing). */
export function radarPixelToMeters(col: number, row: number): [number, number] {
  return [RADAR_TIE.eastingM + col * RADAR_PIXEL_M, RADAR_TIE.northingM - row * RADAR_PIXEL_M];
}

/** Radar projected meters (easting, northing) -> raster pixel (col, row), float. */
export function radarMetersToPixel(eastingM: number, northingM: number): [number, number] {
  return [(eastingM - RADAR_TIE.eastingM) / RADAR_PIXEL_M, (RADAR_TIE.northingM - northingM) / RADAR_PIXEL_M];
}

/** Radar projected meters -> WGS84 lon/lat via the tmerc inverse. */
export function radarMetersToLonLat(eastingM: number, northingM: number): LonLat {
  const [lon, lat] = proj4(RADAR_PROJ4, 'WGS84', [eastingM, northingM]);
  return { lon, lat };
}

/** WGS84 lon/lat -> radar projected meters via tmerc forward. */
export function lonLatToRadarMeters(lon: number, lat: number): [number, number] {
  const [e, n] = proj4('WGS84', RADAR_PROJ4, [lon, lat]);
  return [e, n];
}

/** WGS84 lon/lat -> EPSG:3857 meters. */
export function lonLatToMercator(lon: number, lat: number): [number, number] {
  const x = (lon * Math.PI) / 180 * R;
  const y = R * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 180 / 2));
  return [x, y];
}

/** EPSG:3857 meters -> WGS84 lon/lat. */
export function mercatorToLonLat(x: number, y: number): LonLat {
  const lon = (x / R) * 180 / Math.PI;
  const lat = (2 * Math.atan(Math.exp(y / R)) - Math.PI / 2) * 180 / Math.PI;
  return { lon, lat };
}

/**
 * Lon/lat bounds of a radar frame's footprint (from its four raster corners).
 * Used both as the Leaflet imageOverlay bounds and to size the warp grid.
 */
export function radarFrameBounds(width: number, height: number): LatLngBounds {
  const corners = [
    [0, 0],
    [width, 0],
    [0, height],
    [width, height],
  ] as const;
  let north = -Infinity;
  let south = Infinity;
  let east = -Infinity;
  let west = Infinity;
  for (const [col, row] of corners) {
    const [e, n] = radarPixelToMeters(col, row);
    const { lon, lat } = radarMetersToLonLat(e, n);
    if (lat > north) north = lat;
    if (lat < south) south = lat;
    if (lon > east) east = lon;
    if (lon < west) west = lon;
  }
  return { north, south, east, west };
}
