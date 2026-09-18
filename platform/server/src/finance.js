/**
 * Finance backend (ADR-0011): a read-only view over a live Firefly III
 * instance named by FIREFLY_URL. It is the console's first outbound network
 * dependency and its first stored credential, so three rules shape every
 * function here:
 *
 *   - Only GET. No write verb exists in this module, by construction.
 *   - The token never leaves the server: not in a response, a log, or an error.
 *   - A figure that cannot be computed is reported ABSENT WITH ITS REASON,
 *     never as a zero. A zero and "no data yet" mean opposite things to
 *     someone reading a finance dashboard.
 *
 * Multi-currency is structural, not an edge case: summary/basic returns
 * currency-suffixed keys and the key set is not a cartesian product. Amounts
 * in different currencies are never summed — Firefly implies no exchange rate
 * and neither may we. (`pc_*` mirror fields are not a reliable conversion:
 * observed null even when account and primary currency matched.)
 */

const API_PREFIX = '/api/v1';

export const ADVICE_NOTICE = 'Indicators to decide with, never financial advice — the detail lives in Firefly.';

export class FinanceNotConfiguredError extends Error {
  constructor() {
    super('Finance is not configured (FIREFLY_URL/FIREFLY_TOKEN unset, ADR-0011)');
    this.name = 'FinanceNotConfiguredError';
    this.status = 404;
    this.code = 'finance-not-configured';
  }
}

export class FinanceProxyRefusedError extends Error {
  constructor() {
    super('Finance is loopback-only; not served through the proxy (ADR-0011)');
    this.name = 'FinanceProxyRefusedError';
    this.status = 403;
    this.code = 'finance-proxy-refused';
  }
}

/**
 * An upstream failure. `code` is the only thing that reaches the client —
 * never the URL, never the token, never Firefly's own body.
 */
export class FireflyError extends Error {
  constructor(code, message, status = 502) {
    super(message);
    this.name = 'FireflyError';
    this.code = code;
    this.status = status;
  }
}

/* ------------------------------- absence ---------------------------------- */

/**
 * The value could not be computed. `needs` is what would unlock it, phrased
 * for the person reading the card — this is what a budget or trend card shows
 * until the data exists.
 */
export const unavailable = (reason, needs) => ({ value: null, unavailable: { reason, needs } });

const isUnavailable = (v) => v !== null && typeof v === 'object' && v.unavailable !== undefined;

/* ------------------------------ http client -------------------------------- */

function requireConfigured(config) {
  if (config.FIREFLY_URL === null || config.FIREFLY_URL === undefined) {
    throw new FinanceNotConfiguredError();
  }
}

/**
 * One GET against Firefly. Always asks for JSON: without that header Firefly's
 * web middleware answers 302 to its login page instead of 401. Redirects are
 * never followed — a 3xx here means misconfiguration, and following it would
 * hand an HTML login page to a JSON parser.
 */
