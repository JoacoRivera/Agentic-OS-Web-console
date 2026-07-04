// check:hud-parity — MIGRATION-ONLY gate (migrationOnly: true, ADR-0002).
// NOT part of the permanent executable allowlist; retired by an explicit
// human HUD-deprecation sign-off. The permanent correctness check is
// check:metrics-groundtruth (independent filesystem recount, no HUD
// dependency) — this script exists only to validate the HUD→console
// migration while both are around.
//
// It executes the REAL `dashboards/aos-hud.js` from the memory repo —
// byte-for-byte unchanged — inside a minimal Dataview shim over the live
// filesystem, extracts the numbers the HUD renders into its HTML, and
// compares them against the console's /api/metrics.
//
// Deliberately NOT compared (documented divergence, ADR-0003): the 30-day
// growth series and `last30`. The HUD keys them on fs ctime; the console
// keys them on pathAddedDate (git log --diff-filter=A). `projects`/
// `workflows` are computed by the HUD but never rendered, so they are not
// extractable here — check:metrics-groundtruth covers them.
//
// Usage: REPO_ROOT=<memory repo> node scripts/check-hud-parity.mjs
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
const hudPath = path.join(repoRoot, 'dashboards', 'aos-hud.js');

// ---------- minimal luxon DateTime shim (only what aos-hud.js touches) ----------

const DAY_MS = 86400e3;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const pad = (n) => String(n).padStart(2, '0');

class ShimDateTime {
  constructor(ms) {
    this.ms = ms;
  }
  static now() {
    return new ShimDateTime(Date.now());
  }
  static fromISO(s) {
    return new ShimDateTime(new Date(`${s}T00:00:00`).getTime());
  }
  static fromMillis(ms) {
    return new ShimDateTime(ms);
  }
  toMillis() {
    return this.ms;
  }
  startOf(unit) {
    if (unit !== 'day') throw new Error(`shim: startOf(${unit}) unsupported`);
    const d = new Date(this.ms);
    return new ShimDateTime(new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime());
  }
  endOf(unit) {
    if (unit !== 'day') throw new Error(`shim: endOf(${unit}) unsupported`);
    const d = new Date(this.ms);
    return new ShimDateTime(
      new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime() - 1
    );
  }
  plus({ days = 0 }) {
    const d = new Date(this.ms);
    d.setDate(d.getDate() + days);
    return new ShimDateTime(d.getTime());
  }
  minus({ days = 0 }) {
    return this.plus({ days: -days });
  }
  diff(other, unit) {
    if (unit !== 'days') throw new Error(`shim: diff(${unit}) unsupported`);
    return { days: (this.ms - other.ms) / DAY_MS };
  }
  toFormat(fmt) {
    const d = new Date(this.ms);
    return fmt.replace(/yyyy|LLL|LL|dd|HH|mm|ccc/g, (tok) => {
      switch (tok) {
        case 'yyyy': return String(d.getFullYear());
        case 'LLL': return MONTHS[d.getMonth()];
        case 'LL': return pad(d.getMonth() + 1);
        case 'dd': return pad(d.getDate());
        case 'HH': return pad(d.getHours());
        case 'mm': return pad(d.getMinutes());
        case 'ccc': return WEEKDAYS[d.getDay()];
        default: return tok;
      }
    });
  }
}

// ---------- minimal Dataview shim over the real filesystem ----------

function listPages(rootRel) {
  const pages = [];
  const stack = [rootRel];
  while (stack.length > 0) {
    const rel = stack.pop();
    const abs = path.join(repoRoot, rel);
    if (!fssync.existsSync(abs)) continue;
    for (const entry of fssync.readdirSync(abs, { withFileTypes: true })) {
      const relPath = `${rel}/${entry.name}`;
      if (entry.isDirectory()) {
        if (entry.name !== '.git') stack.push(relPath);
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        const stat = fssync.statSync(path.join(repoRoot, relPath));
        pages.push({
          file: {
            name: entry.name.slice(0, -3),
            path: relPath,
            folder: path.dirname(relPath),
            // Dataview's ctime is a creation time; birthtime falls back to
            // mtime on filesystems without one. Only series/last30 use it,
            // and those are excluded from the comparison (ADR-0003).
            ctime: new ShimDateTime(stat.birthtimeMs || stat.mtimeMs),
            mtime: new ShimDateTime(stat.mtimeMs),
          },
        });
      }
    }
  }
  return pages;
}

class DvArray extends Array {
  where(fn) {
    return DvArray.from(this.filter(fn));
  }
  array() {
    return [...this];
  }
}

