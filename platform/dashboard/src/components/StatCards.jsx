const SEGMENTS = 26;

function Gauge({ value, target }) {
  const on = Math.max(0, Math.min(SEGMENTS, Math.round((value / target) * SEGMENTS)));
  return (
    <div className="gauge">
      {Array.from({ length: SEGMENTS }, (_, i) => (
        <i key={i} className={i < on ? 'on' : ''} />
      ))}
    </div>
  );
}

function StatCard({ title, tag, value, target, unit, detail, badge }) {
  return (
    <div className="panel stat">
      <div className="stat-head">
        <span>{title}</span>
        <span className="stat-tag">{tag}</span>
      </div>
      <Gauge value={value} target={target} />
      <div className="stat-foot">
        <b>{value}</b>
        <span className="stat-cap">/ {target} {unit}</span>
        <span className="stat-sp" />
        <span className="dim">{detail}</span>
        <span className="chip">{badge}</span>
      </div>
    </div>
  );
}

/**
 * ADR-0003 labels: wikiN is the headline ("Published memory"); rawN is an
 * append-only archive, never a backlog; raw and wiki are independent
 * monotonic stores — no funnel between them.
 */
export default function StatCards({ metrics }) {
  const { wikiN, rawN, examples, rawProj, rawFlow, weekTotal, activeDays, targets, trend } = metrics;
  return (
    <div className="stat-grid">
      <StatCard
        title="Published memory"
        tag="wiki · synthesized"
        value={wikiN}
        target={targets.wikiN}
        unit="pages"
        detail={`· ${examples} examples`}
        badge={trend}
      />
      <StatCard
        title="Raw capture archive"
        tag="append-only evidence"
        value={rawN}
        target={targets.rawN}
        unit="files"
        detail={`· ${rawProj}P · ${rawFlow}W`}
        badge="archive"
      />
      <StatCard
        title="Activity · 7d"
        tag="changes"
        value={weekTotal}
        target={targets.weekTotal}
        unit="edits"
        detail={`· ${activeDays} active days`}
        badge={trend}
      />
    </div>
  );
}
