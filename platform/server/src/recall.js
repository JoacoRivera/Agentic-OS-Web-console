/**
 * Question-first wiki recall — a line-for-line port of the memory repo's
 * `scripts/aos_wiki/recall.py` (the code behind `python3 scripts/wiki_recall.py`,
 * the first step of `AGENTS.md` §Query). The memory repo's script is the
 * reference and this module is its mirror: when `recall.py` changes, this file
 * and `scripts/check-memory-recall.mjs` change with it.
 *
 * BM25F over five page fields (title, tags, summary, path, text), each
 * length-normalised against its own average; history pages (eval results,
 * worked examples) are scored at half weight unless `includeHistory`.
 * Lexical: it matches words, not meaning.
 *
 * Pure: no I/O, no shell, no Skill/LLM (ADR-0001). The page set it ranks is
 * built by `memory.js` from wiki/** only (ADR-0005).
 *
 * Python parity notes (each one is unit-tested):
 * - Lines are split the way Python's `str.splitlines()` splits them, and
 *   `strip()`/`\s` use Python's `str.isspace()` set, not JS's.
 * - Accent folding drops exactly the characters `unicodedata.combining()`
 *   reports as non-zero (see `isCombining`), not every `\p{M}`.
 * - Ties sort by code-point order of the path, never `localeCompare`.
 */

/** BM25F field weights (`FIELD_WEIGHTS` in recall.py). Iteration order matters for float parity. */
export const FIELD_WEIGHTS = Object.freeze({ title: 3, tags: 2, summary: 2, path: 1, text: 1 });
/** Per-field length normalisation, BM25's `b` (`FIELD_B` in recall.py). */
export const FIELD_B = Object.freeze({ title: 0.5, tags: 0.5, summary: 0.5, path: 0.5, text: 0.3 });
export const BM25_K1 = 1.2;
export const HISTORY_MARKERS = Object.freeze(['/evals/results/', '/examples/']);
export const HISTORY_WEIGHT = 0.5;

/** Verbatim from recall.py: EN / ES / DE function words. */
export const STOPWORDS = new Set(
  `
a an and are as at be but by can do does for from has have how i if in is it its of on
or that the their there this to was what when where which who why will with
al como con cual cuando de del donde el en es esta este la las lo los para por porque
que se si sin sobre son su sus un una y
als auch auf aus bei das dem den der des die ein eine er es fur im ist mit nach nicht
oder sich sie sind und von was wie wird zu
`.split(/\s+/).filter(Boolean)
);

// Python `str.isspace()` characters (also what `\s` matches in a Python str regex).
const PY_WS = '\\t\\n\\v\\f\\r\\x1c-\\x20\\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000';
const PY_WS_RUN = new RegExp(`[${PY_WS}]+`, 'g');
const PY_STRIP = new RegExp(`^[${PY_WS}]+|[${PY_WS}]+$`, 'g');
const PY_RSTRIP = new RegExp(`[${PY_WS}]+$`);

/** Python `str.strip()`. */
export function pyStrip(s) {
  return s.replace(PY_STRIP, '');
}

/** Python `str.rstrip()`. */
export function pyRstrip(s) {
  return s.replace(PY_RSTRIP, '');
}

// Python `str.splitlines()` boundaries.
const PY_LINE_BREAK = /\r\n|[\n\r\v\f\x1c\x1d\x1e\x85\u2028\u2029]/;