const renderedRoots = [];
const dv = {
  luxon: { DateTime: ShimDateTime },
  pages(query) {
    // aos-hud.js only ever passes '"folder"' or '"a" or "b" or ...'.
    const folders = String(query)
      .split(/\s+or\s+/i)
      .map((part) => part.trim().replace(/^"|"$/g, ''));
    return DvArray.from(folders.flatMap(listPages));
  },
  io: {
    load: (relPath) => fs.readFile(path.join(repoRoot, relPath), 'utf8'),
  },
  el(tag, text, opts = {}) {
    const el = {
      cls: opts.cls ?? '',
      text: text ?? '',
      innerHTML: '',
      querySelectorAll: () => [],
    };
    renderedRoots.push(el);
    return el;
  },
  app: { workspace: { openLinkText() {} } },
};

async function runHud() {
  const code = await fs.readFile(hudPath, 'utf8');
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  await new AsyncFunction('dv', code)(dv);
  const errored = renderedRoots.find((el) => el.cls === 'aos-err');
  if (errored) throw new Error(`HUD script errored under the shim: ${errored.text}`);
  const root = renderedRoots.find((el) => el.cls === 'aos-hud');
  if (!root || !root.innerHTML) throw new Error('HUD rendered no aos-hud root');
  return root.innerHTML;
}

/** Pull the numbers the HUD actually renders out of its HTML. */
function extractHudNumbers(html) {
  const grab = (name, re, map = Number) => {
    const m = html.match(re);
    if (!m) throw new Error(`could not extract ${name} from HUD HTML`);
    return map(m[1]);
  };
  return {
    wikiN: grab('wikiN', /<b>(\d+)<\/b><span class="cap">\/ \d+ PAGES/),
    rawN: grab('rawN', /<b>(\d+)<\/b><span class="cap">\/ \d+ FILES/),
    all: grab('all', /· (\d+) FILES · \d+ LAST 30D/),
    examples: grab('examples', /· (\d+) EXAMPLES/),
    rawProj: grab('rawProj', /· (\d+)P · \d+W</),
    rawFlow: grab('rawFlow', /· \d+P · (\d+)W</),
    capN: grab('capN', /(\d+) CAPTURES/),
    draftN: grab('draftN', /(\d+) DRAFT</),
    apprN: grab('apprN', /(\d+) APPROVED</),
    weekTotal: grab('weekTotal', /<b>(\d+)<\/b><span class="cap">\/ \d+ EDITS/),
    activeDays: grab('activeDays', /· (\d+) ACTIVE DAYS/),
    healthStale: grab('healthStale', /HEALTH · (DUE|OK)</, (s) => s === 'DUE'),
    ageLabel: grab('ageLabel', /LAST RECONCILE <span class="hage">· ([^<]+)<\/span>/, String),
    trend: grab('trend', /class="dot"><\/span>(ACTIVE|IDLE)</, String),
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

console.log(
  'check:hud-parity — MIGRATION-ONLY (migrationOnly: true). Not in the permanent\n' +
    'executable allowlist; retired by an explicit human HUD-deprecation sign-off (ADR-0002).\n'
);

if (!fssync.existsSync(hudPath)) {
  console.error(`✖ HUD script not found: ${hudPath} — set REPO_ROOT to the memory repo.`);
  process.exit(1);
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

  const [metrics, hudHtml] = await Promise.all([getJson(port, '/api/metrics'), runHud()]);
  const hud = extractHudNumbers(hudHtml);

  const consoleSide = {
    ...metrics,
    healthStale: metrics.health.healthStale,
    ageLabel: metrics.health.ageLabel,
  };
  const check = (name) => {
    const got = consoleSide[name];
    const want = hud[name];
    const ok = JSON.stringify(got) === JSON.stringify(want);
    if (!ok) failed++;
    console.log(`${ok ? '✔' : '✖'} ${name}: console=${JSON.stringify(got)} hud=${JSON.stringify(want)}`);
  };

  for (const f of Object.keys(hud)) check(f);
  console.log(
    '\nskipped (deliberate divergence, ADR-0003): series, last30 — HUD uses fs ctime,\n' +
      'console uses pathAddedDate (git log --diff-filter=A).'
  );
} catch (err) {
  failed++;
  console.error(`✖ ${err.message}`);
} finally {
  child.kill('SIGTERM');
}

console.log(
  failed === 0
    ? `\ncheck:hud-parity PASS (repo: ${repoRoot})`
    : `\ncheck:hud-parity FAIL — ${failed} mismatch(es) (repo: ${repoRoot})`
);
process.exit(failed === 0 ? 0 : 1);
