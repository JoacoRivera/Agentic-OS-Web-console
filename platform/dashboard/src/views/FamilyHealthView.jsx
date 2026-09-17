import { useEffect, useState } from 'react';
import { ExternalLink } from 'lucide-react';
import FamilyHealthMarkdown from '../components/FamilyHealthMarkdown.jsx';
import LabTrend from '../components/LabTrend.jsx';
import { CopyButton } from '../components/CopyButton.jsx';

const KIND_LABEL = {
  checkbox: 'open item',
  marker: 'pendiente',
  'pending-result': 'result pending',
  'original-missing': 'original missing',
};

async function fetchJson(url) {
  const res = await fetch(url);
  if (res.ok) return { data: await res.json(), error: null, status: res.status };
  const body = await res.json().catch(() => ({}));
  return { data: null, error: body.error || `HTTP ${res.status}`, message: body.message || `HTTP ${res.status}`, status: res.status };
}

function StatCard({ title, tag, value, unit, detail }) {
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
      </div>
    </div>
  );
}

function GateNotice({ state }) {
  if (state.error === 'family-health-not-configured') {
    return (
      <div className="panel">
        <div className="label">Family Health</div>
        <div className="placeholder-body">
          Not configured. Set <code>HEALTH_REPO_ROOT</code> in <code>platform/.env</code> to the local
          Health-Management clone (a separate private repo, never a path inside the memory repo) and
          restart. The section stays loopback-only by default (ADR-0010).
        </div>
      </div>
    );
  }
  if (state.error === 'family-health-proxy-refused') {
    return (
      <div className="panel">
        <div className="label">Family Health</div>
        <div className="placeholder-body warn-text">
          Refused through the proxy hostname: this section is loopback-only unless the owner sets
          <code> FAMILY_HEALTH_ALLOW_PROXY=true</code> (ADR-0010). Open the console on the host itself.
        </div>
      </div>
    );
  }
  return (
    <div className="panel">
      <div className="label">Family Health</div>
      <div className="placeholder-body warn-text">Family Health unavailable — {state.message}</div>
    </div>
  );
}

function PendingList({ pending, onOpen, filter }) {
  if (!pending) return <div className="placeholder-body">Loading pending items…</div>;
  const items = filter ? pending.items.filter((it) => it.member === filter) : pending.items;
  if (items.length === 0) return <div className="placeholder-body">Nothing pending in the record.</div>;
  return (
    <div className="fh-list">
      {items.map((it, i) => (
        <button key={`${it.path}:${it.line ?? 'x'}:${i}`} className="search-hit" onClick={() => onOpen(it.path)} title={it.path}>
          <div className="search-hit-head">
            <span className={`badge fh-kind-${it.kind}`}>{KIND_LABEL[it.kind] ?? it.kind}</span>
            <span className="dim">{it.member ?? 'reference'}</span>
            {it.date && <span className="run-time">{it.date}</span>}
          </div>
          <div className="search-snippet">{it.text}</div>
        </button>
      ))}
    </div>
  );
}

