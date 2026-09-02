// ============================================================
// Utility functions
// ============================================================

/** Format a Unix timestamp (ms) to human-readable Italian */
export function formatTimestamp(ms: number): string {
  if (!ms) return 'N/A';
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Human-readable risk banner */
export function riskLabel(risk: string, confidence: number): string {
  const conf = Math.round(confidence * 100);
  const labels: Record<string, string> = {
    none: 'NESSUNA — nessuna attività convettiva rilevante',
    low: 'BASSO — attività convettiva debole, monitoraggio',
    medium: 'MODERATO — probabilità di grandine in aumento',
    high: 'ALTO — rischio di grandine significativo',
    extreme: 'ESTREMO — rischio grave di grandine',
  };
  return `${risk.toUpperCase()} (confidenza ${conf}%) — ${labels[risk] || 'valore sconosciuto'}`;
}

/** Format a hail prediction as a human-readable text block */
export function formatHailText(p: {
  risk: string;
  confidence: number;
  poH: number;
  vil: number;
  etm: number | null;
  vmi: number | null;
  hrD: number | null;
  warnings: string[];
  nearestTimestamp: number;
  centerLat: number;
  centerLon: number;
  radiusKm: number;
  samples: number;
  stats: {
    poH: { min: number; max: number; mean: number };
    vil: { min: number; max: number; mean: number };
    etm: { min: number; max: number; mean: number } | null;
    vmi: { min: number; max: number; mean: number } | null;
  };
}): string {
  const lines: string[] = [];
  lines.push('=== GRANDINA — previsione ===');
  lines.push(`Punto: (${p.centerLat.toFixed(4)}, ${p.centerLon.toFixed(4)})  Raggio: ${p.radiusKm} km  Campioni: ${p.samples}`);
  lines.push('');
  lines.push(`RISCHIO: ${riskLabel(p.risk, p.confidence)}`);
  lines.push('');
  lines.push('--- Metrici radar (punto centrale) ---');
  lines.push(`  POH (prob. grandine): ${p.poH.toFixed(3)}`);
  lines.push(`  VIL  (kg/m²):         ${p.vil.toFixed(1)}`);
  lines.push(`  ETM  (km):            ${p.etm === null ? 'N/D' : p.etm.toFixed(1)}`);
  lines.push(`  VMI  (dBZ):           ${p.vmi === null ? 'N/D' : p.vmi.toFixed(1)}`);
  lines.push(`  HRD:                  ${p.hrD === null ? 'N/D' : p.hrD.toFixed(1)}`);
  lines.push('');
  lines.push('--- Statistica zona ---');
  lines.push(`  POH: min ${p.stats.poH.min.toFixed(3)} / max ${p.stats.poH.max.toFixed(3)} / media ${p.stats.poH.mean.toFixed(3)}`);
  lines.push(`  VIL: min ${p.stats.vil.min.toFixed(1)} / max ${p.stats.vil.max.toFixed(1)} / media ${p.stats.vil.mean.toFixed(1)}`);
  if (p.stats.etm) lines.push(`  ETM: min ${p.stats.etm.min.toFixed(1)} / max ${p.stats.etm.max.toFixed(1)} / media ${p.stats.etm.mean.toFixed(1)}`);
  if (p.stats.vmi) lines.push(`  VMI: min ${p.stats.vmi.min.toFixed(1)} / max ${p.stats.vmi.max.toFixed(1)} / media ${p.stats.vmi.mean.toFixed(1)}`);
  lines.push('');
  lines.push(`Dati radar: ${formatTimestamp(p.nearestTimestamp)}`);
  if (p.warnings.length > 0) {
    lines.push('');
    lines.push('--- Note ---');
    for (const w of p.warnings) lines.push(`  • ${w}`);
  }
  return lines.join('\n');
}