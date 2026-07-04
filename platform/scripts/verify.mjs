// Boot smoke (Seam 2): asserts the process-lifecycle invariants an in-process
// app cannot exhibit (ADR-0005 bind + startup guard), plus a build check.
// Prints pass/fail per check and exits non-zero on any failure.
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const platformDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const serverEntry = path.join(platformDir, 'server', 'src', 'index.js');

const results = [];
function record(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? '✔' : '✖'} ${name}${detail ? ` — ${detail}` : ''}`);
}

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

function startServer(env) {
  const child = spawn(process.execPath, [serverEntry], {
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => (stdout += d));
  child.stderr.on('data', (d) => (stderr += d));
  return {
    child,
    get stdout() { return stdout; },
    get stderr() { return stderr; },
    waitListening: () =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timeout waiting for listen; stderr: ${stderr}`)), 8000);
        child.stdout.on('data', () => {
          if (stdout.includes('listening on')) {
            clearTimeout(timer);
            resolve();
          }
        });
        child.on('exit', (code) => {
          clearTimeout(timer);
          reject(new Error(`server exited early (code ${code}); stderr: ${stderr}`));
        });
      }),
    waitExit: () =>
      new Promise((resolve) => {
        const timer = setTimeout(() => {
          child.kill('SIGKILL');
          resolve(null);
        }, 8000);
        child.on('exit', (code) => {
          clearTimeout(timer);
          resolve(code);
        });
      }),
    stop: () =>
      new Promise((resolve) => {
        child.on('exit', resolve);
        child.kill('SIGTERM');
        setTimeout(() => child.kill('SIGKILL'), 3000).unref();
      }),
  };
}

// node:http (not fetch) so we can set forbidden headers like Host/Origin.
function req(port, { method = 'GET', reqPath = '/api/status', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request(
      { host: '127.0.0.1', port, path: reqPath, method, headers },
      (res) => {
        let body = '';
        res.on('data', (d) => (body += d));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
      }
    );
    r.on('error', reject);
    r.end();
  });
}

function run(cmd, args) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: platformDir, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('exit', (code) => resolve({ code, out }));
  });
}

const port = await freePort();

