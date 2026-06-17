/**
 * Timestamp formatting shared across the app. A single `YYYY-MM-DD HH:mm`
 * format keeps every "created / saved / generated at" label consistent
 * (docs/04), instead of mixing `toLocaleString()` and ad-hoc formatters.
 *
 * Accepts a `Date`, an ISO/parseable string, or an epoch number so both
 * client-side stamps (canvas save) and server timestamps (`created_at`)
 * flow through the same path. Returns "" for missing/invalid input so
 * callers can fall back to a placeholder.
 */
export function formatTimestamp(input: Date | string | number = new Date()): string {
  const date = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(date.getTime())) return "";
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  const hh = String(date.getHours()).padStart(2, "0");
  const min = String(date.getMinutes()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd} ${hh}:${min}`;
}
