import { fmtTs } from '../format.js';

export default function RecentActivity({ metrics }) {
  const { recent, all } = metrics;
  return (
    <div className="panel">
      <div className="label">
        Recent activity
        <span className="label-sub">{all} files tracked</span>
      </div>
      {recent.map((r) => (
        <div key={r.path} className="run">
          <span className="run-time">{fmtTs(r.mtime)}</span>
          <span className="run-name" title={r.path}>{r.name}</span>
          <span className="run-path">{r.path}</span>
        </div>
      ))}
    </div>
  );
}
