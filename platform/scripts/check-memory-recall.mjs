// check:memory-recall — groundtruth for Memory Query's question-first recall.
//
// The console's BM25F recall (server/src/recall.js + the loader in
// server/src/memory.js) is a mirror of the memory repo's
// scripts/aos_wiki/recall.py. A second JS port inside this check would only
// prove that two ports agree with each other, so the reference itself is the
// truth here: for every question, this check runs the memory repo's own
// `python3 scripts/wiki_recall.py --root <REPO_ROOT> --top 100000 [...]`
// (its public CLI plus its documented `--root` seam; it writes nothing) and
// compares its output with GET /api/memory/query on the real server booted on
// an ephemeral loopback port.
//
// Compared per question, in both modes (default and include-history): pages
// indexed, pages sharing a word, the ranked path list (the console's first 50
// against the reference's full list), each score (the reference prints one
// decimal: |console − ref| ≤ 0.05), and each hit's tags and truncated summary
// lines. Python sums scores over a hash-ordered set, so its own totals can
// move by an ulp: an order difference is forgiven only among pages whose
// console scores are within 1e-9 of each other.
//
// Cannot establish groundtruth (no python3, no scripts/wiki_recall.py under
// REPO_ROOT, a non-zero exit, unparseable output) → exit 2, never a pass.
// Output names questions, paths and scores only — never page text; questions
// derived from live page titles are labelled by the page's path.
//
// This is a developer/VPS check: it is not on the Phase-3 executable
// allowlist (ADR-0001) and not in `npm run verify` (it needs Python + PyYAML).
//
// Usage: REPO_ROOT=<memory repo> node scripts/check-memory-recall.mjs
import { spawn } from 'node:child_process';
import fssync from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const platformDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const serverEntry = path.join(platformDir, 'server', 'src', 'index.js');
const repoRoot = process.env.REPO_ROOT
  ? path.resolve(process.env.REPO_ROOT.replace(/^~(?=\/|$)/, process.env.HOME ?? '~'))
  : path.resolve(platformDir, '..');
const referenceScript = path.join(repoRoot, 'scripts', 'wiki_recall.py');

const RESULT_LIMIT = 50;
const SCORE_TOLERANCE = 0.05 + 1e-9;
const TIE_EPSILON = 1e-9;

// Generic harness questions written for this check (not the memory repo's golden set).
const FIXED_QUESTIONS = [
  'how does the maintenance pass work?',
  'which checks does wiki lint run?',
  'code review checklist',
  'runtime 4.5.2 vs 4.8',
  'revisión del proceso de captura',
  'how is it', // stopwords only: no page shares a word
  'zzqxv', // nonsense: zero matches on both sides
];

class NoGroundtruth extends Error {}

// ---------- reference side ----------

function runReference(question, includeHistory) {
  const args = [referenceScript, '--root', repoRoot, '--top', '100000'];
  if (includeHistory) args.push('--include-history');
  args.push(question);
  return new Promise((resolve, reject) => {
    const child = spawn('python3', args, { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (err) => reject(new NoGroundtruth(`cannot run python3: ${err.message}`)));
    child.on('close', (code) => {
      if (code !== 0) reject(new NoGroundtruth(`wiki_recall.py exited ${code}: ${stderr.trim().slice(0, 300)}`));
      else resolve(parseReference(stdout));
    });
  });
}

/** Parse wiki_recall.py's documented text output. */
function parseReference(text) {
  const lines = text.split('\n');
  const field = (re) => {
    const line = lines.find((l) => re.test(l));
    if (!line) throw new NoGroundtruth(`unparseable wiki_recall.py output (no line matching ${re})`);
    return Number(line.match(re)[1]);
  };
  const indexed = field(/^- pages indexed: (\d+)$/);
  const matched = field(/^- pages sharing a word with the question: (\d+)$/);
  const hits = [];
  for (let i = 0; i < lines.length; i += 1) {
    const m = lines[i].match(/^ *(\d+)\. (.+) {2}\(score (\d+\.\d)\)$/);
    if (!m) continue;
    const extra = [];
    while (i + 1 < lines.length && lines[i + 1].startsWith('    ')) extra.push(lines[(i += 1)].slice(4));
    hits.push({ path: m[2], score: Number(m[3]), lines: extra });
  }
  if (hits.length !== matched) {
    throw new NoGroundtruth(`unparseable wiki_recall.py output (${hits.length} hits parsed, ${matched} announced)`);
  }
  return { indexed, matched, hits };
}

// ---------- questions derived from the live repo (never written to disk) ----------

function derivedQuestions() {
  const skip = new Set(['index.md', 'log.md', '_template.md']);
  const files = [];
  const walk = (rel) => {
    for (const entry of fssync.readdirSync(path.join(repoRoot, rel), { withFileTypes: true })) {
      const p = `${rel}/${entry.name}`;
      if (entry.isDirectory()) walk(p);
      else if (entry.isFile() && entry.name.endsWith('.md') && !skip.has(entry.name)) files.push(p);
    }
  };
  walk('wiki');
  files.sort();
  const out = [];
  files.forEach((p, i) => {
    if (i % 10 !== 0) return;
    const h1 = fssync.readFileSync(path.join(repoRoot, p), 'utf8').match(/(?:^|\n)#[ \t]+([^\n]+)/);
    if (h1 && h1[1].trim()) out.push({ question: h1[1].trim(), label: `title of ${p}` });
  });
  return out;
}

// ---------- console side ----------

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
          if (res.statusCode !== 200) reject(new Error(`${reqPath} → ${res.statusCode}`));
          else resolve(JSON.parse(body));
        });
      })
      .on('error', reject);
  });
}

