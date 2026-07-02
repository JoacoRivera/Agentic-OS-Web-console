// Boot smoke (Seam 2): asserts the process-lifecycle invariants an in-process
// app cannot exhibit (ADR-0005 bind + startup guard), plus a build check.
// Prints pass/fail per check and exits non-zero on any failure.
import { spawn } from 'node:child_process';
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

  const badHost = await req(port, { headers: { Host: 'evil.example' } });
  record('non-loopback Host header is rejected (403)', badHost.status === 403);

  const badOrigin = await req(port, { headers: { Origin: 'https://evil.example' } });
  record('cross-origin Origin is rejected (403)', badOrigin.status === 403);

  const opRun = await req(port, { method: 'POST', reqPath: '/api/operations/x/run' });
  const opDry = await req(port, { method: 'POST', reqPath: '/api/operations/x/dry-run' });
  record('POST /api/operations/:id/{run,dry-run} return 501 before P3', opRun.status === 501 && opDry.status === 501);
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