/** Python `str.splitlines()`: no trailing empty line, `''` → `[]`. */
export function pyLines(text) {
  const lines = text.split(PY_LINE_BREAK);
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/**
 * `unicodedata.combining(ch) != 0`. JS has no canonical-combining-class API,
 * but canonical reordering exposes it: NFD swaps U+0345 (ccc 240, the
 * highest class but for nothing) with a following mark whose class is in
 * 1..239. Every ccc>0 character is a `\p{M}`, so only marks are probed.
 */
const PROBE = '\u0345';
const combiningCache = new Map();
function isCombining(ch) {
  let v = combiningCache.get(ch);
  if (v === undefined) {
    v = ch === PROBE || (PROBE + ch).normalize('NFD') !== PROBE + ch;
    combiningCache.set(ch, v);
  }
  return v;
}

// `\d` in a Python str regex is any Unicode decimal digit (Nd).
const TOKEN_RE = /\p{Nd}+(?:\.\p{Nd}+)+|[a-z0-9]+/gu;

/**
 * Lowercase, accent-folded word tokens without stopwords; a dotted version is
 * one token, and one with three or more parts also yields its `major.minor`.
 */
export function tokenize(text) {
  const folded = text.toLowerCase().normalize('NFKD').replace(/\p{M}/gu, (ch) => (isCombining(ch) ? '' : ch));
  const tokens = [];
  for (const [token] of folded.matchAll(TOKEN_RE)) {
    // Python's len() counts code points, not UTF-16 units.
    if ([...token].length <= 1 || STOPWORDS.has(token)) continue;
    tokens.push(token);
    const parts = token.split('.');
    if (parts.length >= 3) tokens.push(parts.slice(0, 2).join('.'));
  }
  return tokens;
}

/** `_full_summary`: the whole first run of `>` lines, joined, whitespace collapsed. */
export function fullSummary(body) {
  const lines = [];
  for (const line of pyLines(body)) {
    if (line.startsWith('>')) lines.push(pyStrip(line.slice(1)));
    else if (lines.length) break;
  }
  return pyStrip(lines.join(' ').replace(PY_WS_RUN, ' '));
}

/** `^#[ \t]+(.+)$` under Python's `re.M`, whose `^`/`$`/`.` only know `\n` (the JS `m` flag would also break on U+2028/U+2029). */
const TITLE_RE = /(?:^|\n)#[ \t]+([^\n]+)/;

/** The page title: the first H1 in the body, else the filename stem. */
export function pageTitle(body, filePath) {
  const m = body.match(TITLE_RE);
  if (m) return pyStrip(m[1]);
  const base = filePath.slice(filePath.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(0, dot) : base;
}

/** `_text_field`: the body without its first `#` title line and the first `>` block. */
export function textField(body) {
  const lines = pyLines(body);
  const titleAt = lines.findIndex((line) => /^#[ \t]/.test(line));
  if (titleAt !== -1) lines.splice(titleAt, 1);
  const start = lines.findIndex((line) => line.startsWith('>'));
  if (start !== -1) {
    let end = start;
    while (end < lines.length && lines[end].startsWith('>')) end += 1;
    lines.splice(start, end - start);
  }
  return lines.join('\n');
}

/** `_path_field`: the repo-relative path minus `wiki/` and `.md`. */
export function pathField(p) {
  return p.replace(/^wiki\//, '').replace(/\.md$/, '');
}

/** A page's tokens per BM25F field. `page` = {path, title, tags, summary, body}. */
export function fieldsOf(page) {
  return {
    title: tokenize(page.title),
    tags: tokenize(page.tags.join(' ')),
    summary: tokenize(page.summary),
    path: tokenize(pathField(page.path)),
    text: tokenize(textField(page.body)),
  };
}

export function isHistory(p) {
  const probe = `/${p}`;
  return HISTORY_MARKERS.some((marker) => probe.includes(marker));
}

/** Python str ordering: code points, not UTF-16 units and never locale. */
export function comparePaths(a, b) {
  if (a === b) return 0;
  const A = [...a];
  const B = [...b];
  const n = Math.min(A.length, B.length);
  for (let i = 0; i < n; i += 1) {
    if (A[i] !== B[i]) return A[i].codePointAt(0) < B[i].codePointAt(0) ? -1 : 1;
  }
  return A.length < B.length ? -1 : 1;
}

function counter(tokens) {
  const m = new Map();
  for (const t of tokens) m.set(t, (m.get(t) ?? 0) + 1);
  return m;
}

/** BM25F (Robertson & Zaragoza's simple form). `documents`: Map/obj path → {field: tokens[]}. */
export class Bm25Index {
  constructor(documents, { weights = FIELD_WEIGHTS, b = FIELD_B } = {}) {
    this.weights = { ...weights };
    this.names = Object.keys(this.weights);
    this.b = Object.fromEntries(this.names.map((name) => [name, b[name] ?? 0.75]));
    const entries = documents instanceof Map ? [...documents] : Object.entries(documents);
    this.paths = entries.map(([p]) => p).sort(comparePaths);
    const docs = new Map(entries);
    this.frequencies = new Map();
    this.lengths = new Map();
    for (const p of this.paths) {
      const fields = docs.get(p);
      this.frequencies.set(p, Object.fromEntries(this.names.map((name) => [name, counter(fields[name] ?? [])])));
      this.lengths.set(p, Object.fromEntries(this.names.map((name) => [name, (fields[name] ?? []).length])));
    }
    const count = this.paths.length;
    this.averageLength = {};
    for (const name of this.names) {
      let sum = 0;
      for (const lengths of this.lengths.values()) sum += lengths[name];
      this.averageLength[name] = count ? sum / count : 0;
    }
    const df = new Map();
    for (const fields of this.frequencies.values()) {
      const seen = new Set();
      for (const name of this.names) for (const term of fields[name].keys()) seen.add(term);
      for (const term of seen) df.set(term, (df.get(term) ?? 0) + 1);
    }
    this.idf = new Map();
    for (const [term, d] of df) this.idf.set(term, Math.log(1 + (count - d + 0.5) / (d + 0.5)));
  }

  pseudoFrequency(term, p) {
    let total = 0;
    const freqs = this.frequencies.get(p);
    const lengths = this.lengths.get(p);
    for (const name of this.names) {
      const tf = freqs[name].get(term) ?? 0;
      if (!tf) continue;
      const average = this.averageLength[name];
      const ratio = average ? lengths[name] / average : 1;
      total += (this.weights[name] * tf) / (1 - this.b[name] + this.b[name] * ratio);
    }
    return total;
  }

  score(tokens, p) {
    let total = 0;
    for (const term of new Set(tokens)) {
      const tf = this.pseudoFrequency(term, p);
      if (tf) total += (this.idf.get(term) * tf * (BM25_K1 + 1)) / (tf + BM25_K1);
    }
    return total;
  }
}

/**
 * Every page with its score for `question`, best first; ties break on path.
 * History pages are scored at HISTORY_WEIGHT unless `includeHistory`.
 * Returns [{page, score, history}] — including zero scores, as recall.py does.
 */
export function recall(question, pages, { includeHistory = false } = {}) {
  const index = new Bm25Index(new Map(pages.map((page) => [page.path, fieldsOf(page)])));
  const tokens = tokenize(question);
  const scored = pages.map((page) => {
    const history = isHistory(page.path);
    let score = index.score(tokens, page.path);
    if (!includeHistory && history) score *= HISTORY_WEIGHT;
    return { page, score, history };
  });
  return scored.sort((a, b) => b.score - a.score || comparePaths(a.page.path, b.page.path));
}