async function fireflyGet(config, endpoint, { fetchImpl = fetch } = {}) {
  requireConfigured(config);
  const url = `${config.FIREFLY_URL}${API_PREFIX}${endpoint}`;
  let res;
  try {
    res = await fetchImpl(url, {
      method: 'GET',
      redirect: 'manual',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${config.FIREFLY_TOKEN}`,
      },
      signal: AbortSignal.timeout(config.FIREFLY_TIMEOUT_MS),
    });
  } catch (err) {
    const timedOut = err.name === 'TimeoutError' || err.name === 'AbortError';
    throw new FireflyError(
      timedOut ? 'firefly-timeout' : 'firefly-unreachable',
      timedOut ? 'Firefly did not answer in time' : 'Firefly is unreachable'
    );
  }
  if (res.status === 401 || res.status === 403) {
    throw new FireflyError('firefly-unauthorized', 'Firefly rejected the access token', 502);
  }
  if (res.status >= 300 && res.status < 400) {
    throw new FireflyError(
      'firefly-redirect',
      'Firefly answered a redirect instead of JSON — check FIREFLY_URL and that the token is a Personal Access Token'
    );
  }
  if (!res.ok) {
    throw new FireflyError('firefly-error', `Firefly answered ${res.status}`);
  }
  try {
    return await res.json();
  } catch {
    throw new FireflyError('firefly-bad-json', 'Firefly answered something that is not JSON');
  }
}

/* --------------------------------- cache ----------------------------------- */

/**
 * In-process TTL cache. Nothing financial is ever written to disk (ADR-0011
 * §8), so this is the only place a figure lives between requests. On an
 * upstream failure the last good entry is served with its age attached, so a
 * stale number always says it is stale instead of impersonating a fresh one.
 */
export function createFinanceCache() {
  const entries = new Map();
  return {
    async wrap(key, ttlMs, produce) {
      const now = Date.now();
      const hit = entries.get(key);
      if (hit && now - hit.fetchedAt < ttlMs) {
        return { ...hit.value, fetchedAt: new Date(hit.fetchedAt).toISOString(), stale: false };
      }
      try {
        const value = await produce();
        entries.set(key, { value, fetchedAt: now });
        return { ...value, fetchedAt: new Date(now).toISOString(), stale: false };
      } catch (err) {
        if (!hit) throw err;
        return {
          ...hit.value,
          fetchedAt: new Date(hit.fetchedAt).toISOString(),
          stale: true,
          ageMs: now - hit.fetchedAt,
          staleReason: err.code ?? 'firefly-error',
        };
      }
    },
    clear: () => entries.clear(),
  };
}

/* --------------------------------- dates ----------------------------------- */

const pad = (n) => String(n).padStart(2, '0');
const isoDay = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** The calendar month `now` falls in, plus how far through it we are. */
export function monthWindow(now = new Date()) {
  const start = new Date(now.getFullYear(), now.getMonth(), 1);
  const end = new Date(now.getFullYear(), now.getMonth() + 1, 0);
  const daysInMonth = end.getDate();
  return {
    start: isoDay(start),
    end: isoDay(end),
    dayOfMonth: now.getDate(),
    daysInMonth,
    // How much of the month has elapsed, for pacing a budget.
    elapsedFraction: now.getDate() / daysInMonth,
  };
}

/** Whole months between two ISO timestamps, counted inclusively. */
export function monthsSpanned(earliestIso, now = new Date()) {
  if (!earliestIso) return 0;
  const d = new Date(earliestIso);
  if (Number.isNaN(d.getTime())) return 0;
  return (now.getFullYear() - d.getFullYear()) * 12 + (now.getMonth() - d.getMonth()) + 1;
}

/* ------------------------------ summary parsing ---------------------------- */

const SUMMARY_KEY_RE = /^(.*)-in-([A-Z]{3})$/;

/**
 * summary/basic answers currency-suffixed keys ("net-worth-in-PEN",
 * "bills-unpaid-in-USD"). The key set is NOT a cartesian product: a metric can
 * exist for one currency and be missing for another. Group by currency and
 * keep each entry's own currency metadata rather than reading fixed names.
 * Firefly's `title` is localized by profile preference, so it is deliberately
 * dropped — the console owns its labels (ADR-0011 §12).
 */
export function parseSummary(raw) {
  const byCurrency = new Map();
  for (const [key, entry] of Object.entries(raw ?? {})) {
    const m = SUMMARY_KEY_RE.exec(key);
    if (!m || entry === null || typeof entry !== 'object') continue;
    const [, metric, code] = m;
    if (!byCurrency.has(code)) {
      byCurrency.set(code, {
        currency: {
          code,
          symbol: entry.currency_symbol ?? code,
          decimalPlaces: entry.currency_decimal_places ?? 2,
        },
        metrics: {},
      });
    }
    const value = Number(entry.monetary_value);
    byCurrency.get(code).metrics[metric] = Number.isFinite(value) ? value : null;
  }
  return [...byCurrency.values()];
}

/**
 * (earned - spent) / earned for the window. Firefly reports spending as a
 * negative number, so magnitude is taken explicitly. Undefined when nothing
 * was earned: a rate with a zero denominator is not zero, it is meaningless.
 */
export function savingsRate(metrics) {
  const earned = metrics.earned;
  const spent = metrics.spent;
  if (!Number.isFinite(earned) || !Number.isFinite(spent)) {
    return unavailable('missing-metric', 'Income and spending for the month');
  }
  if (earned <= 0) {
    return unavailable('no-income', 'Income recorded in this period');
  }
  return { value: (earned - Math.abs(spent)) / earned, unavailable: undefined };
}

/* --------------------------------- bills ----------------------------------- */

/**
 * Split the window's bills into paid / due / overdue from the explicit
 * `pay_dates` and `paid_dates` Firefly attaches — never inferred. `paid_dates`
 * entries are objects carrying their own amount and currency.
 */
export function classifyBills(data, { end, today }) {
  const bills = [];
  for (const row of data ?? []) {
    const a = row?.attributes;
    if (!a || a.active === false) continue;
    const payDates = (a.pay_dates ?? []).map((d) => String(d).slice(0, 10));
    const paidDates = (a.paid_dates ?? [])
      .map((p) => (typeof p === 'string' ? p : p?.date))
      .filter(Boolean)
      .map((d) => String(d).slice(0, 10));
    if (payDates.length === 0 && paidDates.length === 0) continue;
    const nextDue = payDates.find((d) => d >= today) ?? payDates[0] ?? null;
    const paid = paidDates.length > 0;
    bills.push({
      id: row.id,
      name: a.name ?? '(unnamed)',
      currency: {
        code: a.currency_code ?? null,
        symbol: a.currency_symbol ?? a.currency_code ?? '',
        decimalPlaces: a.currency_decimal_places ?? 2,
      },
      amountMin: Number(a.amount_min),
      amountMax: Number(a.amount_max),
      repeatFreq: a.repeat_freq ?? null,
      skip: a.skip ?? 0,
      nextDue,
      paidDates,
      status: paid ? 'paid' : nextDue !== null && nextDue < today ? 'overdue' : 'due',
    });
  }
  const order = { overdue: 0, due: 1, paid: 2 };
  bills.sort((x, y) => order[x.status] - order[y.status] || String(x.nextDue).localeCompare(String(y.nextDue)));
  return {
    bills,
    counts: {
      paid: bills.filter((b) => b.status === 'paid').length,
      due: bills.filter((b) => b.status === 'due').length,
      overdue: bills.filter((b) => b.status === 'overdue').length,
    },
    windowEnd: end,
  };
}

/* -------------------------------- budgets ---------------------------------- */

/**
 * Budget pacing: spent against limit, next to how much of the month has
 * elapsed. With no budgets configured this is not a zero — there is nothing
 * to pace against — so the whole card reports what would unlock it.
 */
export function paceBudgets(budgets, limits, window) {
  const limitFor = new Map();
  for (const row of limits ?? []) {
    const a = row?.attributes;
    if (!a) continue;
    const budgetId = String(a.budget_id ?? '');
    const amount = Number(a.amount);
    if (!budgetId || !Number.isFinite(amount)) continue;
    const prev = limitFor.get(budgetId);
    limitFor.set(budgetId, {
      amount: (prev?.amount ?? 0) + Math.abs(amount),
      currency: {
        code: a.currency_code ?? null,
        symbol: a.currency_symbol ?? a.currency_code ?? '',
        decimalPlaces: a.currency_decimal_places ?? 2,
      },
    });
  }

  const rows = [];
  for (const row of budgets ?? []) {
    const a = row?.attributes;
    if (!a || a.active === false) continue;
    const limit = limitFor.get(String(row.id));
    // Firefly reports `spent` as an array of per-currency negative sums.
    for (const s of a.spent ?? []) {
      const spent = Math.abs(Number(s.sum));
      if (!Number.isFinite(spent)) continue;
      const currency = {
        code: s.currency_code ?? null,
        symbol: s.currency_symbol ?? s.currency_code ?? '',
        decimalPlaces: s.currency_decimal_places ?? 2,
      };
      // Only pace against a limit in the same currency — never across.
      const sameCurrency = limit && limit.currency.code === currency.code ? limit : null;
      rows.push({
        id: row.id,
        name: a.name ?? '(unnamed)',
        currency,
        spent,
        limit: sameCurrency ? sameCurrency.amount : null,
        // >1 means spending faster than the month is passing.
        pace: sameCurrency && sameCurrency.amount > 0
          ? spent / sameCurrency.amount / window.elapsedFraction
          : null,
      });
    }
  }
  if (rows.length === 0) {
    return {
      budgets: unavailable('no-budgets', 'Budgets with limits configured in Firefly III'),
      elapsedFraction: window.elapsedFraction,
    };
  }
  rows.sort((x, y) => (y.pace ?? -1) - (x.pace ?? -1));
  return { budgets: rows, elapsedFraction: window.elapsedFraction };
}

/* --------------------------------- reads ----------------------------------- */

const listOf = (payload) => (Array.isArray(payload?.data) ? payload.data : []);

/** Oldest transaction date, by asking for the last page of a newest-first list. */
async function earliestTransactionDate(config, deps) {
  const head = await fireflyGet(config, '/transactions?limit=1', deps);
  const total = head?.meta?.pagination?.total ?? 0;
  if (total === 0) return { earliest: null, total: 0 };
  const last = await fireflyGet(config, `/transactions?limit=1&page=${total}`, deps);
  const date = listOf(last)[0]?.attributes?.transactions?.[0]?.date ?? null;
  return { earliest: date, total };
}

/**
 * How much history exists, which decides whether a trend can be computed at
 * all. Cheap (two requests) and cached like everything else.
 */
export async function readHistoryDepth(config, deps = {}, now = new Date()) {
  const { earliest, total } = await earliestTransactionDate(config, deps);
  const months = monthsSpanned(earliest, now);
  return {
    earliest,
    transactions: total,
    months,
    sufficient: months >= config.FINANCE_MIN_TREND_MONTHS,
    required: config.FINANCE_MIN_TREND_MONTHS,
  };
}

/** Band A + net worth: everything derivable from summary/basic for the month. */
export async function readSummary(config, deps = {}, now = new Date()) {
  const window = monthWindow(now);
  const raw = await fireflyGet(config, `/summary/basic?start=${window.start}&end=${window.end}`, deps);
  const currencies = parseSummary(raw).map((c) => ({
    ...c,
    savingsRate: savingsRate(c.metrics),
  }));
  const defaultCurrency = await fireflyGet(config, '/currencies/default', deps)
    .then((d) => d?.data?.attributes?.code ?? null)
    .catch(() => null);
  return { window, currencies, primaryCurrency: defaultCurrency, notice: ADVICE_NOTICE };
}

export async function readBills(config, deps = {}, now = new Date()) {
  const window = monthWindow(now);
  const raw = await fireflyGet(config, `/bills?start=${window.start}&end=${window.end}`, deps);
  return { window, ...classifyBills(listOf(raw), { end: window.end, today: isoDay(now) }), notice: ADVICE_NOTICE };
}

export async function readBudgets(config, deps = {}, now = new Date()) {
  const window = monthWindow(now);
  const [budgets, limits] = await Promise.all([
    fireflyGet(config, `/budgets?start=${window.start}&end=${window.end}`, deps),
    fireflyGet(config, `/budget-limits?start=${window.start}&end=${window.end}`, deps),
  ]);
  return { window, ...paceBudgets(listOf(budgets), listOf(limits), window), notice: ADVICE_NOTICE };
}

export async function readCategories(config, deps = {}, now = new Date()) {
  const window = monthWindow(now);
  const raw = await fireflyGet(
    config,
    `/insight/expense/category?start=${window.start}&end=${window.end}`,
    deps
  );
  // The insight endpoint reports a currency code but no symbol, so borrow the
  // symbol from the default currency when the codes match rather than
  // printing the bare code where an amount is expected.
  const fallback = await fireflyGet(config, '/currencies/default', deps)
    .then((d) => d?.data?.attributes ?? null)
    .catch(() => null);
  const symbolFor = (code) =>
    fallback && fallback.code === code ? fallback.symbol ?? code : code ?? '';
  const rows = (Array.isArray(raw) ? raw : [])
    .map((r) => ({
      id: r.id ?? null,
      name: r.name ?? '(uncategorized)',
      spent: Math.abs(Number(r.difference_float ?? r.difference)),
      currency: {
        code: r.currency_code ?? null,
        symbol: r.currency_symbol ?? symbolFor(r.currency_code),
        decimalPlaces: fallback?.decimal_places ?? 2,
      },
    }))
    .filter((r) => Number.isFinite(r.spent))
    .sort((a, b) => b.spent - a.spent);
  return { window, categories: rows, notice: ADVICE_NOTICE };
}

/**
 * Band B: the long-horizon indicators. Each one states what it is waiting for
 * until enough history exists — never a zero, never an empty chart that reads
 * as "you have nothing".
 */
export async function readTrends(config, deps = {}, now = new Date()) {
  const history = await readHistoryDepth(config, deps, now);
  const needs = `${config.FINANCE_MIN_TREND_MONTHS} months of transaction history (currently ${history.months})`;
  if (!history.sufficient) {
    return {
      history,
      netWorth: unavailable('insufficient-history', needs),
      monthlySpend: unavailable('insufficient-history', needs),
      runwayMonths: unavailable('insufficient-history', needs),
      notice: ADVICE_NOTICE,
    };
  }
  const window = monthWindow(now);
  const raw = await fireflyGet(
    config,
    `/chart/account/overview?start=${window.start}&end=${window.end}`,
    deps
  );
  const series = (Array.isArray(raw) ? raw : []).map((s) => ({
    label: s.label ?? '(account)',
    currencyCode: s.currency_code ?? null,
    entries: Object.entries(s.entries ?? {}).map(([date, value]) => ({ date, value: Number(value) })),
  }));
  return {
    history,
    netWorth: { value: series, unavailable: undefined },
    // Both still need a wider read than one month's chart; kept explicit
    // rather than approximated from a single window.
    monthlySpend: unavailable('not-implemented', 'A multi-month spending read (next iteration)'),
    runwayMonths: unavailable('not-implemented', 'A multi-month spending read (next iteration)'),
    notice: ADVICE_NOTICE,
  };
}

/** Reachability + version handshake, with no financial figures in it. */
export async function readFinanceStatus(config, deps = {}) {
  const raw = await fireflyGet(config, '/about', deps);
  return {
    version: raw?.data?.version ?? null,
    apiVersion: raw?.data?.api_version ?? null,
  };
}

export { fireflyGet, isUnavailable };
