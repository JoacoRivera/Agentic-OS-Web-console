import fs from 'node:fs/promises';
import path from 'node:path';
import { safeResolve } from './paths.js';

/**
 * Family Health backend (ADR-0010): a read-only view over the live
 * Health-Management clone named by HEALTH_REPO_ROOT — a second repo root
 * with its own allowed roots and its own safeResolve calls. It never touches
 * the memory repo except to test whether a member's wiki page exists.
 *
 * Everything here renders, counts, or charts what the notes literally say.
 * Nothing interprets a value: flags, ranges, and units are copied from the
 * note that carries them, and pending items come only from explicit signals
 * (checkboxes, bold Pendiente/Pending markers, "Pending" results, missing
 * originals).
 */

export const HEALTH_ROOTS = ['family-overview.md', 'members', 'reference'];
export const MEMBERS_DIR = 'members';
export const TEMPLATE_DIR = '_TEMPLATE';
export const WIKI_MEMBER_DIR = 'wiki/projects/family-health-tracker';
export const PHYSICIAN_NOTICE = 'Data to raise with a physician, never a diagnosis.';

export class FamilyHealthNotConfiguredError extends Error {
  constructor() {
    super('Family Health is not configured (HEALTH_REPO_ROOT unset, ADR-0010)');
    this.name = 'FamilyHealthNotConfiguredError';
    this.status = 404;
    this.code = 'family-health-not-configured';
  }
}

export class FamilyHealthProxyRefusedError extends Error {
  constructor() {
    super('Family Health is loopback-only; not served through the proxy (ADR-0010)');
    this.name = 'FamilyHealthProxyRefusedError';
    this.status = 403;
    this.code = 'family-health-proxy-refused';
  }
}

export class BadMemberError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BadMemberError';
    this.status = 400;
    this.code = 'bad-member';
  }
}

function requireRoot(config) {
  if (config.HEALTH_REPO_ROOT === null || config.HEALTH_REPO_ROOT === undefined) {
    throw new FamilyHealthNotConfiguredError();
  }
  return config.HEALTH_REPO_ROOT;
}

/** Resolve a client path inside the health root only (ADR-0010 §2). */
export function healthResolve(config, relPath) {
  return safeResolve(requireRoot(config), relPath, HEALTH_ROOTS);
}

const toPosix = (p) => p.replaceAll('\\', '/');

/* ----------------------------- markdown parsing ----------------------------- */

const H2_RE = /^##\s+(.+?)\s*$/;
const H3_RE = /^###\s+(.+?)\s*$/;
const BULLET_KV_RE = /^\s*[-*]\s+\*\*([^*]+?)\*\*\s*:?\s*(.*)$/;
const BULLET_RE = /^\s*[-*]\s+(.*)$/;
const CHECKBOX_RE = /^\s*[-*]\s+\[( |x|X)\]\s+(.*)$/;
const TABLE_SEP_RE = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;
const PENDING_MARKER_RE = /\*\*[^*\n]*\b(pendiente|pending)\b[^*\n]*\*\*/i;
const PENDING_RESULT_RE = /^(pending|pendiente)\b/i;
const NUMERIC_RE = /^\s*([<>≤≥]?)\s*(-?\d+(?:[.,]\d+)?)\s*(?:%|\S*)?/;
const EXAM_FILE_RE = /^(\d{4}-\d{2}-\d{2})_(.+)\.md$/;
const HISTORY_ENTRY_RE = /^(~?\d{4}-\d{2}(?:-\d{2})?)\s+[—–-]+\s+(.+)$/;
const ORIGINAL_MISSING_RE = /^\s*[—–-]\s*(\(.*\))?\s*$/;

function splitCells(line) {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|')) s = s.slice(0, -1);
  return s.split('|').map((c) => c.trim());
}

/** Level-2 sections as {heading, startLine, lines[]}; text before the first H2 is heading null. */
export function splitSections(text) {
  const lines = text.split(/\r?\n/);
  const sections = [{ heading: null, startLine: 1, lines: [] }];
  lines.forEach((line, i) => {
    const m = line.match(H2_RE);
    if (m) sections.push({ heading: m[1], startLine: i + 1, lines: [] });
    else sections.at(-1).lines.push({ n: i + 1, text: line });
  });
  return sections;
}

