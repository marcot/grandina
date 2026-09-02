// ============================================================
// Grandina Web — Fastify HTTP server
// ============================================================
// Serves the static frontend (public/) and JSON APIs on top of the grandina
// library: radar product overlays (PNG), hail zone/point prediction, 1-hour
// nowcast, AllertaMeteo alerts and comune geocoding.

import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { readFileSync } from 'node:fs';

import { alertForComune, hailPredict, hailPredictZone, loadRadarFrame, nowcastPredict } from './predictor.js';
import { getLatestProduct, geocodeComune } from './radar-api.js';
import { PRODUCT_DISPLAY, type ProductType } from './web/product-config.js';
import { overlayPngForFrame } from './web/overlay.js';
import { radarFrameBounds } from './web/projection.js';
import type { HailProductType, WeatherAlert } from './types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(__dirname, '..', 'public');
const LEAFLET_DIR = path.resolve(__dirname, '..', 'node_modules', 'leaflet', 'dist');
const VERSION = JSON.parse(readFileSync(path.resolve(__dirname, '..', 'package.json'), 'utf8')).version as string;

// Radar raster dims are fixed by the producer (1200x1400 @ 1 km); bounds only
// depend on geometry, so they are computed once.
const RADAR_BOUNDS = radarFrameBounds(1200, 1400);

const PRODUCT_TYPES: ProductType[] = ['POH', 'VIL', 'ETM', 'VMI'];

const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' } });

// ---- Static assets ---------------------------------------------------------
app.register(async (child) => {
  await child.register(fastifyStatic, { root: PUBLIC_DIR, prefix: '/' });
});
app.register(async (child) => {
  await child.register(fastifyStatic, { root: LEAFLET_DIR, prefix: '/vendor/leaflet/' });
});

// ---- Helpers ---------------------------------------------------------------
function parseFloatParam(raw: unknown, name: string, min: number, max: number, def: number): number | null {
  if (raw === undefined) return def;
  const v = Number(raw);
  if (!Number.isFinite(v) || v < min || v > max) return null;
  return v;
}

function latLonOr400(query: Record<string, unknown>): { lat: number; lon: number } | null {
  const lat = parseFloatParam(query.lat, 'lat', -90, 90, NaN);
  const lon = parseFloatParam(query.lon, 'lon', -180, 180, NaN);
  if (lat === null || lon === null || Number.isNaN(lat) || Number.isNaN(lon)) return null;
  return { lat, lon };
}

// ---- API -------------------------------------------------------------------
app.get('/health', async () => ({
  status: 'ok',
  uptimeSec: Math.round(process.uptime()),
  version: VERSION,
}));

app.get('/api/meta', async () => ({
  radarBounds: RADAR_BOUNDS,
  source: 'Radar-DPC Protezione Civile Italia',
  products: Object.fromEntries(
    PRODUCT_TYPES.map((t) => {
      const c = PRODUCT_DISPLAY[t];
      return [
        t,
        {
          label: c.label,
          unit: c.unit,
          vmin: c.vmin,
          vmax: c.vmax,
          high: c.high,
          extreme: c.extreme,
          minDetect: c.minDetect ?? null,
          stops: c.stops,
        },
      ];
    }),
  ),
}));

app.get('/api/products', async () => {
  const [poh, vil, etm, vmi] = await Promise.all(
    PRODUCT_TYPES.map((t) => getLatestProduct(t as HailProductType)),
  );
  return {
    POH: { time: poh?.time ?? null },
    VIL: { time: vil?.time ?? null },
    ETM: { time: etm?.time ?? null },
    VMI: { time: vmi?.time ?? null },
  };
});

app.get<{ Params: { type: string } }>('/api/radar/:type', async (req, reply) => {
  const type = req.params.type.toUpperCase();
  if (!PRODUCT_TYPES.includes(type as ProductType)) {
    return reply.code(404).send({ error: `Prodotto radar sconosciuto: ${req.params.type}` });
  }
  const frame = await loadRadarFrame(type);
  if (!frame) {
    return reply.code(502).send({ error: 'Prodotto radar non disponibile in questo momento' });
  }
  const buffer = overlayPngForFrame(type as ProductType, frame);
  return reply
    .header('Content-Type', 'image/png')
    .header('Cache-Control', 'public, max-age=300')
    .send(buffer);
});

