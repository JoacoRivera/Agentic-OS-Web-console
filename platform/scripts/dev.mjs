// Runs the Express server (--watch) and the Vite dev server together.
// Zero-dependency alternative to `concurrently`, per the repo's minimal stance.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const platformDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const children = [
  spawn('npm', ['run', 'dev', '--workspace', 'server'], { cwd: platformDir, stdio: 'inherit' }),
  spawn('npm', ['run', 'dev', '--workspace', 'dashboard'], { cwd: platformDir, stdio: 'inherit' }),
];

function shutdown(code) {
  for (const child of children) child.kill('SIGTERM');
  process.exit(code);
}

for (const child of children) {
  child.on('exit', (code) => shutdown(code ?? 0));
}
process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
