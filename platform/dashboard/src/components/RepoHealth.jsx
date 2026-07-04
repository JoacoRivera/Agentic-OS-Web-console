import { useEffect, useState } from 'react';

/**
 * One diagnostic card (plan: Overview). Docs/drafts/lint rows come from the
 * metrics prop; workflow/skill rows come from their registries live (re-read
 * whenever metrics refresh — reads are live, no cache). The ground-truth and
 * parity checks are local scripts, not browser calls, so they stay pointers.
 */
export default function RepoHealth({ metrics }) {
  const { wikiN, rawN, draftN, health } = metrics;
  const [registries, setRegistries] = useState(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [wRes, sRes] = await Promise.all([fetch('/api/workflows'), fetch('/api/skills')]);
        const summary = wRes.ok ? (await wRes.json()).summary : null;
        const skillCount = sRes.ok ? (await sRes.json()).skills.length : null;
        if (!cancelled) setRegistries({ summary, skillCount });
      } catch {
        if (!cancelled) setRegistries({ summary: null, skillCount: null });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [metrics]);

  const summary = registries?.summary;
  const defects = summary ? summary['missing-links'] + summary['needs-review'] : 0;
  const rows = [
    {
      k: 'Docs',
      v: `${wikiN} wiki pages · ${rawN} raw files`,
    },
    {
      k: 'Workflows',
      v: summary
        ? `${summary.ok} OK · ${summary['needs-review']} needs review · ${summary.unclassified} unclassified`
        : registries
          ? 'registry unavailable'
          : '…',
      warn: defects > 0,
      note: summary && summary['missing-links'] > 0 ? `${summary['missing-links']} missing links` : '',
    },
    {
      k: 'Skills',
      v: registries ? (registries.skillCount === null ? 'registry unavailable' : `${registries.skillCount} found`) : '…',
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