app.get('/api/zone', async (req, reply) => {
  const q = req.query as Record<string, unknown>;
  const ll = latLonOr400(q);
  if (!ll) return reply.code(400).send({ error: 'lat e lon sono richiesti (lat in [-90,90], lon in [-180,180])' });
  const radius = parseFloatParam(q.radius, 'radius', 1, 200, 10);
  if (radius === null) return reply.code(400).send({ error: 'radius deve essere tra 1 e 200 km' });
  return hailPredictZone(ll.lat, ll.lon, radius, 1);
});

app.get('/api/hail', async (req, reply) => {
  const q = req.query as Record<string, unknown>;
  const ll = latLonOr400(q);
  if (!ll) return reply.code(400).send({ error: 'lat e lon sono richiesti (lat in [-90,90], lon in [-180,180])' });
  return hailPredict(ll.lat, ll.lon);
});

app.get('/api/nowcast', async (req, reply) => {
  const q = req.query as Record<string, unknown>;
  const ll = latLonOr400(q);
  if (!ll) return reply.code(400).send({ error: 'lat e lon sono richiesti (lat in [-90,90], lon in [-180,180])' });
  const radius = parseFloatParam(q.radius, 'radius', 1, 200, 50);
  if (radius === null) return reply.code(400).send({ error: 'radius deve essere tra 1 e 200 km' });
  const hoursRaw = q.hours === undefined ? 1 : Number(q.hours);
  const hours = hoursRaw === 1 || hoursRaw === 2 ? hoursRaw : null;
  if (hours === null) return reply.code(400).send({ error: 'hours deve essere 1 o 2' });
  const horizons = hours === 1
    ? [10, 20, 30, 40, 50, 60]
    : Array.from({ length: 12 }, (_, i) => (i + 1) * 10);
  return nowcastPredict(ll.lat, ll.lon, radius, horizons, 4);
});

// AllertaMeteo is third-party and rate-sensitive: cache per comune for 60 s.
const alertCache = new Map<string, { at: number; alert: WeatherAlert }>();
app.get('/api/alert', async (req, reply) => {
  const q = req.query as Record<string, unknown>;
  const comune = typeof q.comune === 'string' ? q.comune.trim() : '';
  if (!comune) return reply.code(400).send({ error: 'parametro comune richiesto' });
  const cached = alertCache.get(comune);
  if (cached && Date.now() - cached.at < 60_000) return cached.alert;
  const alert = await alertForComune(comune);
  alertCache.set(comune, { at: Date.now(), alert });
  return alert;
});

app.get('/api/geocode', async (req, reply) => {
  const q = req.query as Record<string, unknown>;
  const query = typeof q.q === 'string' ? q.q.trim() : '';
  if (!query) return reply.code(400).send({ error: 'parametro q richiesto' });
  const ll = await geocodeComune(query);
  if (!ll) return reply.code(404).send({ error: 'Comune non trovato' });
  return { lat: ll[0], lon: ll[1] };
});

app.get('/api/geocode/reverse', async (req, reply) => {
  const q = req.query as Record<string, unknown>;
  const ll = latLonOr400(q);
  if (!ll) return reply.code(400).send({ error: 'lat e lon sono richiesti' });
  const url =
    `https://nominatim.openstreetmap.org/reverse?lat=${ll.lat}&lon=${ll.lon}` +
    `&format=json&addressdetails=1&accept-language=it`;
  const res = await fetch(url, { headers: { 'User-Agent': 'grandina/0.1.0 (hail prediction tool)' } });
  if (!res.ok) return reply.code(502).send({ error: 'Reverse geocoding non disponibile' });
  const data = (await res.json()) as {
    address?: { city?: string; town?: string; village?: string; municipality?: string; county?: string };
  };
  const addr = data.address ?? {};
  const comune = addr.city ?? addr.town ?? addr.village ?? addr.municipality ?? addr.county ?? null;
  if (!comune) return reply.code(404).send({ error: 'Nessun comune individuato' });
  return { comune, lat: ll.lat, lon: ll.lon };
});

// ---- Error/not-found JSON --------------------------------------------------
app.setNotFoundHandler((_req, reply) => {
  reply.code(404).send({ error: 'Non trovato' });
});
app.setErrorHandler((err: { statusCode?: number; message?: string }, _req, reply) => {
  app.log.error(err);
  reply.code(err.statusCode ?? 500).send({ error: err.message ?? 'Errore interno' });
});

// ---- Start -----------------------------------------------------------------
const port = Number(process.env.PORT ?? 3000);
try {
  await app.listen({ port, host: '0.0.0.0' });
  app.log.info(`grandina web listening on :${port}`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