// ---------- comparison ----------

/** The lines wiki_recall.py prints under a hit, rebuilt from the console's result. */
const consoleLines = (r) => [...(r.tags.length ? [`tags: ${r.tags.join(', ')}`] : []), ...(r.summary ? [r.summary] : [])];
const fmt = (s) => (typeof s === 'number' ? s.toFixed(4) : String(s));

function compare(consoleBody, ref) {
  const problems = [];
  let forgiven = 0;
  if (consoleBody.pagesIndexed !== ref.indexed) problems.push(`pages indexed: console ${consoleBody.pagesIndexed}, reference ${ref.indexed}`);
  if (consoleBody.pagesMatched !== ref.matched) problems.push(`pages sharing a word: console ${consoleBody.pagesMatched}, reference ${ref.matched}`);
  const wantLen = Math.min(ref.matched, RESULT_LIMIT);
  if (consoleBody.results.length !== wantLen) problems.push(`results: console ${consoleBody.results.length}, expected ${wantLen}`);
  if (consoleBody.truncated !== ref.matched > RESULT_LIMIT) problems.push(`truncated: console ${consoleBody.truncated}, reference has ${ref.matched}`);

  const results = consoleBody.results;
  const refByPath = new Map(ref.hits.map((h) => [h.path, h]));
  for (let s = 0; s < results.length && problems.length === 0; ) {
    // A run of console results tied to within TIE_EPSILON may come out in any order on the reference side.
    let e = s + 1;
    while (e < results.length && Math.abs(results[e - 1].score - results[e].score) < TIE_EPSILON) e += 1;
    const group = results.slice(s, e).map((r) => r.path);
    const exact = group.every((p, k) => ref.hits[s + k]?.path === p);
    if (!exact) {
      // Same positions on the reference side, as a set; a tie run cut by the 50 cap may
      // draw from the reference's tail (each score is still checked below).
      const atCap = e === results.length && ref.matched > RESULT_LIMIT;
      const window = new Set(ref.hits.slice(s, atCap ? undefined : e).map((h) => h.path));
      if (e - s > 1 && group.every((p) => window.has(p))) {
        forgiven += 1;
      } else {
        const k = group.findIndex((p, j) => ref.hits[s + j]?.path !== p);
        const c = results[s + k];
        const r = ref.hits[s + k];
        problems.push(`rank ${s + k + 1}: console ${c.path} (${fmt(c.score)}), reference ${r ? `${r.path} (${r.score.toFixed(1)})` : '—'}`);
        break;
      }
    }
    s = e;
  }
  if (problems.length === 0) {
    for (const r of results) {
      const h = refByPath.get(r.path);
      if (Math.abs(r.score - h.score) > SCORE_TOLERANCE) {
        problems.push(`score of ${r.path}: console ${fmt(r.score)}, reference ${h.score.toFixed(1)}`);
        break;
      }
      if (JSON.stringify(consoleLines(r)) !== JSON.stringify(h.lines)) {
        problems.push(`tags/summary lines of ${r.path} differ`);
        break;
      }
    }
  }
  return { problems, forgiven };
}

// ---------- run ----------

if (!fssync.existsSync(referenceScript)) {
  console.error(`✖ cannot establish groundtruth: ${referenceScript} is missing (REPO_ROOT must be the memory repo)`);
  process.exit(2);
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
let compared = 0;
let forgivenTotal = 0;
let exitCode = 0;
// The boot wait sits inside try/finally so a boot timeout or early exit
// still reaches child.kill() and never leaks a server process.
try {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server boot timeout; stderr: ${stderr}`)), 8000);
    child.stdout.on('data', () => {
      if (stdout.includes('listening on')) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.on('exit', (code) => reject(new Error(`server exited early (${code}); stderr: ${stderr}`)));
  });

  const questions = [...FIXED_QUESTIONS.map((q) => ({ question: q, label: JSON.stringify(q) })), ...derivedQuestions()];
  for (const { question, label } of questions) {
    for (const includeHistory of [false, true]) {
      const mode = includeHistory ? 'include-history' : 'default';
      const [consoleBody, ref] = await Promise.all([
        getJson(port, `/api/memory/query?topic=${encodeURIComponent(question)}${includeHistory ? '&includeHistory=1' : ''}`),
        runReference(question, includeHistory),
      ]);
      const { problems, forgiven } = compare(consoleBody, ref);
      compared += 1;
      forgivenTotal += forgiven;
      if (problems.length) failed += 1;
      const counts = `${ref.matched}/${ref.indexed} pages${forgiven ? `, ${forgiven} tie order(s) forgiven` : ''}`;
      console.log(`${problems.length ? '✖' : '✔'} ${label} [${mode}]: ${counts}`);
      for (const p of problems) console.log(`    ${p}`);
    }
  }
} catch (err) {
  failed += 1;
  if (err instanceof NoGroundtruth) exitCode = 2;
  console.error(`✖ ${err instanceof NoGroundtruth ? 'cannot establish groundtruth: ' : ''}${err.message}`);
} finally {
  child.kill('SIGTERM');
}

if (exitCode === 0 && failed > 0) exitCode = 1;
console.log(
  exitCode === 0
    ? `\ncheck:memory-recall PASS — ${compared} question/mode runs match wiki_recall.py, ${forgivenTotal} tie order(s) forgiven (repo: ${repoRoot})`
    : `\ncheck:memory-recall FAIL — ${exitCode === 2 ? 'no groundtruth' : `${failed} mismatching run(s)`} (repo: ${repoRoot})`
);
process.exit(exitCode);
