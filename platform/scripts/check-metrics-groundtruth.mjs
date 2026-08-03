// check:metrics-groundtruth — PERMANENT correctness check (ADR-0002).
// Boots the real server, fetches /api/metrics over HTTP, and compares it
// field-by-field against an INDEPENDENT filesystem recount implemented here
// from the documented rules (skip basenames index|log|_template|README;
// `all` = wiki+raw+templates minus _template only; captures under
// raw `examples/` approved via a plain `Status:` body line; health from the
// first `lint` entry in wiki/log.md; knowledge intake deduplicated by explicit
// `source_id` / `knowledge_intake_date` / `promoted_from` lineage). It
// deliberately does NOT import `server/src/metrics.js`; the active filesystem
// roots are the source of truth.
//
// Independence is a property of the *algorithm*, not just of the file: the
// lineage graph is settled bottom-up here against the producer's top-down
// memoized recursion, and the 30-day curve is rebuilt point by point rather
// than spot-checked at its endpoint. Both sides do share `gray-matter`, on
// purpose — "is this frontmatter parseable at all" must mean the same thing to
// the check and to the console, or every YAML edge case becomes a false alarm.
//
// Usage: REPO_ROOT=<memory repo> node scripts/check-metrics-groundtruth.mjs
import { spawn } from 'node:child_process';
import fssync from 'node:fs';
import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import matter from 'gray-matter';

const platformDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const serverEntry = path.join(platformDir, 'server', 'src', 'index.js');
const repoRoot = process.env.REPO_ROOT
  ? path.resolve(process.env.REPO_ROOT.replace(/^~(?=\/|$)/, process.env.HOME ?? '~'))
  : path.resolve(platformDir, '..');

// ---------- independent recount ----------

const SKIP = new Set(['index', 'log', '_template', 'README']);

function listMd(rel) {
  const out = [];
  const stack = [rel];
  while (stack.length > 0) {
    const dir = stack.pop();
    const abs = path.join(repoRoot, dir);
    if (!fssync.existsSync(abs)) continue;
    for (const entry of fssync.readdirSync(abs, { withFileTypes: true })) {
      const p = `${dir}/${entry.name}`;
      if (entry.isDirectory()) {
        if (entry.name !== '.git') stack.push(p);
      } else if (entry.name.endsWith('.md')) {
        out.push(p);
      }
    }
  }
  return out;
}

const base = (p) => path.basename(p, '.md');
const inExamples = (p) => path.dirname(p).split('/').some((seg) => seg.includes('examples'));

// A capture is approved when its first `status:` marker line resolves to
// "approved" — inline (`Status: Approved`) or as the next bullet/line
// (`Status:` / `- Approved`). Line-scanner implementation, independent of
// the server's regex.
async function captureApproved(relPath) {
  let text;
  try {
    text = await fs.readFile(path.join(repoRoot, relPath), 'utf8');
  } catch {
    return false; // unreadable → draft
  }
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^[ \t]*status[ \t]*:(.*)$/i);
    if (!m) continue;
    let value = m[1].trim();
    for (let j = i + 1; value === '' && j < lines.length; j++) {
      value = lines[j].trim();
    }
    value = value.replace(/^[-*][ \t]*/, '');
    const word = (value.match(/^([a-zA-Z]+)/) || [])[1] || '';
    return word.toLowerCase() === 'approved';
  }
  return false;
}

