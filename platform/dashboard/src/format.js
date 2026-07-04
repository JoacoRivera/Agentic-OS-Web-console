const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];

const asLocalDate = (isoDay) => new Date(`${isoDay}T00:00:00`);

/** '2026-07-02' → 'Jul 02' */
export function fmtDay(isoDay) {
  const d = asLocalDate(isoDay);
  return `${MONTHS[d.getMonth()]} ${String(d.getDate()).padStart(2, '0')}`;
}

/** '2026-07-02' → single-letter weekday */
export function fmtWeekdayLetter(isoDay) {
  return WEEKDAYS[asLocalDate(isoDay).getDay()];
}

/** ISO timestamp → '07/02 14:33' (local) */
export function fmtTs(iso) {
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** ISO day + N days → 'Jul 02' */
export function fmtDayPlus(isoDay, days) {
  const d = asLocalDate(isoDay);
  d.setDate(d.getDate() + days);
  return `${MONTHS[d.getMonth()]} ${String(d.getDate()).padStart(2, '0')}`;
}
