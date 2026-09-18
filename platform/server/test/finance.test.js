import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { createConfig } from '../src/config.js';
import {
  createFinanceCache,
  parseSummary,
  savingsRate,
  classifyBills,
  paceBudgets,
  monthWindow,
  monthsSpanned,
  readTrends,
  FireflyError,
} from '../src/finance.js';

// ADR-0011: every figure below is invented and served by a fake Firefly on
// loopback. The tests never touch the live instance, even though it is
// reachable from the machine they run on.
const TOKEN = 'fake-pat-'.padEnd(64, 'z');
const PROXY_SECRET = 'test-proxy-secret-'.padEnd(40, 'x');

const SUMMARY_FIXTURE = {
  'balance-in-PEN': { key: 'balance-in-PEN', monetary_value: 1500.5, currency_code: 'PEN', currency_symbol: 'S/', currency_decimal_places: 2, title: 'Saldo (S/)' },
  'earned-in-PEN': { key: 'earned-in-PEN', monetary_value: 4000, currency_code: 'PEN', currency_symbol: 'S/', currency_decimal_places: 2 },
  'spent-in-PEN': { key: 'spent-in-PEN', monetary_value: -2500, currency_code: 'PEN', currency_symbol: 'S/', currency_decimal_places: 2 },
  'net-worth-in-PEN': { key: 'net-worth-in-PEN', monetary_value: 12000, currency_code: 'PEN', currency_symbol: 'S/', currency_decimal_places: 2 },
  // Deliberately partial: USD carries only one metric, as the live shape does.
  'bills-unpaid-in-USD': { key: 'bills-unpaid-in-USD', monetary_value: 30, currency_code: 'USD', currency_symbol: '$', currency_decimal_places: 2 },
};

let repoRoot;
let firefly;
let fireflyUrl;
let seenHeaders = [];
let routes = {};

function defaultRoutes() {
  return {
    '/api/v1/about': { data: { version: '6.6.6', api_version: '6.6.6' } },
    '/api/v1/currencies/default': { data: { attributes: { code: 'PEN', symbol: 'S/', decimal_places: 2 } } },
    '/api/v1/summary/basic': SUMMARY_FIXTURE,
    '/api/v1/bills': { data: [] },
    '/api/v1/budgets': { data: [] },
    '/api/v1/budget-limits': { data: [] },
    '/api/v1/insight/expense/category': [],
    '/api/v1/transactions': { data: [], meta: { pagination: { total: 0 } } },
    '/api/v1/chart/account/overview': [],
  };
}

before(async () => {
  repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'fin-repo-'));
  await fs.writeFile(path.join(repoRoot, 'AGENTS.md'), '# Schema\n');
  firefly = http.createServer((req, res) => {
    seenHeaders.push({ url: req.url, accept: req.headers.accept, auth: req.headers.authorization });
    const pathname = req.url.split('?')[0];
    const entry = routes[pathname];
    if (entry === undefined) {
      res.writeHead(404, { 'content-type': 'application/json' });
      return res.end('{"message":"not found"}');
    }
    if (typeof entry === 'function') return entry(req, res);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(entry));
  });
  await new Promise((resolve) => firefly.listen(0, '127.0.0.1', resolve));
  fireflyUrl = `http://127.0.0.1:${firefly.address().port}`;
});

after(async () => {
  await fs.rm(repoRoot, { recursive: true, force: true });
  await new Promise((resolve) => firefly.close(resolve));
});

beforeEach(() => {
  routes = defaultRoutes();
  seenHeaders = [];
});

const cfg = (extra = {}) =>
  createConfig({ REPO_ROOT: repoRoot, FIREFLY_URL: fireflyUrl, FIREFLY_TOKEN: TOKEN, ...extra });
const app = (extra = {}) => createApp(cfg(extra));
const get = (a, url) => request(a).get(url).set('Host', '127.0.0.1:3001');

const FINANCE_ROUTES = [
  '/api/finance/status',
  '/api/finance/summary',
  '/api/finance/bills',
  '/api/finance/budgets',
  '/api/finance/categories',
  '/api/finance/trends',
];

/* ------------------------------ configuration ------------------------------ */

