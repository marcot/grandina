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