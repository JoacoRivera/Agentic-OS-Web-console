export default function PlaceholderView({ section }) {
  return (
    <div className="panel">
      <div className="label">
        {section.label}
        {section.phase > 1 && <span className="label-sub">phase {section.phase}</span>}
      </div>
      <div className="placeholder-body">Coming in a later slice.</div>
    </div>
  );
}
