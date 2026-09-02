#!/usr/bin/env node
// ============================================================
// Grandina CLI — hail prediction from Italian Civil Protection radar
// ============================================================

import {
  hailPredictZone,
  alertForComune,
  nowcastPredict,
} from './predictor.js';
import { geocodeComune } from './radar-api.js';
import { formatHailText } from './format.js';

const args = process.argv.slice(2);

// Manual arg parser: handles multi-word values without quotes.
// e.g. --comune "Torri di Quartesolo" or --comune Torri di Quartesolo
function parseArgs(raw: string[]): Map<string, string> {
  const map = new Map<string, string>();
  const keys = new Map<string, string>(); // --foo / -f -> canonical

  for (let i = 0; i < raw.length; i++) {
    const token = raw[i];
    if (!token.startsWith('-') || token.length < 2) continue;

    // --option or -o
    const dashLen = token.startsWith('--') ? 2 : 1;
    const name = token.slice(dashLen);
    const next = raw[i + 1];

    if (next && !next.startsWith('-')) {
      // Value follows — consume all consecutive non-flag tokens as one value
      let value = '';
      let j = i + 1;
      while (j < raw.length && !raw[j].startsWith('-')) {
        value = value ? value + ' ' + raw[j] : raw[j];
        j++;
      }
      map.set(name, value);
      keys.set(name, token);
      i = j - 1;
    } else {
      map.set(name, '');
      keys.set(name, token);
    }
  }

  return map;
}

// Determine the command
let command = 'help';
let rest = args;
if (args.length > 0 && !args[0].startsWith('-')) {
  command = args[0];
  rest = args.slice(1);
}

async function run() {
  switch (command) {
    case 'hail':
      await runHail(rest);
      break;
    case 'alert':
      await runAlert(rest);
      break;
    case 'forecast':
      await runForecast(rest);
      break;
    default:
      printUsage();
  }
}

async function runHail(rawArgs: string[]) {
  const opts = parseArgs(rawArgs);
  const comune = opts.get('comune') || '';
  const latStr = opts.get('lat') || '';
  const lonStr = opts.get('lon') || '';
  const radiusStr = opts.get('radius') || '10';
  const radius = parseFloat(radiusStr) || 10;

  let lat = 0;
  let lon = 0;

  if (comune) {
    const geo = await geocodeComune(comune);
    if (!geo) {
      console.error(`Error: comune "${comune}" not found`);
      process.exit(1);
    }
    [lat, lon] = geo;
    const result = await alertForComune(comune);
    console.error(`Comune: ${result.comune}, ${result.regione} (${lat.toFixed(4)}, ${lon.toFixed(4)})`);
    console.error(`Weather alert: ${result.worstColor || 'Nessuna'}`);
  } else if (latStr && lonStr) {
    lat = parseFloat(latStr);
    lon = parseFloat(lonStr);
    if (isNaN(lat) || isNaN(lon)) {
      console.error('Error: --lat and --lon must be valid numbers');
      process.exit(1);
    }
  } else {
    console.error('Error: provide --lat --lon or --comune');
    process.exit(1);
  }

  console.error(`Predicting hail for (${lat}, ${lon}), radius: ${radius} km`);

  const startTime = Date.now();
  const prediction = await hailPredictZone(lat, lon, radius);
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  const format = opts.get('format') || 'json';

  const output = {
    prediction: {
      risk: prediction.risk,
      confidence: Math.round(prediction.confidence * 100) / 100,
      poH: prediction.poH,
      vil: prediction.vil,
      etm: prediction.etm,
      hrD: prediction.hrD,
      vmi: prediction.vmi,
      warningLevel: prediction.warningLevel,
      warnings: prediction.warnings,
      nearestTimestamp: prediction.nearestTimestamp,
    },
    zone: {
      centerLat: prediction.centerLat,
      centerLon: prediction.centerLon,
      radiusKm: prediction.radiusKm,
      samples: prediction.samples,
      stats: prediction.stats,
    },
    meta: {
      elapsedTime: `${elapsed}s`,
      timestamp: new Date().toISOString(),
    },
  };

  if (format === 'text') {
    console.log(formatHailText({
      risk: prediction.risk,
      confidence: prediction.confidence,
      poH: prediction.poH,
      vil: prediction.vil,
      etm: prediction.etm,
      vmi: prediction.vmi,
      hrD: prediction.hrD,
      warnings: prediction.warnings,
      nearestTimestamp: prediction.nearestTimestamp,
      centerLat: prediction.centerLat,
      centerLon: prediction.centerLon,
      radiusKm: prediction.radiusKm,
      samples: prediction.samples,
      stats: prediction.stats,
    }));
  } else {
    console.log(JSON.stringify(output, null, 2));
  }
}

async function runAlert(rawArgs: string[]) {
  const opts = parseArgs(rawArgs);
  const comune = opts.get('comune');

  if (!comune) {
    console.error('Error: --comune is required');
    process.exit(1);
  }

  try {
    const alert = await alertForComune(comune);

    const output = {
      comune: alert.comune,
      regione: alert.regione,
      provincia: alert.provincia,
      sigla: alert.sigla,
      today: alert.today || null,
      tomorrow: alert.tomorrow || null,
      worstColor: alert.worstColor || null,
    };

    console.log(JSON.stringify(output, null, 2));
  } catch (err: unknown) {
    console.error(`Error fetching alert: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

async function runForecast(rawArgs: string[]) {
  const opts = parseArgs(rawArgs);
  const latStr = opts.get('lat') || '';
  const lonStr = opts.get('lon') || '';
  const radiusStr = opts.get('radius') || '50';
  const hoursStr = opts.get('hours') || '1';
  const radius = parseFloat(radiusStr) || 50;
  const hours = parseFloat(hoursStr) || 1;

  if (!latStr || !lonStr) {
    console.error('Error: --lat and --lon are required for forecast');
    process.exit(1);
  }

  const lat = parseFloat(latStr);
  const lon = parseFloat(lonStr);
  if (isNaN(lat) || isNaN(lon)) {
    console.error('Error: --lat and --lon must be valid numbers');
    process.exit(1);
  }

  const horizons: number[] = [];
  for (let m = 10; m <= hours * 60; m += 10) {
    horizons.push(m);
  }

  console.error(`Nowcasting for (${lat}, ${lon}), radius: ${radius}km, horizons: ${horizons.join(', ')} min`);

  const startTime = Date.now();
  const result = await nowcastPredict(lat, lon, radius, horizons);
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  const output = {
    center: { lat, lon, radiusKm: radius },
    baseRisk: result.baseRisk,
    displacement: result.displacement,
    forecasts: result.forecasts,
    warnings: result.warnings,
    generated: new Date().toISOString(),
    elapsedSec: elapsed,
  };

  console.log(JSON.stringify(output, null, 2));
}

function printUsage() {
  console.log(`Grandina — Hail prediction from Italian Civil Protection radar data

Usage:
  grandina hail --lat LAT --lon LON [--radius KM]
  grandina hail --comune COMUNE [--radius KM]
  grandina alert --comune COMUNE
  grandina forecast --lat LAT --lon LON [--radius KM] [--hours H]

Options:
  --lat LAT          Latitude of the point to query
  --hours H          Forecast horizon in hours (default: 1, max: 2)
  --lon LON          Longitude of the point to query
  --comune COMUNE   Italian comune name (auto-queries AllertaMeteo)
  --radius KM        Analysis radius in km (default: 10)
  --format FORMAT    Output format: json (default), text`);
}

run().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});