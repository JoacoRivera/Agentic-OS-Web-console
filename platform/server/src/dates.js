/**
 * Calendar-day helpers shared by the metrics and the workflow registry.
 * Days are `YYYY-MM-DD` strings; "today" is the local calendar day, as the
 * memory repo's Python tooling uses `date.today()`.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** A real `YYYY-MM-DD` calendar day, or null (rejects Feb 30, month 13, …). */
export function calendarDay(day) {
  if (typeof day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  const [year, month, date] = day.split('-').map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, date));
  return parsed.getUTCFullYear() === year
    && parsed.getUTCMonth() === month - 1
    && parsed.getUTCDate() === date
    ? day
    : null;
}

/** The local calendar day of `date` as `YYYY-MM-DD`. */
export function localIsoDay(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * Whole calendar days from `fromDay` to `toDay` (both valid `YYYY-MM-DD`);
 * negative when `toDay` is earlier. Counted on UTC midnights, so no DST hour
 * can shift the result.
 */
export function daysBetween(fromDay, toDay) {
  const utc = (day) => {
    const [y, m, d] = day.split('-').map(Number);
    return Date.UTC(y, m - 1, d);
  };
  return Math.round((utc(toDay) - utc(fromDay)) / DAY_MS);
}