function findSection(sections, ...needles) {
  const lower = needles.map((n) => n.toLowerCase());
  return sections.find(
    (s) => s.heading && lower.some((n) => s.heading.toLowerCase().includes(n))
  );
}

/** Every GFM table in a run of lines → [{headers[], rows[][]}]. */
export function parseTables(lines) {
  const texts = lines.map((l) => (typeof l === 'string' ? l : l.text));
  const tables = [];
  for (let i = 0; i < texts.length - 1; i++) {
    if (texts[i].includes('|') && TABLE_SEP_RE.test(texts[i + 1])) {
      const headers = splitCells(texts[i]);
      const rows = [];
      let j = i + 2;
      for (; j < texts.length; j++) {
        if (!texts[j].includes('|')) break;
        const cells = splitCells(texts[j]);
        if (cells.every((c) => c === '')) continue;
        rows.push(cells);
      }
      tables.push({ headers, rows });
      i = j;
    }
  }
  return tables;
}

/** First GFM table in a run of lines → {headers[], rows[][]} or null. */
export function parseTable(lines) {
  return parseTables(lines)[0] ?? null;
}

/** `- **Key:** value` bullets → [{key, value}] (empty/dash values kept verbatim). */
export function parseKeyBullets(lines) {
  const out = [];
  for (const l of lines) {
    const m = l.text.match(BULLET_KV_RE);
    if (m) out.push({ key: m[1].replace(/:$/, '').trim(), value: m[2].trim() });
  }
  return out;
}

function parseBullets(lines) {
  return lines
    .map((l) => l.text.match(BULLET_RE)?.[1]?.trim())
    .filter((t) => t && !/^\[( |x|X)\]/.test(t));
}

/** `- [ ] item` / `- [x] item` → [{checked, text, line}]. */
export function parseCheckboxes(lines) {
  const out = [];
  for (const l of lines) {
    const m = l.text.match(CHECKBOX_RE);
    if (m) out.push({ checked: m[1] !== ' ', text: m[2].trim(), line: l.n });
  }
  return out;
}

