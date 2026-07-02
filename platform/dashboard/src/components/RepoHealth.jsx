/**
 * One diagnostic card (plan: Overview). Rows only claim what this slice can
 * honestly compute — registry verdicts (workflows/skills) land in their own
 * slices, and the ground-truth check is a local script, not a browser call.
 */
export default function RepoHealth({ metrics }) {
  const { wikiN, rawN, workflows, draftN, health } = metrics;
  const rows = [
    {
      k: 'Docs',
      v: `${wikiN} wiki pages · ${rawN} raw files`,
    },
    {
      k: 'Workflows',
      v: `${workflows} found`,
      note: 'registry checks — later slice',
    },
    {
      k: 'Skills',
      v: '—',
      note: 'registry — later slice',
    },
    {
      k: 'Draft captures',
      v: String(draftN),
      warn: draftN > 0,
      note: draftN > 0 ? 'awaiting review' : 'all reviewed',
    },
    {
      k: 'Lint age',
      v: health.ageLabel.toLowerCase(),
      warn: health.healthStale,
    },
    {
      k: 'Metrics ground-truth',
      v: 'npm run check:metrics-groundtruth',
      note: 'permanent check · run locally',
    },
    {
      k: 'HUD parity',
      v: 'migration-only',
      note: 'not a permanent gate (ADR-0002)',
    },
  ];
  return (
    <div className="panel">
      <div className="label">Repo health</div>
      <table className="kv">
        <tbody>
          {rows.map((row) => (
            <tr key={row.k}>
              <td>{row.k}</td>
              <td className={row.warn ? 'warn-text' : ''}>
                {row.v}
                {row.note && <span className="muted"> · {row.note}</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
