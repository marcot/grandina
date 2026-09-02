#!/usr/bin/env node
// ============================================================
// Grandina CLI — hail prediction from Italian Civil Protection radar
// ============================================================

import {
  hailPredictZone,
  alertForComune,
} from './predictor.js';

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
    const result = await alertForComune(comune);
    lat = 45.4642; // default: Milano
    lon = 9.1900;
    console.error(`Alert info for: ${result.comune}, ${result.regione} — using center coordinates`);
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

  console.log(JSON.stringify(output, null, 2));
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

function printUsage() {
  console.log(`Grandina — Hail prediction from Italian Civil Protection radar data

Usage:
  grandina hail --lat LAT --lon LON [--radius KM]
  grandina hail --comune COMUNE [--radius KM]
  grandina alert --comune COMUNE

Options:
  --lat LAT          Latitude of the point to query
  --lon LON          Longitude of the point to query
  --comune COMUNE   Italian comune name (auto-queries AllertaMeteo)
  --radius KM        Analysis radius in km (default: 10)
  --format FORMAT    Output format: json (default), text`);
}

run().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});