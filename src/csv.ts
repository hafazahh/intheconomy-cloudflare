/**
 * CSV helpers — port of `_csv_safe()` from `app.py`.
 */

/**
 * Neutralise spreadsheet formula injection.
 *
 * Excel/Sheets treat a cell starting with = + - @ as a formula. Prefixing with
 * an apostrophe keeps the value as text. Values here come from the World Bank
 * API (numbers), so this is defence in depth rather than a live hole.
 */
export function csvSafe(value: unknown): string {
  const text = value === null || value === undefined ? "" : String(value);
  return text[0] === "=" || text[0] === "+" || text[0] === "-" || text[0] === "@"
    ? `'${text}`
    : text;
}
