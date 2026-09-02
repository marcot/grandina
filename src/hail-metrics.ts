// ============================================================
// Hail metrics: scientific threshold calculations
// ============================================================

/** POH threshold for maximum CSI (Morel & Joss 2004) */
export const POH_CSI_THRESHOLD = 0.6;
/** POH threshold matching insured hail damage */
export const POH_DAMAGE_THRESHOLD = 0.8;

/** VIL thresholds */
export const VIL_UPDRAFT_THRESHOLD = 20; // kg/m² — updrafts supporting supercellular structures
export const VIL_HAIL_THRESHOLD = 40; // kg/m² — strong hail risk
export const VIL_SEVERE_THRESHOLD = 50; // kg/m² — severe hail probable

/** VIL density thresholds (kg/m³ → g/m³ internally stored as kg) */
export const VIL_DENSITY_SEVERE_THRESHOLD = 0.0035; // 3.5 g/m³ — identifies 90% severe hail cases
export const VIL_DENSITY_SLOW_THRESHOLD = 0.0039; // 3.9 g/m³ — better for slow vertical storms

/** ETM threshold for hail indication (km) */
export const ETM_HAIL_THRESHOLD = 10; // km
export const ETM_SEVERE_THRESHOLD = 12; // km

/** VMI threshold for strong storms (dBZ) */
export const VMI_STORM_THRESHOLD = 45; // dBZ
export const VMI_SEVERE_THRESHOLD = 50; // dBZ

/** POH → risk level */
export function pohRisk(poH: number): string {
  if (poH >= 0.8) return 'extreme';
  if (poH >= 0.6) return 'high';
  if (poH >= 0.4) return 'medium';
  if (poH >= 0.1) return 'low';
  return 'none';
}

/** Combined metrics → overall risk level */
export function combinedRisk(
  poH: number,
  vil: number,
  etm: number | null,
): string {
  if (poH >= 0.8 && vil > VIL_SEVERE_THRESHOLD && (etm === null || etm > ETM_SEVERE_THRESHOLD)) {
    return 'extreme';
  }
  if (poH >= 0.6 && vil > VIL_HAIL_THRESHOLD && (etm === null || etm > ETM_HAIL_THRESHOLD)) {
    return 'high';
  }
  if (poH >= 0.3 && vil > VIL_UPDRAFT_THRESHOLD) {
    return 'medium';
  }
  if (poH >= 0.1 || vil > 10) {
    return 'low';
  }
  return 'none';
}

/** Compute confidence (0–1) from metric consensus */
export function computeConfidence(
  poH: number,
  vil: number,
  etm: number | null,
  vmi: number | null,
): number {
  let score = 0;
  let factors = 0;

  // POH is the primary metric
  score += poH;
  factors += 1;

  // VIL secondary
  if (vil > VIL_SEVERE_THRESHOLD) score += 1;
  else if (vil > VIL_HAIL_THRESHOLD) score += 0.75;
  else if (vil > VIL_UPDRAFT_THRESHOLD) score += 0.5;
  else if (vil > 10) score += 0.25;
  else score += 0;
  factors += 1;

  // ETM tertiary
  if (etm !== null) {
    if (etm > ETM_SEVERE_THRESHOLD) score += 1;
    else if (etm > ETM_HAIL_THRESHOLD) score += 0.75;
    else score += 0.25;
    factors += 1;
  }

  // VMI as boost
  if (vmi !== null) {
    if (vmi > VMI_SEVERE_THRESHOLD) score += 0.5;
    else if (vmi > VMI_STORM_THRESHOLD) score += 0.3;
    else score += 0.1;
    factors += 1;
  }

  return Math.min(1, score / factors);
}

/** Generate contextual warnings based on metric values */
export function generateWarnings(
  poH: number,
  vil: number,
  etm: number | null,
  vmi: number | null,
  coverageWarnings: string[] = [],
): string[] {
  const warnings: string[] = [...coverageWarnings];

  if (poH > 0 && poH < 0.1 && vil < 10) {
    warnings.push('Radar data shows no significant hail activity in the queried area');
  }
  if (etm !== null && etm > ETM_SEVERE_THRESHOLD && vil < VIL_UPDRAFT_THRESHOLD) {
    warnings.push('High echo top detected but VIL is low — possible dry microburst or anvil');
  }
  if (vmi !== null && vmi > VMI_STORM_THRESHOLD && poH < 0.2) {
    warnings.push('High reflectivity with low POH — possible heavy rain without hail');
  }

  return warnings;
}