const stripMd = (s) => s.replace(/\*\*/g, '').replace(/`/g, '').trim();

/** "18.93" / "<0.5" / "825,00" → number or null (Pending, text, ranges are null). */
export function numericValue(cell) {
  const s = stripMd(cell);
  if (PENDING_RESULT_RE.test(s)) return null;
  const m = s.match(NUMERIC_RE);
  if (!m) return null;
  return Number(m[2].replace(',', '.'));
}

const slugify = (name) =>
  name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

/* ----------------------------- exam notes ----------------------------- */

const RESULT_COLUMNS = {
  marker: ['marker', 'marcador', 'parámetro', 'parametro', 'analito', 'test', 'examen', 'prueba'],
  result: ['result', 'resultado', 'valor', 'value'],
  unit: ['unit', 'unidad'],
  range: ['reference', 'referencia', 'rango', 'range'],
  flag: ['flag', 'estado', 'status'],
};

function columnIndex(headers, wanted) {
  const lower = headers.map((h) => stripMd(h).toLowerCase());
  return lower.findIndex((h) => wanted.some((w) => h.includes(w)));
}

const PARAGRAPH_LINE_RE = /^\s*[-*|#>]/;

/**
 * Structural outline of one H2 section: heading, counts of key bullets, plain
 * bullets, checkboxes and paragraph lines, and each table's headers with its
 * row count. Cell values and sentences stay in the note.
 */
export function outlineSection(section) {
  const fields = parseKeyBullets(section.lines).length;
  const checkboxes = parseCheckboxes(section.lines);
  const bullets = section.lines.filter((l) => BULLET_RE.test(l.text)).length - fields - checkboxes.length;
  const tables = parseTables(section.lines);
  // parseTables treats any line holding a pipe as a table line, so the same test keeps table rows out of the paragraph count.
  const paragraphs = section.lines.filter((l) => l.text.trim() !== '' && !PARAGRAPH_LINE_RE.test(l.text) && !l.text.includes('|')).length;
  return {
    heading: section.heading,
    line: section.startLine,
    fieldsN: fields,
    bulletsN: Math.max(0, bullets),
    checkboxesN: checkboxes.length,
    openCheckboxesN: checkboxes.filter((c) => !c.checked).length,
    tables: tables.map((t) => ({ headers: t.headers.map(stripMd), rowsN: t.rows.length })),
    paragraphsN: paragraphs,
  };
}

/** One exam note → header, results rows (verbatim + numeric), follow-ups, pending signals. */
export function parseExamNote(text, relPath) {
  const name = path.basename(relPath);
  const fm = name.match(EXAM_FILE_RE);
  const sections = splitSections(text);
  const head = parseKeyBullets(sections[0].lines);
  const field = (...keys) =>
    head.find((h) => keys.some((k) => h.key.toLowerCase().includes(k)))?.value ?? null;
  const originalDocument = field('original document', 'documento original', 'original');
  const originalMissing = originalDocument !== null && ORIGINAL_MISSING_RE.test(stripMd(originalDocument));

  // Results live under "## Results" when the note has one. Lab notes that
  // spread their tables across several sections (CBC, Differential, …) are
  // read too, but only tables shaped like results — a result column *and* a
  // reference-range column — so prescription or dosing tables stay out.
  const resultsSection = findSection(sections, 'result', 'resultado');
  const looksLikeResults = (t) =>
    columnIndex(t.headers, RESULT_COLUMNS.result) !== -1 && columnIndex(t.headers, RESULT_COLUMNS.range) !== -1;
  const tables = resultsSection
    ? parseTables(resultsSection.lines)
    : sections.flatMap((s) => parseTables(s.lines)).filter(looksLikeResults);
  const results = [];
  let pendingResults = 0;
  for (const table of tables) {
    const idx = {
      marker: columnIndex(table.headers, RESULT_COLUMNS.marker),
      result: columnIndex(table.headers, RESULT_COLUMNS.result),
      unit: columnIndex(table.headers, RESULT_COLUMNS.unit),
      range: columnIndex(table.headers, RESULT_COLUMNS.range),
      flag: columnIndex(table.headers, RESULT_COLUMNS.flag),
    };
    const col = (row, i) => (i >= 0 && i < row.length ? row[i] : '');
    for (const row of table.rows) {
      const marker = stripMd(col(row, idx.marker === -1 ? 0 : idx.marker));
      const result = col(row, idx.result === -1 ? 1 : idx.result);
      const flag = stripMd(col(row, idx.flag));
      const pending = PENDING_RESULT_RE.test(stripMd(result)) || PENDING_RESULT_RE.test(flag);
      if (pending) pendingResults++;
      results.push({
        marker,
        result: stripMd(result),
        unit: stripMd(col(row, idx.unit)),
        range: stripMd(col(row, idx.range)),
        flag,
        numeric: numericValue(result),
        flagged: !pending && flag !== '' && !/^(ok|normal|—|-|n\/a)/i.test(flag),
        pending,
      });
    }
  }

  const followSection = findSection(sections, 'follow-up', 'seguimiento', 'pendiente');
  const followUps = followSection ? parseCheckboxes(followSection.lines) : [];

  // A note with no results-shaped table is a *narrative* note (visit,
  // ultrasound, prescription, …). Its distinct view is a per-section outline:
  // headings plus counts and table headers, never body text — the note itself
  // opens verbatim through /api/family-health/file.
  const kind = tables.length > 0 ? 'results' : 'narrative';

  return {
    path: toPosix(relPath),
    name,
    date: fm ? fm[1] : null,
    topic: fm ? fm[2].replaceAll('-', ' ') : name.replace(/\.md$/, ''),
    title: text.split(/\r?\n/).find((l) => l.startsWith('# '))?.slice(2).trim() ?? name,
    type: field('type', 'tipo'),
    orderedBy: field('ordered', 'solicitado', 'performed', 'physician', 'médico', 'medico'),
    facility: field('facility', 'lab', 'laboratorio'),
    reason: field('reason', 'motivo'),
    originalDocument,
    originalMissing,
    kind,
    hasResultsTable: kind === 'results',
    sections: sections.slice(1).map(outlineSection),
    results,
    flaggedN: results.filter((r) => r.flagged).length,
    pendingResultsN: pendingResults,
    followUps,
    openFollowUpsN: followUps.filter((f) => !f.checked).length,
  };
}

/* ----------------------------- profile / history ----------------------------- */

const MED_COLUMNS = {
  medication: ['medication', 'medicamento', 'fármaco', 'farmaco'],
  dose: ['dose', 'dosis'],
  frequency: ['frequency', 'frecuencia'],
  since: ['since', 'desde', 'inicio'],
  prescribedFor: ['prescribed', 'indicado', 'para', 'reason', 'motivo'],
};

function tableToObjects(table, columns) {
  if (!table) return [];
  const idx = Object.fromEntries(
    Object.entries(columns).map(([k, wanted]) => [k, columnIndex(table.headers, wanted)])
  );
  return table.rows
    .map((row) =>
      Object.fromEntries(
        Object.entries(idx).map(([k, i]) => [k, stripMd(i >= 0 && i < row.length ? row[i] : '')])
      )
    )
    .filter((o) => Object.values(o).some((v) => v !== '' && v !== '—' && v !== '-'));
}

const NONE_ROW_RE = /^(none|ninguno|ninguna|no recorded|not recorded|—|-)/i;

/** profile.md → identity, allergies, conditions, medications, care team, review date. */
export function parseProfile(text) {
  const sections = splitSections(text);
  const identity = parseKeyBullets(findSection(sections, 'identity', 'identidad')?.lines ?? []);
  const allergies = parseKeyBullets(findSection(sections, 'allerg', 'alergia')?.lines ?? []);
  const conditions = parseBullets(findSection(sections, 'chronic', 'crónic', 'cronic', 'condition')?.lines ?? [])
    .map(stripMd)
    .filter((c) => !NONE_ROW_RE.test(c));
  const medications = tableToObjects(
    parseTable(findSection(sections, 'medication', 'medicamento')?.lines ?? []),
    MED_COLUMNS
  ).filter((m) => !NONE_ROW_RE.test(m.medication));
  const careTeam = tableToObjects(
    parseTable(findSection(sections, 'care team', 'equipo')?.lines ?? []),
    { role: ['role', 'rol'], name: ['name', 'nombre'], contact: ['contact', 'contacto'], notes: ['notes', 'nota'] }
  ).filter((c) => c.name !== '' && c.name !== '—');
  const lastReviewed = text.match(/_Last reviewed:\s*([^_]+?)\s*_/)?.[1] ?? null;
  const title = text.split(/\r?\n/).find((l) => l.startsWith('# '))?.slice(2).trim() ?? null;
  return { title, identity, allergies, conditions, medications, careTeam, lastReviewed };
}

/** history.md → reverse-chronological entries [{date, title, line, fields[]}]. */
export function parseHistory(text) {
  const lines = text.split(/\r?\n/);
  const entries = [];
  lines.forEach((line, i) => {
    const h = line.match(H3_RE);
    if (!h) {
      if (entries.length) entries.at(-1).lines.push({ n: i + 1, text: line });
      return;
    }
    const m = h[1].match(HISTORY_ENTRY_RE);
    entries.push({
      date: m ? m[1] : null,
      title: m ? m[2].trim() : h[1],
      line: i + 1,
      lines: [],
    });
  });
  return entries.map(({ lines: body, ...e }) => ({ ...e, fields: parseKeyBullets(body) }));
}

/* ----------------------------- pending signals ----------------------------- */

/**
 * Explicit pending signals in one Markdown file. `date` is the exam date for
 * exam notes, the enclosing history entry date otherwise (null when none).
 */
export function collectPendingFromText(text, relPath, member, { examDate = null } = {}) {
  const items = [];
  let entryDate = examDate;
  text.split(/\r?\n/).forEach((line, i) => {
    const h = line.match(H3_RE);
    if (h && examDate === null) {
      const m = h[1].match(HISTORY_ENTRY_RE);
      entryDate = m ? m[1] : entryDate;
      return;
    }
    const cb = line.match(CHECKBOX_RE);
    if (cb) {
      if (cb[1] === ' ') {
        items.push({ kind: 'checkbox', member, path: toPosix(relPath), line: i + 1, date: entryDate, text: stripMd(cb[2]) });
      }
      return;
    }
    if (PENDING_MARKER_RE.test(line)) {
      items.push({ kind: 'marker', member, path: toPosix(relPath), line: i + 1, date: entryDate, text: stripMd(line.replace(/^\s*[-*>]\s*/, '')) });
    }
  });
  return items;
}

function pendingFromExam(exam, member) {
  const items = collectPendingFromText(exam.text, exam.path, member, { examDate: exam.note.date });
  for (const r of exam.note.results) {
    if (r.pending) {
      items.push({ kind: 'pending-result', member, path: exam.path, line: null, date: exam.note.date, text: `${r.marker}: ${r.result}` });
    }
  }
  if (exam.note.originalMissing) {
    items.push({ kind: 'original-missing', member, path: exam.path, line: null, date: exam.note.date, text: `Original document not attached — ${exam.note.title}` });
  }
  return items;
}

/* ----------------------------- filesystem ----------------------------- */

async function readIfExists(abs) {
  try {
    return await fs.readFile(abs, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'EISDIR') return null;
    throw err;
  }
}

async function wikiPathFor(config, slug) {
  const rel = `${WIKI_MEMBER_DIR}/${slug}.md`;
  try {
    const st = await fs.stat(path.join(config.REPO_ROOT, rel));
    return st.isFile() ? rel : null;
  } catch {
    return null;
  }
}

/** Member folders under members/ (stable name order), excluding _TEMPLATE and files. */
export async function listMembers(config) {
  const root = requireRoot(config);
  let dirents;
  try {
    dirents = await fs.readdir(path.join(root, MEMBERS_DIR), { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  const members = dirents
    .filter((d) => d.isDirectory() && d.name !== TEMPLATE_DIR && !d.name.startsWith('.'))
    .map((d) => d.name)
    .sort((a, b) => a.localeCompare(b));
  return Promise.all(
    members.map(async (name) => {
      const slug = slugify(name);
      return { name, slug, folder: `${MEMBERS_DIR}/${name}`, wikiPath: await wikiPathFor(config, slug) };
    })
  );
}

function memberFolder(config, name) {
  if (typeof name !== 'string' || name.length === 0) throw new BadMemberError('member is required');
  if (name === TEMPLATE_DIR || name.startsWith('.') || /[\\/]/.test(name) || name.includes('..')) {
    throw new BadMemberError('not a member');
  }
  // safeResolve re-checks traversal and confines the path to members/.
  return healthResolve(config, `${MEMBERS_DIR}/${name}`);
}

async function readExams(config, name) {
  const folder = memberFolder(config, name);
  const rel = `${MEMBERS_DIR}/${name}/exams`;
  let files;
  try {
    files = (await fs.readdir(path.join(folder, 'exams'))).filter((f) => f.endsWith('.md'));
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  const exams = [];
  for (const f of files.sort()) {
    if (!EXAM_FILE_RE.test(f)) continue; // the copied template placeholder is not an exam
    const relPath = `${rel}/${f}`;
    const text = await fs.readFile(healthResolve(config, relPath), 'utf8');
    exams.push({ path: relPath, text, note: parseExamNote(text, relPath) });
  }
  return exams;
}

async function readDocuments(config, name) {
  const folder = memberFolder(config, name);
  let dirents;
  try {
    dirents = await fs.readdir(path.join(folder, 'documents'), { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  const docs = [];
  for (const d of dirents.filter((d) => d.isFile() && d.name !== 'README.md').sort((a, b) => a.name.localeCompare(b.name))) {
    const abs = path.join(folder, 'documents', d.name);
    const st = await fs.stat(abs);
    docs.push({
      name: d.name,
      ext: path.extname(d.name).slice(1).toLowerCase(),
      size: st.size,
      absolutePath: abs,
    });
  }
  return docs;
}

const examSummary = ({ note }) => ({
  path: note.path,
  name: note.name,
  date: note.date,
  title: note.title,
  type: note.type,
  facility: note.facility,
  resultsN: note.results.length,
  flaggedN: note.flaggedN,
  pendingResultsN: note.pendingResultsN,
  openFollowUpsN: note.openFollowUpsN,
  originalMissing: note.originalMissing,
  kind: note.kind,
  hasResultsTable: note.hasResultsTable,
  orderedBy: note.orderedBy,
  reason: note.reason,
  sections: note.sections,
});

/** One member's file: profile, timeline, exam summaries, documents, pending items, markers. */
export async function readMember(config, name) {
  const folder = memberFolder(config, name);
  const members = await listMembers(config);
  const member = members.find((m) => m.name === name);
  if (!member) {
    const err = new Error('no such member');
    err.code = 'ENOENT';
    throw err;
  }
  const [profileText, historyText, exams, documents] = await Promise.all([
    readIfExists(path.join(folder, 'profile.md')),
    readIfExists(path.join(folder, 'history.md')),
    readExams(config, name),
    readDocuments(config, name),
  ]);
  const profile = profileText === null ? null : parseProfile(profileText);
  const history = historyText === null ? [] : parseHistory(historyText);

  const pending = [
    ...(profileText === null ? [] : collectPendingFromText(profileText, `${member.folder}/profile.md`, name)),
    ...(historyText === null ? [] : collectPendingFromText(historyText, `${member.folder}/history.md`, name)),
    ...exams.flatMap((e) => pendingFromExam(e, name)),
  ];

  const markerCounts = new Map();
  for (const e of exams) {
    for (const r of e.note.results) {
      if (r.numeric === null || r.marker === '') continue;
      const key = r.marker.toLowerCase();
      const cur = markerCounts.get(key) ?? { marker: r.marker, n: 0 };
      cur.n++;
      markerCounts.set(key, cur);
    }
  }
  const markers = [...markerCounts.values()].sort((a, b) => b.n - a.n || a.marker.localeCompare(b.marker));
  const dates = exams.map((e) => e.note.date).filter(Boolean).sort();

  return {
    member,
    notice: PHYSICIAN_NOTICE,
    profile,
    profileMissing: profileText === null,
    historyMissing: historyText === null,
    history,
    exams: exams.map(examSummary),
    documents,
    pending,
    markers,
    stats: {
      examsN: exams.length,
      narrativeN: exams.filter((e) => e.note.kind === 'narrative').length,
      documentsN: documents.length,
      medicationsN: profile?.medications.length ?? 0,
      conditionsN: profile?.conditions.length ?? 0,
      openFollowUpsN: exams.reduce((n, e) => n + e.note.openFollowUpsN, 0),
      flaggedN: exams.reduce((n, e) => n + e.note.flaggedN, 0),
      originalsMissingN: exams.filter((e) => e.note.originalMissing).length,
      pendingN: pending.length,
      firstExamDate: dates[0] ?? null,
      lastExamDate: dates.at(-1) ?? null,
    },
  };
}

/** family-overview.md table → rows keyed by member name (verbatim cells). */
export async function readOverview(config) {
  const text = await readIfExists(healthResolve(config, 'family-overview.md'));
  if (text === null) return { present: false, rows: [] };
  const table = parseTable(text.split(/\r?\n/));
  if (!table) return { present: true, rows: [] };
  const idx = {
    member: columnIndex(table.headers, ['member', 'miembro', 'nombre', 'name']),
    dob: columnIndex(table.headers, ['birth', 'nacimiento', 'dob']),
    bloodType: columnIndex(table.headers, ['blood', 'sangre']),
    keyConditions: columnIndex(table.headers, ['condition', 'condici']),
    lastUpdated: columnIndex(table.headers, ['updated', 'actualiz']),
  };
  const cell = (row, i) => stripMd(i >= 0 && i < row.length ? row[i] : '');
  return {
    present: true,
    rows: table.rows.map((row) => ({
      member: cell(row, idx.member === -1 ? 0 : idx.member).replace(/\[([^\]]+)\]\([^)]*\)/, '$1'),
      dob: cell(row, idx.dob),
      bloodType: cell(row, idx.bloodType),
      keyConditions: cell(row, idx.keyConditions),
      lastUpdated: cell(row, idx.lastUpdated),
    })),
  };
}

/** Pending items across every member plus reference/*.md checklists and markers. */
export async function collectPending(config) {
  const members = await listMembers(config);
  const items = [];
  for (const m of members) {
    const file = await readMember(config, m.name);
    items.push(...file.pending);
  }
  const root = requireRoot(config);
  let refFiles = [];
  try {
    refFiles = (await fs.readdir(path.join(root, 'reference'))).filter((f) => f.endsWith('.md') && f !== 'README.md').sort();
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  for (const f of refFiles) {
    const rel = `reference/${f}`;
    const text = await fs.readFile(healthResolve(config, rel), 'utf8');
    items.push(...collectPendingFromText(text, rel, null));
  }
  const byKind = {};
  for (const it of items) byKind[it.kind] = (byKind[it.kind] ?? 0) + 1;
  return { notice: PHYSICIAN_NOTICE, items, total: items.length, byKind, generatedAt: new Date().toISOString() };
}

/** Family dashboard: one row per member with counts, plus totals. */
export async function summarize(config) {
  const [members, overview] = await Promise.all([listMembers(config), readOverview(config)]);
  const rows = [];
  for (const m of members) {
    const file = await readMember(config, m.name);
    const ov = overview.rows.find((r) => r.member.toLowerCase() === m.name.toLowerCase()) ?? null;
    rows.push({
      ...m,
      overview: ov,
      profileMissing: file.profileMissing,
      historyMissing: file.historyMissing,
      ...file.stats,
    });
  }
  const totals = rows.reduce(
    (t, r) => ({
      membersN: t.membersN + 1,
      examsN: t.examsN + r.examsN,
      narrativeN: t.narrativeN + r.narrativeN,
      documentsN: t.documentsN + r.documentsN,
      medicationsN: t.medicationsN + r.medicationsN,
      openFollowUpsN: t.openFollowUpsN + r.openFollowUpsN,
      flaggedN: t.flaggedN + r.flaggedN,
      originalsMissingN: t.originalsMissingN + r.originalsMissingN,
      pendingN: t.pendingN + r.pendingN,
      lastExamDate: [t.lastExamDate, r.lastExamDate].filter(Boolean).sort().at(-1) ?? null,
    }),
    { membersN: 0, examsN: 0, narrativeN: 0, documentsN: 0, medicationsN: 0, openFollowUpsN: 0, flaggedN: 0, originalsMissingN: 0, pendingN: 0, lastExamDate: null }
  );
  return {
    notice: PHYSICIAN_NOTICE,
    overviewPresent: overview.present,
    members: rows,
    totals,
    generatedAt: new Date().toISOString(),
  };
}

/**
 * Numeric series for one marker across a member's exam notes. Each point
 * carries the unit and reference range printed on its own note; there is no
 * universal threshold. Non-numeric results are counted in `excludedN`.
 */
export async function trendSeries(config, name, marker) {
  if (typeof marker !== 'string' || marker.trim() === '') throw new BadMemberError('marker is required');
  const exams = await readExams(config, name);
  const wanted = marker.trim().toLowerCase();
  const points = [];
  let excludedN = 0;
  for (const e of exams) {
    for (const r of e.note.results) {
      if (r.marker.toLowerCase() !== wanted) continue;
      if (r.numeric === null) {
        excludedN++;
        continue;
      }
      points.push({ date: e.note.date, value: r.numeric, result: r.result, unit: r.unit, range: r.range, flag: r.flag, path: e.path, facility: e.note.facility });
    }
  }
  points.sort((a, b) => (a.date ?? '').localeCompare(b.date ?? ''));
  return { member: name, marker: marker.trim(), notice: PHYSICIAN_NOTICE, points, excludedN };
}

/** Read one Markdown file inside the health root (verbatim body, no frontmatter parsing). */
export async function readHealthFile(config, relPath) {
  const abs = healthResolve(config, relPath);
  if (!abs.endsWith('.md')) {
    const err = new Error('only Markdown is served');
    err.code = 'ENOENT';
    throw err;
  }
  const [markdown, stat] = await Promise.all([fs.readFile(abs, 'utf8'), fs.stat(abs)]);
  const normalized = toPosix(path.relative(requireRoot(config), abs));
  return {
    name: path.basename(normalized),
    path: normalized,
    absolutePath: abs,
    markdown,
    mtime: new Date(stat.mtimeMs).toISOString(),
  };
}