// ---------- lineage recount (bottom-up, deliberately unlike the producer) ----------
// `metrics.js` resolves lineage top-down with a memoized recursive walk that
// carries a `visiting` set to break cycles. This recount instead settles the
// graph bottom-up: origins seed a resolved set, promotions are merged only once
// every reference is already settled, and whatever never settles is by
// definition inside a cycle (or hanging off an unresolvable ref). Two different
// algorithms agreeing is evidence; one algorithm typed twice is not.

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
// Agentic OS schema (AGENTS.md): `source_id` is a UUID minted once at intake.
// Canonical 8-4-4-4-12 hex form, case-insensitive; no version is assumed.
const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PROBLEM_LIMIT = 20;
const REASON = Object.freeze({
  CONFLICTING_SOURCE_ID: 'conflicting-source-id',
  FUTURE_INTAKE_DATE: 'future-intake-date',
  INVALID_FRONTMATTER: 'invalid-frontmatter',
  INVALID_INTAKE_DATE: 'invalid-intake-date',
  INVALID_PROMOTED_FROM_LINEAGE: 'invalid-promoted-from-lineage',
  INVALID_SOURCE_ID: 'invalid-source-id',
  MISSING_LINEAGE: 'missing-lineage',
  MISSING_PROMOTED_FROM: 'missing-promoted-from',
  ORIGIN_AND_PROMOTION: 'origin-and-promotion',
  PARTIAL_ORIGIN: 'partial-origin',
  PROMOTION_CYCLE: 'promotion-cycle',
  UNREADABLE_FILE: 'unreadable-file',
  UNSAFE_PROMOTED_FROM: 'unsafe-promoted-from',
});

/** `YYYY-MM-DD` that survives a UTC round trip (no Feb 30, no month 13). */
function calendarDay(day) {
  if (typeof day !== 'string' || !DATE_ONLY.test(day)) return null;
  const [y, m, d] = day.split('-').map(Number);
  const back = new Date(Date.UTC(y, m - 1, d));
  return back.getUTCFullYear() === y && back.getUTCMonth() === m - 1 && back.getUTCDate() === d
    ? day
    : null;
}

/** Map of top-level frontmatter key → exact raw scalar source text. */
function scalarSources(text) {
  const sources = new Map();
  const lines = (text || '').split(/\r?\n/);
  if (lines[0]?.trim() !== '---') return sources;
  for (let i = 1; i < lines.length && lines[i].trim() !== '---'; i++) {
    const line = lines[i];
    if (/^\s/.test(line)) continue; // nested: not a top-level scalar
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    const key = line.slice(0, colon).trim();
    if (sources.has(key)) continue; // first wins, as YAML's duplicate-key resolution does
    sources.set(key, line.slice(colon + 1).trim());
  }
  return sources;
}

/**
 * An intake day is only valid when the *written* scalar was a bare calendar
 * date. YAML silently promotes `2026-07-14T09:30:00Z` and `2025-02-30` to
 * Dates, so the parsed value cannot be trusted on its own.
 */
function intakeDay(value, source) {
  if (value === undefined || value === null) return null;
  return calendarDay(source);
}

function safeRef(ref) {
  if (typeof ref !== 'string') return null;
  const cleaned = ref.trim().replaceAll('\\', '/');
  if (cleaned === '' || cleaned.startsWith('/') || !cleaned.endsWith('.md')) return null;
  if (!cleaned.startsWith('raw/') || cleaned.split('/').includes('..')) return null;
  return path.posix.normalize(cleaned);
}

function lineageRecord(text) {
  let file;
  try {
    file = matter(text);
  } catch {
    // gray-matter caches the file object before parsing it, so a throw leaves
    // a `data: {}` stub keyed by this exact text. Drop it, or a repeat parse
    // of identical content would read as "no lineage declared" rather than
    // "unparseable frontmatter" — and the two sides would disagree by luck.
    delete matter.cache[text];
    return { type: 'bad', reason: REASON.INVALID_FRONTMATTER };
  }
  const { data } = file;
  const declares = (key) => Object.hasOwn(data, key);
  const hasId = declares('source_id');
  const hasDay = declares('knowledge_intake_date');

  if (declares('promoted_from')) {
    if (hasId || hasDay) return { type: 'bad', reason: REASON.ORIGIN_AND_PROMOTION };
    const listed = Array.isArray(data.promoted_from) ? data.promoted_from : [data.promoted_from];
    const refs = listed.map(safeRef);
    if (refs.length === 0 || refs.includes(null)) {
      return { type: 'bad', reason: REASON.UNSAFE_PROMOTED_FROM };
    }
    return { type: 'promotion', refs: [...new Set(refs)] };
  }
  if (!hasId && !hasDay) return { type: 'missing', reason: REASON.MISSING_LINEAGE };
  if (hasId !== hasDay) return { type: 'bad', reason: REASON.PARTIAL_ORIGIN };
  const id = typeof data.source_id === 'string' ? data.source_id : '';
  if (!id || !CANONICAL_UUID.test(id)) return { type: 'bad', reason: REASON.INVALID_SOURCE_ID };
  const day = intakeDay(
    data.knowledge_intake_date,
    scalarSources(text).get('knowledge_intake_date') ?? null
  );
  return day
    ? { type: 'source', id: id.toLowerCase(), day }
    : { type: 'bad', reason: REASON.INVALID_INTAKE_DATE };
}