function KeyValueTable({ rows }) {
  if (!rows || rows.length === 0) return <div className="placeholder-body">—</div>;
  return (
    <table className="kv">
      <tbody>
        {rows.map((r, i) => (
          <tr key={`${r.key}-${i}`}>
            <td>{r.key}</td>
            <td>{r.value || '—'}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function MemberFile({ file, onOpenNote, onOpenDoc, onTrend, trend }) {
  const [tab, setTab] = useState('profile');
  const [marker, setMarker] = useState('');
  useEffect(() => {
    setTab('profile');
    setMarker('');
  }, [file?.member?.name]);

  if (!file) return <div className="placeholder-body">Select a member.</div>;
  const { member, profile, history, exams, documents, markers, stats } = file;
  const tabs = [
    ['profile', 'Profile'],
    ['timeline', `Timeline · ${history.length}`],
    ['exams', `Exam notes · ${exams.length}`],
    ['documents', `Documents · ${documents.length}`],
    ['trends', 'Trends'],
  ];

  return (
    <div>
      <div className="fh-member-head">
        <div>
          <div className="fh-member-name">{member.name}</div>
          <div className="dim">
            {stats.examsN} exam notes · {stats.medicationsN} medications · {stats.pendingN} pending
            {stats.lastExamDate ? ` · last exam ${stats.lastExamDate}` : ''}
          </div>
        </div>
        <div className="copy-cluster">
          {member.wikiPath ? (
            <button className="copy-btn" onClick={() => onOpenDoc(member.wikiPath)} title={member.wikiPath}>
              <ExternalLink size={10} />
              <span>wiki page</span>
            </button>
          ) : (
            <span className="chip">no wiki page</span>
          )}
          <button className="copy-btn" onClick={() => onOpenNote(`${member.folder}/profile.md`)}>
            <span>profile.md</span>
          </button>
          <button className="copy-btn" onClick={() => onOpenNote(`${member.folder}/history.md`)}>
            <span>history.md</span>
          </button>
        </div>
      </div>
      <div className="fh-tabs">
        {tabs.map(([id, label]) => (
          <button key={id} className={`tree-row${tab === id ? ' selected' : ''}`} onClick={() => setTab(id)}>
            {label}
          </button>
        ))}
      </div>

      {tab === 'profile' && (
        <div>
          {file.profileMissing ? (
            <div className="placeholder-body warn-text">profile.md is missing for this member.</div>
          ) : (
            <div className="grid-2">
              <div>
                <div className="label">Identity</div>
                <KeyValueTable rows={profile.identity} />
                <div className="label">Allergies</div>
                <KeyValueTable rows={profile.allergies} />
              </div>
              <div>
                <div className="label">Conditions (as recorded)</div>
                {profile.conditions.length === 0 ? (
                  <div className="placeholder-body">None recorded.</div>
                ) : (
                  <ul className="fh-bullets">
                    {profile.conditions.map((c, i) => (
                      <li key={i}>{c}</li>
                    ))}
                  </ul>
                )}
                <div className="label">Current medications</div>
                {profile.medications.length === 0 ? (
                  <div className="placeholder-body">None recorded.</div>
                ) : (
                  <table className="kv fh-table">
                    <thead>
                      <tr>
                        <th>Medication</th>
                        <th>Dose</th>
                        <th>Frequency</th>
                        <th>Since</th>
                        <th>For</th>
                      </tr>
                    </thead>
                    <tbody>
                      {profile.medications.map((m, i) => (
                        <tr key={i}>
                          <td>{m.medication}</td>
                          <td>{m.dose || '—'}</td>
                          <td>{m.frequency || '—'}</td>
                          <td>{m.since || '—'}</td>
                          <td>{m.prescribedFor || '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
                <div className="label">Care team</div>
                {profile.careTeam.length === 0 ? (
                  <div className="placeholder-body">None recorded.</div>
                ) : (
                  <KeyValueTable rows={profile.careTeam.map((c) => ({ key: c.role || '—', value: [c.name, c.contact, c.notes].filter((v) => v && v !== '—').join(' · ') }))} />
                )}
                {profile.lastReviewed && <div className="dim fh-foot">Last reviewed {profile.lastReviewed}</div>}
              </div>
            </div>
          )}
        </div>
      )}

      {tab === 'timeline' && (
        <div className="fh-list">
          {file.historyMissing && <div className="placeholder-body warn-text">history.md is missing for this member.</div>}
          {history.map((h, i) => (
            <div key={`${h.date}-${i}`} className="fh-entry">
              <div className="search-hit-head">
                <span className="run-time">{h.date ?? '—'}</span>
                <span className="fh-entry-title">{h.title}</span>
              </div>
              {h.fields.map((f, j) => (
                <div key={j} className="search-snippet">
                  <span className="dim">{f.key}:</span> {f.value}
                </div>
              ))}
            </div>
          ))}
        </div>
      )}

      {tab === 'exams' && (
        <div className="fh-list">
          {exams.length === 0 && <div className="placeholder-body">No exam notes.</div>}
          {[...exams].reverse().map((e) => (
            <button key={e.path} className="search-hit" onClick={() => onOpenNote(e.path)} title={e.path}>
              <div className="search-hit-head">
                <span className="run-time">{e.date ?? '—'}</span>
                <span className="search-hit-path">{e.title}</span>
                {e.flaggedN > 0 && <span className="badge warn">{e.flaggedN} flagged</span>}
                {e.openFollowUpsN > 0 && <span className="badge">{e.openFollowUpsN} open</span>}
                {e.originalMissing && <span className="badge warn">original missing</span>}
                {!e.hasResultsTable && <span className="badge">no results table</span>}
              </div>
              <div className="search-snippet">
                {[e.type, e.facility].filter(Boolean).join(' · ') || e.name}
              </div>
            </button>
          ))}
        </div>
      )}

      {tab === 'documents' && (
        <div className="fh-list">
          {documents.length === 0 && <div className="placeholder-body">No original documents listed.</div>}
          {documents.map((d) => (
            <div key={d.name} className="run">
              <span className="badge">{d.ext || 'file'}</span>
              <span className="run-name" title={d.name}>{d.name}</span>
              <span className="run-time">{(d.size / 1024).toFixed(0)} KB</span>
              <span className="run-path">
                <CopyButton label="abs path" value={d.absolutePath} />
              </span>
            </div>
          ))}
          <div className="notice-compact fh-foot">Originals are listed only — never served over HTTP (ADR-0010).</div>
        </div>
      )}

      {tab === 'trends' && (
        <div>
          <div className="fh-trend-bar">
            <select
              className="fh-select"
              value={marker}
              onChange={(e) => {
                setMarker(e.target.value);
                if (e.target.value) onTrend(member.name, e.target.value);
              }}
            >
              <option value="">Marker…</option>
              {markers.map((m) => (
                <option key={m.marker} value={m.marker}>
                  {m.marker} ({m.n})
                </option>
              ))}
            </select>
          </div>
          <LabTrend trend={marker && trend?.marker?.toLowerCase() === marker.toLowerCase() ? trend : null} onOpenNote={onOpenNote} />
        </div>
      )}
    </div>
  );
}

/**
 * Family Health section (ADR-0010): a read-only view over the private
 * Health-Management clone — dashboard, pending list, and one medical file per
 * member. Renders what the notes say; counts, dates and series only. Never
 * a diagnosis, never a binary, never reachable through the proxy by default.
 */
export default function FamilyHealthView({ refreshKey = 0, onOpenDoc }) {
  const [summary, setSummary] = useState({ data: null, error: null });
  const [pending, setPending] = useState(null);
  const [selected, setSelected] = useState(null);
  const [memberFile, setMemberFile] = useState(null);
  const [memberError, setMemberError] = useState(null);
  const [note, setNote] = useState({ file: null, error: null, loading: false });
  const [trend, setTrend] = useState(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const s = await fetchJson('/api/family-health/summary').catch((err) => ({ data: null, error: 'network', message: err.message }));
      if (cancelled) return;
      setSummary(s);
      if (!s.data) return;
      const p = await fetchJson('/api/family-health/pending').catch(() => ({ data: null }));
      if (!cancelled) setPending(p.data);
    })();
    return () => {
      cancelled = true;
    };
  }, [refreshKey]);

  // The Note panel follows the selected member: selecting one opens that
  // member's profile.md, so a note from a previously selected member never
  // lingers next to a different member's file.
  useEffect(() => {
    if (!selected) {
      setMemberFile(null);
      setNote({ file: null, error: null, loading: false });
      return undefined;
    }
    let cancelled = false;
    setMemberError(null);
    setMemberFile(null);
    setTrend(null);
    setNote({ file: null, error: null, loading: true });
    (async () => {
      const profilePath = `members/${selected}/profile.md`;
      const [m, f] = await Promise.all([
        fetchJson(`/api/family-health/member?name=${encodeURIComponent(selected)}`).catch((err) => ({ data: null, message: err.message })),
        fetchJson(`/api/family-health/file?path=${encodeURIComponent(profilePath)}`).catch((err) => ({ data: null, message: err.message })),
      ]);
      if (cancelled) return;
      setMemberFile(m.data);
      setMemberError(m.data ? null : m.message);
      setNote({ file: f.data, error: f.data ? null : `Cannot open note — ${f.message}`, loading: false });
    })();
    return () => {
      cancelled = true;
    };
  }, [selected, refreshKey]);

  const openNote = async (path) => {
    setNote({ file: null, error: null, loading: true });
    const f = await fetchJson(`/api/family-health/file?path=${encodeURIComponent(path)}`).catch((err) => ({ data: null, message: err.message }));
    setNote({ file: f.data, error: f.data ? null : `Cannot open note — ${f.message}`, loading: false });
  };

  const loadTrend = async (member, marker) => {
    const t = await fetchJson(`/api/family-health/trends?member=${encodeURIComponent(member)}&marker=${encodeURIComponent(marker)}`).catch(() => ({ data: null }));
    setTrend(t.data);
  };

  if (summary.error) return <GateNotice state={summary} />;
  if (!summary.data) {
    return (
      <div className="panel">
        <div className="label">Family Health</div>
        <div className="placeholder-body">Loading the family record…</div>
      </div>
    );
  }

  const { members, totals, notice } = summary.data;

  return (
    <div>
      <div className="notice-compact fh-notice">{notice} Read-only view of the private Health-Management clone; loopback-only (ADR-0010).</div>
      <div className="stat-grid fh-stats">
        <StatCard title="Members" tag="folders" value={totals.membersN} unit="members" detail={totals.lastExamDate ? `· last exam ${totals.lastExamDate}` : ''} />
        <StatCard title="Exam notes" tag="dated notes" value={totals.examsN} unit="notes" detail={`· ${totals.documentsN} originals listed`} />
        <StatCard title="Pending" tag="explicit signals" value={totals.pendingN} unit="items" detail={`· ${totals.openFollowUpsN} open follow-ups`} />
        <StatCard title="Flagged rows" tag="as printed by each lab" value={totals.flaggedN} unit="results" detail={`· ${totals.originalsMissingN} originals missing`} />
      </div>

      <div className="grid-2">
        <div className="panel">
          <div className="label">
            Members
            {!summary.data.overviewPresent && <span className="label-sub">family-overview.md missing</span>}
          </div>
          <div className="fh-list">
            {members.map((m) => (
              <button
                key={m.name}
                className={`search-hit${selected === m.name ? ' fh-selected' : ''}`}
                onClick={() => setSelected(m.name)}
                title={m.folder}
              >
                <div className="search-hit-head">
                  <span className="search-hit-path">{m.name}</span>
                  {m.overview?.bloodType && <span className="badge">{m.overview.bloodType}</span>}
                  {m.pendingN > 0 ? <span className="badge warn">{m.pendingN} pending</span> : <span className="badge ok">clear</span>}
                  {m.profileMissing && <span className="badge warn">no profile</span>}
                </div>
                <div className="search-snippet">
                  {m.overview?.keyConditions && m.overview.keyConditions !== '—' ? m.overview.keyConditions : 'No key conditions recorded'}
                  {` · ${m.examsN} exam notes${m.lastExamDate ? ` · last ${m.lastExamDate}` : ''}`}
                </div>
              </button>
            ))}
            {members.length === 0 && <div className="placeholder-body">No member folders found.</div>}
          </div>
        </div>
        <div className="panel">
          <div className="label">
            Pending
            <span className="label-sub">{selected ? `${selected} only` : 'whole record'}</span>
          </div>
          <PendingList pending={pending} onOpen={openNote} filter={selected} />
        </div>
      </div>

      <div className="grid-2">
        <div className="panel">
          <div className="label">Member file</div>
          {memberError ? (
            <div className="placeholder-body warn-text">Cannot load member — {memberError}</div>
          ) : (
            <MemberFile file={selected ? memberFile : null} onOpenNote={openNote} onOpenDoc={onOpenDoc} onTrend={loadTrend} trend={trend} />
          )}
        </div>
        <div className="panel">
          <div className="label">Note</div>
          <FamilyHealthMarkdown file={note.file} error={note.error} loading={note.loading} />
        </div>
      </div>
    </div>
  );
}
