import { useEffect, useState } from 'react';
import { ExternalLink, AlertTriangle } from 'lucide-react';

/**
 * Finance (ADR-0011): a read-only glance over Firefly III. Two bands —
 * "this month" first, then the long horizon — and every card links back to
 * Firefly, which keeps the detail. A figure that cannot be computed shows
 * what would unlock it; it never shows a zero, because a zero and "no data
 * yet" mean opposite things on a finance dashboard.
 */

const METRIC_LABEL = {
  spent: 'Spent',
  earned: 'Earned',
  'left-to-spend': 'Left to spend',
  balance: 'Balance',
  'net-worth': 'Net worth',
  'bills-paid': 'Bills paid',
  'bills-unpaid': 'Bills unpaid',
};

const MONTH_METRICS = ['spent', 'earned', 'left-to-spend', 'balance'];

async function fetchJson(url) {
  const res = await fetch(url);
  if (res.ok) return { data: await res.json(), error: null };
  const body = await res.json().catch(() => ({}));
  return { data: null, error: body.error || `HTTP ${res.status}`, message: body.message || `HTTP ${res.status}` };
}

function money(value, currency) {
  if (!Number.isFinite(value)) return '—';
  const abs = Math.abs(value).toLocaleString(undefined, {
    minimumFractionDigits: currency?.decimalPlaces ?? 2,
    maximumFractionDigits: currency?.decimalPlaces ?? 2,
  });
  return `${value < 0 ? '−' : ''}${currency?.symbol ?? ''}${abs}`;
}

const pct = (n) => `${(n * 100).toFixed(0)}%`;

/** A value that could not be computed, showing what it is waiting for. */
function Waiting({ on }) {
  return (
    <div className="fin-waiting">
      <span className="fin-waiting-mark">—</span>
      <span className="dim">Waiting on: {on}</span>
    </div>
  );
}

/**
 * A panel's own load state. An upstream failure with nothing cached must say
 * so — otherwise the panel sits on "Loading…" forever while Firefly is down.
 */
function PanelState({ state, loading }) {
  if (state?.error) return <div className="placeholder-body warn-text">{state.message}</div>;
  return <div className="placeholder-body">{loading}</div>;
}

function StatCard({ label, value, caption }) {
  return (
    <div className="panel stat">
      <div className="stat-head">
        <span>{label}</span>
      </div>
      <div className="stat-foot">
        <b>{value}</b>
        <span className="stat-sp" />
        <span className="dim">{caption}</span>
      </div>
    </div>
  );
}

function FireflyLink({ base, to, children }) {
  if (!base) return null;
  return (
    <a className="doc-link fin-link" href={`${base}${to}`} target="_blank" rel="noreferrer noopener">
      {children} <ExternalLink size={12} />
    </a>
  );
}

function StaleBanner({ payload }) {
  if (!payload?.stale) return null;
  const minutes = Math.round((payload.ageMs ?? 0) / 60000);
  return (
    <div className="fin-stale">
      <AlertTriangle size={13} />
      Firefly is not answering ({payload.staleReason}). Showing the last good read
      {minutes > 0 ? ` from ${minutes} min ago` : ' from moments ago'}.
    </div>
  );
}

function GateNotice({ error, message }) {
  if (error === 'finance-not-configured') {
    return (
      <div className="panel">
        <div className="label">Finance</div>
        <div className="placeholder-body">
          Not configured. Set <code>FIREFLY_URL</code> and <code>FIREFLY_TOKEN</code> in{' '}
          <code>platform/.env</code> and restart. On this host the URL is{' '}
          <code>http://127.0.0.1:8081</code> — the loopback address, not the public name, so the
          token never crosses a network (ADR-0011).
        </div>
      </div>
    );
  }
  if (error === 'finance-proxy-refused') {
    return (
      <div className="panel">
        <div className="label">Finance</div>
        <div className="placeholder-body warn-text">
          Refused through the proxy hostname: this section is loopback-only unless the owner sets{' '}
          <code>FINANCE_ALLOW_PROXY=true</code> (ADR-0011). Open the console on the host itself.
        </div>
      </div>
    );
  }
  return (
    <div className="panel">
      <div className="label">Finance</div>
      <div className="placeholder-body warn-text">Finance unavailable — {message}</div>
    </div>
  );
}

/* ------------------------------- band panels -------------------------------- */