test('unset Firefly config: every finance route is 404 not-configured and status says so', async () => {
  const a = createApp(createConfig({ REPO_ROOT: repoRoot }));
  for (const url of FINANCE_ROUTES) {
    const res = await get(a, url);
    assert.equal(res.status, 404, url);
    assert.equal(res.body.error, 'finance-not-configured');
  }
  const status = await get(a, '/api/status');
  assert.equal(status.body.financeConfigured, false);
  assert.equal(status.body.financeAllowProxy, false);
});

test('config: FIREFLY_URL and FIREFLY_TOKEN must be set together', () => {
  assert.throws(() => createConfig({ REPO_ROOT: repoRoot, FIREFLY_URL: fireflyUrl }), /must be set together/);
  assert.throws(() => createConfig({ REPO_ROOT: repoRoot, FIREFLY_TOKEN: TOKEN }), /must be set together/);
  assert.equal(createConfig({ REPO_ROOT: repoRoot }).FIREFLY_URL, null);
});

test('config: plain http is loopback-only so the token never crosses a network', () => {
  assert.throws(
    () => createConfig({ REPO_ROOT: repoRoot, FIREFLY_URL: 'http://finances.home.arpa', FIREFLY_TOKEN: TOKEN }),
    /plain http is allowed only for a loopback host/
  );
  // https to the same remote name is fine, and so is any loopback http.
  assert.equal(
    createConfig({ REPO_ROOT: repoRoot, FIREFLY_URL: 'https://finances.home.arpa', FIREFLY_TOKEN: TOKEN }).FIREFLY_URL,
    'https://finances.home.arpa'
  );
  assert.equal(
    createConfig({ REPO_ROOT: repoRoot, FIREFLY_URL: 'http://localhost:8081/', FIREFLY_TOKEN: TOKEN }).FIREFLY_URL,
    'http://localhost:8081'
  );
  assert.throws(() => createConfig({ REPO_ROOT: repoRoot, FIREFLY_URL: 'not-a-url', FIREFLY_TOKEN: TOKEN }), /not a URL/);
});

test('config: FINANCE_ALLOW_PROXY is dead config without Firefly or without a proxy', () => {
  assert.throws(() => createConfig({ REPO_ROOT: repoRoot, FINANCE_ALLOW_PROXY: 'true' }), /Invalid FINANCE_ALLOW_PROXY/);
  assert.throws(
    () => cfg({ FINANCE_ALLOW_PROXY: 'true' }),
    /Invalid FINANCE_ALLOW_PROXY/
  );
  assert.throws(
    () => createConfig({ REPO_ROOT: repoRoot, PROXY_HOSTNAME: 'aos.home.arpa', PROXY_SECRET, FINANCE_ALLOW_PROXY: 'true' }),
    /Invalid FINANCE_ALLOW_PROXY/
  );
});

/* --------------------------------- gating ---------------------------------- */

const proxied = (a, url) =>
  request(a).get(url).set('Host', 'aos.home.arpa').set('x-aos-proxy-auth', PROXY_SECRET);

test('proxied finance requests are refused by default and allowed only with the flag', async () => {
  const withProxy = { PROXY_HOSTNAME: 'aos.home.arpa', PROXY_SECRET };
  for (const url of FINANCE_ROUTES) {
    const res = await proxied(app(withProxy), url);
    assert.equal(res.status, 403, url);
    assert.equal(res.body.error, 'finance-proxy-refused');
  }
  const allowed = await proxied(app({ ...withProxy, FINANCE_ALLOW_PROXY: 'true' }), '/api/finance/status');
  assert.equal(allowed.status, 200);
  assert.equal(allowed.body.version, '6.6.6');
});

test('the token never appears in any finance response, and /api/status omits url and token', async () => {
  const a = app();
  for (const url of FINANCE_ROUTES) {
    const res = await get(a, url);
    const body = JSON.stringify(res.body);
    assert.ok(!body.includes(TOKEN), `${url} leaked the token`);
    assert.ok(!body.includes(fireflyUrl), `${url} leaked the Firefly URL`);
  }
  const status = await get(a, '/api/status');
  assert.equal(status.body.financeConfigured, true);
  const statusBody = JSON.stringify(status.body);
  assert.ok(!statusBody.includes(TOKEN));
  assert.ok(!statusBody.includes(fireflyUrl));
});

