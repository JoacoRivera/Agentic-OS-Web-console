function StatCard({ title, tag, value, unit, detail, badge }) {
  return (
    <div className="panel stat">
      <div className="stat-head">
        <span>{title}</span>
        <span className="stat-tag">{tag}</span>
      </div>
      <div className="stat-foot">
        <b>{value}</b>
        <span className="stat-cap">{unit}</span>
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
  const { wikiN, rawN, examples, rawProj, rawFlow, weekTotal, activeDays, trend } = metrics;
  return (
    <div className="stat-grid">
      <StatCard
        title="Published memory"
        tag="wiki · synthesized"
        value={wikiN}
        unit="pages"
        detail={`· ${examples} examples`}
        badge={trend}
      />
      <StatCard
        title="Raw capture archive"
        tag="append-only evidence"
        value={rawN}
        unit="files"
        detail={`· ${rawProj}P · ${rawFlow}W`}
        badge="archive"
      />
      <StatCard
        title="Activity · 7d"
        tag="changes"
        value={weekTotal}
        unit="changed files"
        detail={`· ${activeDays} active days`}
        badge={trend}
      />
    </div>
  );
}