function BudgetPacing({ payload, state, base }) {
  if (!payload) return <PanelState state={state} loading="Loading budgets…" />;
  const { budgets, elapsedFraction } = payload;
  return (
    <div className="panel">
      <div className="label">
        Budget pacing
        <span className="dim"> · {pct(elapsedFraction ?? 0)} of the month elapsed</span>
        <FireflyLink base={base} to="/budgets">Firefly</FireflyLink>
      </div>
      {budgets?.unavailable ? (
        <Waiting on={budgets.unavailable.needs} />
      ) : (
        <div className="fin-rows">
          {budgets.map((b) => (
            <div className="fin-row" key={`${b.id}-${b.currency.code}`}>
              <span className="fin-row-name">{b.name}</span>
              <span className="fin-bar-track">
                <span
                  className={`fin-bar-fill${b.pace > 1 ? ' over' : ''}`}
                  style={{ width: `${Math.min(100, b.limit ? (b.spent / b.limit) * 100 : 0)}%` }}
                />
                {b.limit ? (
                  <span className="fin-bar-mark" style={{ left: `${Math.min(100, elapsedFraction * 100)}%` }} />
                ) : null}
              </span>
              <span className="fin-row-val">
                {money(b.spent, b.currency)}
                {b.limit ? <span className="dim"> / {money(b.limit, b.currency)}</span> : null}
              </span>
              <span className={`fin-pace${b.pace > 1 ? ' over' : ''}`}>
                {b.pace === null ? <span className="dim">no limit</span> : `${b.pace.toFixed(2)}×`}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function BillsPanel({ payload, state, base }) {
  if (!payload) return <PanelState state={state} loading="Loading bills…" />;
  const { bills, counts } = payload;
  return (
    <div className="panel">
      <div className="label">
        Bills this month
        <span className="dim">
          {' '}· {counts.overdue} overdue · {counts.due} due · {counts.paid} paid
        </span>
        <FireflyLink base={base} to="/subscriptions">Firefly</FireflyLink>
      </div>
      {bills.length === 0 ? (
        <Waiting on="Bills configured in Firefly III" />
      ) : (
        <div className="fin-rows">
          {bills.map((b) => (
            <div className="fin-row" key={b.id}>
              <span className={`fin-dot ${b.status}`} />
              <span className="fin-row-name">{b.name}</span>
              <span className="dim">{b.nextDue ?? '—'}</span>
              <span className="fin-row-val">
                {Number.isFinite(b.amountMin) ? money(b.amountMin, b.currency) : '—'}
              </span>
              <span className="badge">{b.status}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function CategoriesPanel({ payload, state, base }) {
  if (!payload) return <PanelState state={state} loading="Loading categories…" />;
  const rows = payload.categories ?? [];
  const max = rows.reduce((m, r) => Math.max(m, r.spent), 0);
  return (
    <div className="panel">
      <div className="label">
        Spend by category
        <FireflyLink base={base} to="/categories">Firefly</FireflyLink>
      </div>
      {rows.length === 0 ? (
        <Waiting on="Categorized spending in this month" />
      ) : (
        <div className="fin-rows">
          {rows.slice(0, 8).map((r) => (
            <div className="fin-row" key={r.id ?? r.name}>
              <span className="fin-row-name">{r.name}</span>
              <span className="fin-bar-track">
                <span className="fin-bar-fill" style={{ width: `${max ? (r.spent / max) * 100 : 0}%` }} />
              </span>
              <span className="fin-row-val">{money(r.spent, r.currency)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function LongTerm({ summary, trends, state, base }) {
  if (!summary || !trends) return <PanelState state={state} loading="Loading long-term view…" />;
  const primary =
    summary.currencies?.find((c) => c.currency.code === summary.primaryCurrency) ?? summary.currencies?.[0];
  const netWorth = primary?.metrics?.['net-worth'];
  const rate = primary?.savingsRate;
  return (
    <>
      <div className="stat-grid">
        <StatCard
          label="Net worth"
          value={Number.isFinite(netWorth) ? money(netWorth, primary.currency) : '—'}
          caption={primary?.currency.code ?? ''}
        />
        <StatCard
          label="Savings rate"
          value={rate && rate.value !== null ? pct(rate.value) : '—'}
          caption={rate && rate.value === null ? rate.unavailable.reason : 'this month'}
        />
      </div>
      <div className="panel">
        <div className="label">
          History depth
          <FireflyLink base={base} to="/reports">Firefly</FireflyLink>
        </div>
        <div className="dim fin-history">
          {trends.history.transactions} transactions · {trends.history.months} month
          {trends.history.months === 1 ? '' : 's'} of history
          {trends.history.earliest ? ` since ${trends.history.earliest.slice(0, 10)}` : ''} ·{' '}
          {trends.history.required} needed for trends
        </div>
      </div>
      <div className="grid-2">
        <div className="panel">
          <div className="label">Net-worth trend</div>
          {trends.netWorth?.unavailable ? (
            <Waiting on={trends.netWorth.unavailable.needs} />
          ) : (
            <div className="fin-rows">
              {trends.netWorth.value.map((s) => (
                <div className="fin-row" key={s.label}>
                  <span className="fin-row-name">{s.label}</span>
                  <span className="dim">{s.entries.length} points</span>
                </div>
              ))}
            </div>
          )}
        </div>
        <div className="panel">
          <div className="label">Months of runway</div>
          {trends.runwayMonths?.unavailable ? (
            <Waiting on={trends.runwayMonths.unavailable.needs} />
          ) : (
            <div className="mono-big">{trends.runwayMonths.value}</div>
          )}
        </div>
      </div>
    </>
  );
}

/* --------------------------------- the view --------------------------------- */

export default function FinanceView({ refreshKey }) {
  const [gate, setGate] = useState(null);
  const [status, setStatus] = useState(null);
  const [summary, setSummary] = useState(null);
  const [bills, setBills] = useState(null);
  const [budgets, setBudgets] = useState(null);
  const [categories, setCategories] = useState(null);
  const [trends, setTrends] = useState(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const st = await fetchJson('/api/finance/status');
      if (cancelled) return;
      if (st.error && st.error !== 'firefly-unreachable' && st.error !== 'firefly-timeout') {
        setGate(st);
        return;
      }
      setGate(null);
      setStatus(st.data ?? null);
      const [su, bi, bu, ca, tr] = await Promise.all([
        fetchJson('/api/finance/summary'),
        fetchJson('/api/finance/bills'),
        fetchJson('/api/finance/budgets'),
        fetchJson('/api/finance/categories'),
        fetchJson('/api/finance/trends'),
      ]);
      if (cancelled) return;
      setSummary(su);
      setBills(bi);
      setBudgets(bu);
      setCategories(ca);
      setTrends(tr);
    })();
    return () => {
      cancelled = true;
    };
  }, [refreshKey]);

  if (gate) return <GateNotice error={gate.error} message={gate.message} />;

  const base = status?.publicUrl ?? null;
  const sum = summary?.data ?? null;
  const primary =
    sum?.currencies?.find((c) => c.currency.code === sum.primaryCurrency) ?? sum?.currencies?.[0];
  const others = (sum?.currencies ?? []).filter((c) => c !== primary);

  return (
    <div className="fin">
      <StaleBanner payload={sum} />

      <div className="label fin-band-title">Am I on track this month?</div>
      {sum ? (
        <>
          <div className="stat-grid">
            {MONTH_METRICS.map((m) => (
              <StatCard
                key={m}
                label={METRIC_LABEL[m]}
                value={primary && m in primary.metrics ? money(primary.metrics[m], primary.currency) : '—'}
                caption={
                  primary && m in primary.metrics
                    ? `${sum.window.start.slice(0, 7)} · ${primary.currency.code}`
                    : 'not reported'
                }
              />
            ))}
          </div>
          {others.length > 0 && (
            <div className="panel fin-other-cur">
              <div className="label">Other currencies</div>
              <div className="fin-rows">
                {others.map((c) => (
                  <div className="fin-row" key={c.currency.code}>
                    <span className="fin-row-name">{c.currency.code}</span>
                    {Object.entries(c.metrics).map(([m, v]) => (
                      <span key={m} className="dim">
                        {METRIC_LABEL[m] ?? m}: {money(v, c.currency)}
                      </span>
                    ))}
                  </div>
                ))}
              </div>
              <div className="dim fin-nosum">Never summed across currencies — Firefly implies no exchange rate.</div>
            </div>
          )}
        </>
      ) : (
        <PanelState state={summary} loading="Loading this month…" />
      )}

      <BudgetPacing payload={budgets?.data} state={budgets} base={base} />
      <div className="grid-2">
        <BillsPanel payload={bills?.data} state={bills} base={base} />
        <CategoriesPanel payload={categories?.data} state={categories} base={base} />
      </div>

      <div className="label fin-band-title">Are we well long term?</div>
      <LongTerm summary={summary?.data} trends={trends?.data} state={summary?.error ? summary : trends} base={base} />

      <div className="fin-notice">
        Indicators to decide with, never financial advice — the detail lives in Firefly.
      </div>
    </div>
  );
}
