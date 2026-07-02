// check:metrics-groundtruth — PERMANENT correctness check (ADR-0002).
// Boots the real server, fetches /api/metrics over HTTP, and compares it
// field-by-field against an INDEPENDENT filesystem recount implemented here
// from the documented rules (skip basenames index|log|_template|README;
// `all` = wiki+raw+templates+dashboards minus _template only; captures under
// raw `examples/` approved via a plain `Status:` body line; health from the
// first `lint` entry in wiki/log.md). It deliberately does NOT import
// `server/src/metrics.js` and does NOT reference `dashboards/aos-hud.js` —
// the filesystem is the source of truth, not the deprecated HUD.
//
// Usage: REPO_ROOT=<memory repo> node scripts/check-metrics-groundtruth.mjs
import { spawn } from 'node:child_process';
import fssync from 'node:fs';
import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

async function recount() {
  const wikiAll = listMd('wiki');
  const rawAll = listMd('raw');
  const wiki = wikiAll.filter((p) => !SKIP.has(base(p)));
  const raw = rawAll.filter((p) => !SKIP.has(base(p)));
  const allFiles = [...wikiAll, ...rawAll, ...listMd('templates'), ...listMd('dashboards')].filter(
    (p) => base(p) !== '_template'
  );

  const captures = raw.filter(inExamples);
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

let failed = 0;
try {
  const [console_, truth] = await Promise.all([getJson(port, '/api/metrics'), recount()]);

  const check = (name, got, want) => {
    const ok = JSON.stringify(got) === JSON.stringify(want);
    if (!ok) failed++;
    console.log(`${ok ? '✔' : '✖'} ${name}: console=${JSON.stringify(got)} recount=${JSON.stringify(want)}`);
  };

  for (const f of [
    'wikiN', 'rawN', 'all', 'examples', 'projects', 'workflows',
    'rawProj', 'rawFlow', 'capN', 'apprN', 'draftN',
  ]) {
    check(f, console_[f], truth[f]);
  }
  check('health.lastLint', console_.health.lastLint, truth.lastLint);
  check('health.lintAge', console_.health.lintAge, truth.lintAge);
  check('health.healthStale', console_.health.healthStale, truth.healthStale);

  // series sanity: cumulative, non-decreasing, ends at today's `all`
  const series = console_.series;
  const monotonic = series.every((s, i) => i === 0 || s.v >= series[i - 1].v);
  check('series is non-decreasing (30 pts)', { len: series.length, monotonic }, { len: 30, monotonic: true });
  check('series ends at all', series[series.length - 1].v, truth.all);
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