function todayLocal(when = new Date()) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())}`;
}

async function recountLineage(paths) {
  const records = new Map();
  for (const relPath of paths) {
    try {
      records.set(relPath, lineageRecord(await fs.readFile(path.join(repoRoot, relPath), 'utf8')));
    } catch {
      records.set(relPath, { type: 'bad', reason: REASON.UNREADABLE_FILE });
    }
  }

  // --- bottom-up settling ---
  const settled = new Map(); // path -> Map(sourceId -> day)
  const broken = new Map(); // path -> stable structural reason
  for (const [relPath, record] of records) {
    if (record.type === 'source') settled.set(relPath, new Map([[record.id, record.day]]));
    else if (record.type === 'bad' || record.type === 'missing') {
      broken.set(relPath, record.reason);
    }
  }
  let pending = [...records].filter(([, r]) => r.type === 'promotion').map(([p]) => p);
  for (let progress = true; progress; ) {
    progress = false;
    const stillPending = [];
    for (const relPath of pending) {
      const { refs } = records.get(relPath);
      const missingRef = refs.find((ref) => !records.has(ref));
      if (missingRef) {
        broken.set(relPath, REASON.MISSING_PROMOTED_FROM);
        progress = true;
        continue;
      }
      const brokenRef = refs.find((ref) => broken.has(ref));
      if (brokenRef) {
        const target = records.get(brokenRef);
        broken.set(
          relPath,
          target.type === 'promotion'
            ? broken.get(brokenRef)
            : REASON.INVALID_PROMOTED_FROM_LINEAGE
        );
        progress = true;
        continue;
      }
      if (!refs.every((ref) => settled.has(ref))) {
        stillPending.push(relPath);
        continue;
      }
      const merged = new Map();
      let clash = false;
      for (const ref of refs) {
        for (const [id, day] of settled.get(ref)) {
          if (merged.has(id) && merged.get(id) !== day) clash = true;
          merged.set(id, day);
        }
      }
      if (clash) broken.set(relPath, REASON.CONFLICTING_SOURCE_ID);
      else settled.set(relPath, merged);
      progress = true;
    }
    pending = stillPending;
  }
  for (const relPath of pending) {
    broken.set(relPath, REASON.PROMOTION_CYCLE); // never settled → cycle/dependent chain
  }

  // --- source-id level verdicts ---
  const daysById = new Map();
  for (const record of records.values()) {
    if (record.type !== 'source') continue;
    const days = daysById.get(record.id) ?? new Set();
    days.add(record.day);
    daysById.set(record.id, days);
  }
  const conflicts = new Set([...daysById].filter(([, d]) => d.size > 1).map(([id]) => id));
  const today = todayLocal();
  const future = new Set(
    [...daysById].filter(([, d]) => d.size === 1 && [...d][0] > today).map(([id]) => id)
  );
  const invalidIds = new Set([...conflicts, ...future]);

  const events = [...daysById]
    .filter(([id, days]) => !invalidIds.has(id) && days.size === 1)
    .map(([id, days]) => ({ id, day: [...days][0] }));

  // --- file-level verdicts ---
  let lineagedN = 0;
  let unlineagedN = 0;
  let invalidN = 0;
  let promotedN = 0;
  const problems = [];
  for (const [relPath, record] of [...records].sort(([a], [b]) => (
    a < b ? -1 : a > b ? 1 : 0
  ))) {
    if (record.type === 'missing') {
      unlineagedN++;
      problems.push({ path: relPath, reason: record.reason });
      continue;
    }
    if (record.type === 'bad') {
      invalidN++;
      problems.push({ path: relPath, reason: record.reason });
      continue;
    }
    const sources = settled.get(relPath);
    let reason = broken.get(relPath) ?? null;
    if (!reason && [...sources.keys()].some((id) => conflicts.has(id))) {
      reason = REASON.CONFLICTING_SOURCE_ID;
    }
    if (!reason && [...sources.keys()].some((id) => future.has(id))) {
      reason = REASON.FUTURE_INTAKE_DATE;
    }
    if (reason) {
      invalidN++;
      problems.push({ path: relPath, reason });
      continue;
    }
    lineagedN++;
    if (record.type === 'promotion') promotedN++;
  }
  problems.sort((a, b) => {
    if (a.reason !== b.reason) return a.reason < b.reason ? -1 : 1;
    return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
  });

  // Reason histogram over the FULL problem set, recounted here before any cap
  // is applied — the point of the field is that it survives the 20-path
  // truncation, so tallying the truncated list would check nothing. Keys are
  // emitted in sorted order to match the console's stable serialization.
  const tally = {};
  for (const { reason } of problems) tally[reason] = (tally[reason] ?? 0) + 1;
  const reasonCounts = {};
  for (const reason of Object.keys(tally).sort()) reasonCounts[reason] = tally[reason];

  // --- 30-day cumulative series, walked over local calendar days ---
  const anchor = new Date();
  const dayAt = (offset) =>
    todayLocal(new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate() + offset));
  const series = [];
  for (let i = 29; i >= 0; i--) {
    const d = dayAt(-i);
    series.push({ d, v: events.reduce((n, e) => n + (e.day <= d ? 1 : 0), 0) });
  }
  const windowStart = dayAt(-29);

  return {
    knowledgeN: events.length,
    series,
    last30: events.filter((e) => e.day >= windowStart).length,
    lineage: {
      eligibleN: paths.length,
      lineagedN,
      unlineagedN,
      invalidN,
      promotedN,
      conflictingSourceIdsN: conflicts.size,
      futureDatedSourceIdsN: future.size,
      reasonCounts,
      problems: problems.slice(0, PROBLEM_LIMIT),
    },
  };
}

async function recount() {
  const wikiAll = listMd('wiki');
  const rawAll = listMd('raw');
  const wiki = wikiAll.filter((p) => !SKIP.has(base(p)));
  const raw = rawAll.filter((p) => !SKIP.has(base(p)));
  const allFiles = [...wikiAll, ...rawAll, ...listMd('templates')].filter(
    (p) => base(p) !== '_template'
  );

  const captures = raw.filter(inExamples);
  const lineage = await recountLineage([...wiki, ...raw]);
  let apprN = 0;
  for (const c of captures) if (await captureApproved(c)) apprN++;

  let lastLint = null;
  try {
    for (const line of (await fs.readFile(path.join(repoRoot, 'wiki/log.md'), 'utf8')).split('\n')) {
      const m = line.match(/^##\s*\[(\d{4}-\d{2}-\d{2})\]\s+lint\s*\|/);
      if (m) {
        lastLint = m[1];
        break;
      }
    }
  } catch {
    /* no log → never linted */
  }
  const dayStart = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const lintAge = lastLint
    ? Math.floor((dayStart(new Date()) - dayStart(new Date(`${lastLint}T00:00:00`))) / 86400e3)
    : null;

  return {
    wikiN: wiki.length,
    rawN: raw.length,
    all: allFiles.length,
    examples: wiki.filter(inExamples).length,
    projects: wikiAll.filter((p) => p.startsWith('wiki/projects/')).length,
    workflows: wikiAll.filter((p) => p.startsWith('wiki/workflows/') && !inExamples(p)).length,
    rawProj: raw.filter((p) => p.startsWith('raw/projects/')).length,
    rawFlow: raw.filter((p) => p.startsWith('raw/workflows/')).length,
    capN: captures.length,
    apprN,
    draftN: captures.length - apprN,
    ...lineage,
    lastLint,
    lintAge,
    healthStale: lintAge === null || lintAge >= 7,
  };
}

// ---------- fetch /api/metrics from a real boot ----------

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

function getJson(port, reqPath) {
  return new Promise((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port, path: reqPath }, (res) => {
        let body = '';
        res.on('data', (d) => (body += d));
        res.on('end', () => {
          if (res.statusCode !== 200) reject(new Error(`${reqPath} → ${res.statusCode}: ${body}`));
          else resolve(JSON.parse(body));
        });
      })
      .on('error', reject);
  });
}

const port = await freePort();
const child = spawn(process.execPath, [serverEntry], {
  env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', REPO_ROOT: repoRoot },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let stdout = '';
let stderr = '';
child.stdout.on('data', (d) => (stdout += d));
child.stderr.on('data', (d) => (stderr += d));
let failed = 0;
// The boot wait sits inside try/finally so a boot timeout or early exit
// still reaches child.kill() and never leaks a server process.
try {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`server boot timeout; stderr: ${stderr}`)),
      8000
    );
    child.stdout.on('data', () => {
      if (stdout.includes('listening on')) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.on('exit', (code) => reject(new Error(`server exited early (${code}); stderr: ${stderr}`)));
  });

  const [console_, truth] = await Promise.all([getJson(port, '/api/metrics'), recount()]);

  // A passing 30-point series prints as noise; only a mismatch needs the detail.
  const brief = (value, full) => {
    const text = JSON.stringify(value);
    return full || text.length <= 160 ? text : `${text.slice(0, 160)}… (${text.length} chars)`;
  };
  const check = (name, got, want) => {
    const ok = JSON.stringify(got) === JSON.stringify(want);
    if (!ok) failed++;
    console.log(`${ok ? '✔' : '✖'} ${name}: console=${brief(got, !ok)} recount=${brief(want, !ok)}`);
  };

  for (const f of [
    'wikiN', 'rawN', 'all', 'examples', 'projects', 'workflows',
    'rawProj', 'rawFlow', 'capN', 'apprN', 'draftN', 'knowledgeN', 'last30',
  ]) {
    check(f, console_[f], truth[f]);
  }
  check('health.lastLint', console_.health.lastLint, truth.lastLint);
  check('health.lintAge', console_.health.lintAge, truth.lintAge);
  check('health.healthStale', console_.health.healthStale, truth.healthStale);

  // The whole 30-point curve, not just its endpoint: a wrong intake *date*
  // moves points without moving the total.
  check('series (30 × {d,v})', console_.series, truth.series);

  // Coverage is a partition of the eligible files — every eligible file lands in
  // exactly one bucket, so a silently dropped file cannot hide inside a total.
  const counterFields = [
    'eligibleN',
    'lineagedN',
    'unlineagedN',
    'invalidN',
    'promotedN',
    'conflictingSourceIdsN',
    'futureDatedSourceIdsN',
  ];
  const pickCounters = (lineage) => Object.fromEntries(
    counterFields.map((field) => [field, lineage[field]])
  );
  const counts = console_.lineage;
  check('lineage counters', pickCounters(counts), pickCounters(truth.lineage));
  check('lineage.problems (exact, max 20)', counts.problems, truth.lineage.problems);

  // The histogram is the uncapped view of the same defects: it must match the
  // recount key for key, and — unlike `problems` — its values must still
  // account for every problem file once the 20-path sample has been truncated.
  check('lineage.reasonCounts (uncapped, exact)', counts.reasonCounts, truth.lineage.reasonCounts);
  check(
    'lineage sum(reasonCounts) = unlineagedN+invalidN',
    Object.values(counts.reasonCounts ?? {}).reduce((n, v) => n + v, 0),
    counts.unlineagedN + counts.invalidN
  );
  check(
    'lineage.reasonCounts exposes counts only',
    Object.values(counts.reasonCounts ?? {}).every((v) => Number.isInteger(v) && v > 0),
    true
  );
  check(
    'lineage partition lineagedN+unlineagedN+invalidN = eligibleN',
    counts.lineagedN + counts.unlineagedN + counts.invalidN,
    counts.eligibleN
  );
} catch (err) {
  failed++;
  console.error(`✖ ${err.message}`);
} finally {
  child.kill('SIGTERM');
}

console.log(
  failed === 0
    ? `\ncheck:metrics-groundtruth PASS (repo: ${repoRoot})`
    : `\ncheck:metrics-groundtruth FAIL — ${failed} mismatch(es) (repo: ${repoRoot})`
);
process.exit(failed === 0 ? 0 : 1);