test('finance never leaks into the shared surfaces', async () => {
  const a = app();
  const metrics = await get(a, '/api/metrics');
  assert.ok(!JSON.stringify(metrics.body).toLowerCase().includes('firefly'));
  const ops = await get(a, '/api/operations');
  const ids = ops.body.operations.map((o) => o.id);
  assert.ok(!ids.some((id) => id.includes('finance')), 'finance must not be an Operation (ADR-0011 §10)');
});

/* ------------------------------ upstream client ---------------------------- */

test('every upstream call asks for JSON and carries the bearer token', async () => {
  await get(app(), '/api/finance/summary');
  assert.ok(seenHeaders.length > 0);
  for (const h of seenHeaders) {
    assert.equal(h.accept, 'application/json', h.url);
    assert.equal(h.auth, `Bearer ${TOKEN}`, h.url);
  }
});

test('a redirect is reported, never followed', async () => {
  routes['/api/v1/about'] = (req, res) => {
    res.writeHead(302, { location: '/login' });
    res.end();
  };
  const res = await get(app(), '/api/finance/status');
  assert.equal(res.status, 502);
  assert.equal(res.body.error, 'firefly-redirect');
});

test('a rejected token surfaces as firefly-unauthorized without echoing Firefly', async () => {
  routes['/api/v1/about'] = (req, res) => {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end('{"message":"Unauthenticated."}');
  };
  const res = await get(app(), '/api/finance/status');
  assert.equal(res.status, 502);
  assert.equal(res.body.error, 'firefly-unauthorized');
  assert.ok(!JSON.stringify(res.body).includes('Unauthenticated'));
});

/* ---------------------------------- cache ---------------------------------- */

test('cache: a failed refresh serves the last good value labelled stale with its age', async () => {
  const cache = createFinanceCache();
  let calls = 0;
  const produce = async () => {
    calls += 1;
    if (calls === 1) return { figure: 42 };
    throw new FireflyError('firefly-unreachable', 'down');
  };
  const fresh = await cache.wrap('k', 0, produce);
  assert.equal(fresh.figure, 42);
  assert.equal(fresh.stale, false);

  const stale = await cache.wrap('k', 0, produce);
  assert.equal(stale.figure, 42, 'the last good figure is still served');
  assert.equal(stale.stale, true);
  assert.equal(stale.staleReason, 'firefly-unreachable');
  assert.ok(typeof stale.ageMs === 'number');
});

test('cache: with no previous value, a failure propagates instead of inventing one', async () => {
  const cache = createFinanceCache();
  await assert.rejects(
    () => cache.wrap('k', 1000, async () => { throw new FireflyError('firefly-unreachable', 'down'); }),
    /down/
  );
});

/* -------------------------------- indicators -------------------------------- */

test('parseSummary groups by currency and does not assume a cartesian key set', () => {
  const parsed = parseSummary(SUMMARY_FIXTURE);
  const pen = parsed.find((c) => c.currency.code === 'PEN');
  const usd = parsed.find((c) => c.currency.code === 'USD');
  assert.equal(pen.currency.symbol, 'S/');
  assert.deepEqual(Object.keys(pen.metrics).sort(), ['balance', 'earned', 'net-worth', 'spent']);
  // USD carries only the one metric the instance actually reports.
  assert.deepEqual(Object.keys(usd.metrics), ['bills-unpaid']);
  assert.equal(pen.metrics['net-worth'], 12000);
});

test("parseSummary drops Firefly's localized title so the UI language is ours", () => {
  const parsed = parseSummary(SUMMARY_FIXTURE);
  assert.ok(!JSON.stringify(parsed).includes('Saldo'));
});

test('savingsRate uses spend magnitude, and is absent — not zero — without income', () => {
  assert.equal(savingsRate({ earned: 4000, spent: -2500 }).value, (4000 - 2500) / 4000);
  const none = savingsRate({ earned: 0, spent: -100 });
  assert.equal(none.value, null);
  assert.equal(none.unavailable.reason, 'no-income');
  assert.equal(savingsRate({ spent: -100 }).unavailable.reason, 'missing-metric');
});