// --- checks against a real loopback boot ---
const server = startServer({ PORT: String(port), HOST: '127.0.0.1' });
try {
  await server.waitListening();
  record('server boots and reports listening', true);

  const bound = server.stdout.match(/listening on http:\/\/([^:]+):(\d+)/);
  record(
    'bound address is loopback (127.0.0.1), not 0.0.0.0',
    bound?.[1] === '127.0.0.1',
    bound ? `bound ${bound[1]}:${bound[2]}` : 'no listen line'
  );

  const ok = await req(port);
  record('/api/status responds 200 with status=ready', ok.status === 200 && JSON.parse(ok.body).status === 'ready');
  record('no permissive CORS header on responses', ok.headers['access-control-allow-origin'] === undefined);

  const met = await req(port, { reqPath: '/api/metrics' });
  const metBody = met.status === 200 ? JSON.parse(met.body) : {};
  record(
    '/api/metrics responds 200 with the documented shape',
    met.status === 200 &&
      ['wikiN', 'rawN', 'all', 'capN', 'draftN', 'apprN', 'weekTotal', 'trend'].every((f) => f in metBody) &&
      metBody.series?.length === 30 &&
      metBody.week?.length === 7 &&
      'healthStale' in (metBody.health ?? {})
  );

  const tree = await req(port, { reqPath: '/api/docs/tree' });
  record(
    '/api/docs/tree responds 200 with roots[]',
    tree.status === 200 && Array.isArray(JSON.parse(tree.body).roots)
  );

  const traversal = await req(port, { reqPath: '/api/docs/file?path=../../etc/passwd' });
  record('path traversal (?path=../../etc) is rejected (400)', traversal.status === 400);

  const rawGate = await req(port, { reqPath: '/api/docs/file?path=raw/anything.md' });
  record('raw content is hidden by default (403, ADR-0005)', rawGate.status === 403);

  const search = await req(port, { reqPath: '/api/docs/search?q=memory' });
  record(
    '/api/docs/search responds 200 with results[]',
    search.status === 200 && Array.isArray(JSON.parse(search.body).results)
  );
  const emptyQ = await req(port, { reqPath: '/api/docs/search' });
  record('search without q is rejected (400)', emptyQ.status === 400);

  const backlinks = await req(port, {
    reqPath: '/api/docs/backlinks?path=' + encodeURIComponent('wiki/index.md'),
  });
  record(
    '/api/docs/backlinks responds 200 with backlinks[]',
    backlinks.status === 200 && Array.isArray(JSON.parse(backlinks.body).backlinks)
  );
  const badBacklink = await req(port, {
    reqPath: '/api/docs/backlinks?path=' + encodeURIComponent('../../etc/passwd'),
  });
  record('backlinks path traversal is rejected (400)', badBacklink.status === 400);

  const wf = await req(port, { reqPath: '/api/workflows' });
  const wfBody = wf.status === 200 ? JSON.parse(wf.body) : {};
  record(
    '/api/workflows responds 200 with workflows[] + summary',
    wf.status === 200 && Array.isArray(wfBody.workflows) && typeof wfBody.summary?.total === 'number'
  );
  record(
    'no workflow status is inferred green: every row has a status + kind may be null',
    wf.status === 200 &&
      wfBody.workflows.every(
        (w) => ['missing-links', 'needs-review', 'unclassified', 'stale', 'ok'].includes(w.status) &&
          (w.kind === null || typeof w.kind === 'string')
      )
  );

  const wfOne =
    wfBody.workflows?.length > 0
      ? await req(port, { reqPath: '/api/workflow?path=' + encodeURIComponent(wfBody.workflows[0].path) })
      : { status: -1 };
  record(
    '/api/workflow?path= resolves a slashed workflow path (200 with checks[])',
    wfOne.status === 200 && Array.isArray(JSON.parse(wfOne.body).checks)
  );
  const wfBad = await req(port, { reqPath: '/api/workflow?path=' + encodeURIComponent('../../etc/passwd') });
  record('workflow path traversal is rejected (400)', wfBad.status === 400);

  // Skill registry (ADR-0001): the API must report exactly what the
  // directory scan finds — verified against an independent recount of
  // .claude/skills/*/SKILL.md, never a hardcoded count or a phantom.
  const sk = await req(port, { reqPath: '/api/skills' });
  const skBody = sk.status === 200 ? JSON.parse(sk.body) : {};
  record(
    '/api/skills responds 200 with skills[]',
    sk.status === 200 && Array.isArray(skBody.skills)
  );
  const repoRoot = JSON.parse(ok.body).repoRoot;
  const recount = [];
  try {
    const dirs = await fs.readdir(path.join(repoRoot, '.claude/skills'), { withFileTypes: true });
    for (const d of dirs.filter((e) => e.isDirectory())) {
      try {
        await fs.stat(path.join(repoRoot, '.claude/skills', d.name, 'SKILL.md'));
        recount.push(d.name);
      } catch { /* no SKILL.md — not a skill */ }
    }
  } catch { /* no skills root — recount stays empty */ }
  const reported = (skBody.skills ?? []).map((s) => s.name).sort();
  record(
    'skill registry matches an independent directory recount — no phantom skill',
    sk.status === 200 &&
      JSON.stringify(reported) === JSON.stringify(recount.sort()) &&
      !reported.includes('bw2-update-memory'),
    `${reported.length} reported / ${recount.length} on disk`
  );

  const badHost = await req(port, { headers: { Host: 'evil.example' } });
  record('non-loopback Host header is rejected (403)', badHost.status === 403);

  const badOrigin = await req(port, { headers: { Origin: 'https://evil.example' } });
  record('cross-origin Origin is rejected (403)', badOrigin.status === 403);

  // Operations catalog (ADR-0001): typed guided/executable, and every
  // LLM-Skill-backed operation must be guided — never executable.
  const ops = await req(port, { reqPath: '/api/operations' });
  const opsBody = ops.status === 200 ? JSON.parse(ops.body) : {};
  record(
    '/api/operations returns a typed catalog; skill-backed operations are guided',
    ops.status === 200 &&
      Array.isArray(opsBody.operations) &&
      opsBody.operations.length > 0 &&
      opsBody.operations.every((o) => ['guided', 'executable'].includes(o.type)) &&
      opsBody.operations.filter((o) => o.skill).every((o) => o.type === 'guided')
  );

  // Skill conformance: every skill the catalog references must exist in the
  // live registry (the .claude/skills directory scan) and be previewed by
  // its real /aos-* invocation — no retired or phantom names.
  const registryNames = new Set((skBody.skills ?? []).map((s) => s.name));
  const skillBacked = (opsBody.operations ?? []).filter((o) => o.skill);
  record(
    'catalog skill references exist in the live registry and previews invoke them',
    ops.status === 200 &&
      skillBacked.length > 0 &&
      skillBacked.every(
        (o) =>
          registryNames.has(o.skill) &&
          (o.commandPreview === `/${o.skill}` || o.commandPreview.startsWith(`/${o.skill} `))
      ),
    skillBacked
      .filter((o) => !registryNames.has(o.skill))
      .map((o) => `${o.id} → /${o.skill}`)
      .join(', ') || undefined
  );

  // P2 guided flows: params are preview fill-ins only — guided-only, each
  // with a matching <name> token in the command preview it substitutes into.
  record(
    'guided-operation params are copy-only preview fill-ins (guided-only, tokens present)',
    ops.status === 200 &&
      opsBody.operations.every(
        (o) =>
          Array.isArray(o.params) &&
          (o.params.length === 0 || o.type === 'guided') &&
          o.params.every((p) => o.commandPreview.includes(`<${p.name}>`))
      )
  );

  const audit = await req(port, { reqPath: '/api/audit' });
  record(
    '/api/audit responds 200 with entries[] (one appended per P3 run)',
    audit.status === 200 && Array.isArray(JSON.parse(audit.body).entries)
  );

  // P3 controlled execution: only allowlisted ids are executable, dry-run
  // issues the confirm token, and run without dry-run + confirm never
  // executes. verify never confirms a run — that would recurse.
  const opUnknown = await req(port, { method: 'POST', reqPath: '/api/operations/x/run' });
  const opGuided = await req(port, { method: 'POST', reqPath: '/api/operations/session-start/run' });
  record(
    'non-allowlisted ids (guided/unknown) are refused (405, ADR-0001)',
    opUnknown.status === 405 && opGuided.status === 405
  );
  const opNoConfirm = await req(port, { method: 'POST', reqPath: '/api/operations/check%3Apaths/run' });
  record(
    'an allowlisted run without dry-run + explicit confirm is refused (400)',
    opNoConfirm.status === 400 && JSON.parse(opNoConfirm.body).error === 'confirm-required'
  );
  const opDry = await req(port, { method: 'POST', reqPath: '/api/operations/check%3Apaths/dry-run' });
  const opDryBody = opDry.status === 200 ? JSON.parse(opDry.body) : {};
  record(
    'dry-run describes the fixed allowlist command and issues a confirm token',
    opDry.status === 200 &&
      opDryBody.command === 'npm run check:paths' &&
      typeof opDryBody.confirmToken === 'string' &&
      opDryBody.confirmToken.length > 0
  );

  // §4.2 job routes: unknown runIds 404 on both snapshot and SSE forms.
  const runUnknown = await req(port, { reqPath: '/api/operations/runs/no-such-run' });
  const sseUnknown = await req(port, { reqPath: '/api/operations/runs/no-such-run/events' });
  record(
    'unknown run ids are 404 on the snapshot and SSE routes',
    runUnknown.status === 404 && sseUnknown.status === 404
  );
} catch (err) {
  record('server boots and reports listening', false, err.message);
} finally {
  await server.stop();
}

// --- non-loopback HOST without auth must refuse to start ---
const bad = startServer({ PORT: String(port), HOST: '0.0.0.0' });
const exitCode = await bad.waitExit();
record(
  'non-loopback HOST without auth refuses to start (non-zero exit)',
  exitCode !== 0 && exitCode !== null && bad.stderr.includes('ADR-0005'),
  `exit ${exitCode}`
);

// --- build ---
const build = await run('npm', ['run', 'build']);
record('npm run build succeeds', build.code === 0, build.code === 0 ? '' : build.out.slice(-400));

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