test('classifyBills splits paid / due / overdue from explicit dates only', () => {
  const data = [
    { id: '1', attributes: { name: 'Rent', active: true, currency_code: 'PEN', pay_dates: ['2026-09-15T00:00:00+00:00'], paid_dates: [] } },
    { id: '2', attributes: { name: 'Water', active: true, currency_code: 'PEN', pay_dates: ['2026-09-05T00:00:00+00:00'], paid_dates: [] } },
    { id: '3', attributes: { name: 'Net', active: true, currency_code: 'PEN', pay_dates: ['2026-09-20T00:00:00+00:00'], paid_dates: [{ date: '2026-09-05T09:48:00+00:00', amount: '27.93' }] } },
    { id: '4', attributes: { name: 'Off', active: false, pay_dates: ['2026-09-09T00:00:00+00:00'], paid_dates: [] } },
    { id: '5', attributes: { name: 'Silent', active: true, pay_dates: [], paid_dates: [] } },
  ];
  const out = classifyBills(data, { end: '2026-09-30', today: '2026-09-10' });
  assert.deepEqual(out.counts, { paid: 1, due: 1, overdue: 1 });
  assert.equal(out.bills[0].status, 'overdue', 'overdue sorts first');
  assert.equal(out.bills[0].name, 'Water');
  const names = out.bills.map((b) => b.name);
  assert.ok(!names.includes('Off'), 'inactive bills are excluded');
  assert.ok(!names.includes('Silent'), 'a bill with no dates is not guessed at');
});

test('paceBudgets reports absence — not zero — when no budgets exist', () => {
  const out = paceBudgets([], [], monthWindow(new Date('2026-09-17T12:00:00')));
  assert.equal(out.budgets.value, null);
  assert.equal(out.budgets.unavailable.reason, 'no-budgets');
  assert.match(out.budgets.unavailable.needs, /Budgets/);
});

test('paceBudgets compares spend to the elapsed month, and never across currencies', () => {
  const window = monthWindow(new Date('2026-09-15T12:00:00')); // half the month
  const budgets = [
    { id: '1', attributes: { name: 'Food', active: true, spent: [{ sum: '-600', currency_code: 'PEN', currency_symbol: 'S/' }] } },
    { id: '2', attributes: { name: 'Trips', active: true, spent: [{ sum: '-100', currency_code: 'USD', currency_symbol: '$' }] } },
  ];
  const limits = [
    { attributes: { budget_id: '1', amount: '1000', currency_code: 'PEN', currency_symbol: 'S/' } },
    { attributes: { budget_id: '2', amount: '1000', currency_code: 'PEN', currency_symbol: 'S/' } },
  ];
  const out = paceBudgets(budgets, limits, window);
  const food = out.budgets.find((b) => b.name === 'Food');
  const trips = out.budgets.find((b) => b.name === 'Trips');
  assert.equal(food.limit, 1000);
  // 60% spent at 50% through the month → pacing at 1.2.
  assert.ok(Math.abs(food.pace - 1.2) < 1e-9, `pace was ${food.pace}`);
  assert.equal(trips.limit, null, 'a PEN limit must not pace a USD spend');
  assert.equal(trips.pace, null);
});

test('monthWindow and monthsSpanned describe the period honestly', () => {
  const w = monthWindow(new Date('2026-09-17T12:00:00'));
  assert.equal(w.start, '2026-09-01');
  assert.equal(w.end, '2026-09-30');
  assert.equal(w.dayOfMonth, 17);
  assert.equal(w.daysInMonth, 30);
  assert.equal(monthsSpanned('2026-09-02T23:03:00+00:00', new Date('2026-09-17T12:00:00')), 1);
  assert.equal(monthsSpanned('2026-07-02T00:00:00+00:00', new Date('2026-09-17T12:00:00')), 3);
  assert.equal(monthsSpanned(null), 0);
});

test('trends state what they are waiting for while history is too short', async () => {
  routes['/api/v1/transactions'] = { data: [], meta: { pagination: { total: 0 } } };
  const out = await readTrends(cfg(), {}, new Date('2026-09-17T12:00:00'));
  assert.equal(out.history.months, 0);
  assert.equal(out.history.sufficient, false);
  assert.equal(out.netWorth.value, null);
  assert.equal(out.netWorth.unavailable.reason, 'insufficient-history');
  assert.match(out.netWorth.unavailable.needs, /3 months/);
  assert.equal(out.runwayMonths.value, null);
});

test('the advice notice rides on every finance payload', async () => {
  const a = app();
  for (const url of ['/api/finance/summary', '/api/finance/bills', '/api/finance/budgets', '/api/finance/categories', '/api/finance/trends']) {
    const res = await get(a, url);
    assert.match(res.body.notice, /never financial advice/, url);
  }
});
