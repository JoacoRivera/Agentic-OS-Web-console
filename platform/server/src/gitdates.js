import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * When Git first saw each current path, via one
 * `git log --diff-filter=A` pass over the whole repo (ADR-0003:
 * `pathAddedDate` — file growth, NOT knowledge intake; promotion raw→wiki
 * adds a new path on the promotion date, and rename detection is
 * unreliable, so this is deliberately not a "creation date").
 *
 * Returns Map<repo-relative path, epoch ms of the earliest add>. Empty map
 * when the root is not a git repo (callers fall back to fs timestamps).
 */
export async function getPathAddedDates(repoRoot) {
  const map = new Map();
  let stdout;
  try {
    ({ stdout } = await execFileAsync(
      'git',
      [
        '-c', 'core.quotePath=false',
        'log',
        '--diff-filter=A',
        '--name-only',
        '--format=%x01%aI',
      ],
      { cwd: repoRoot, maxBuffer: 64 * 1024 * 1024 }
    ));
  } catch {
    return map;
  }
  let current = null;
  for (const line of stdout.split('\n')) {
    if (line.startsWith('\x01')) {
      const ms = Date.parse(line.slice(1).trim());
      current = Number.isNaN(ms) ? null : ms;
    } else if (line.trim() !== '' && current !== null) {
      const existing = map.get(line);
      // git log is newest-first; keep the earliest add for re-added paths.
      if (existing === undefined || current < existing) map.set(line, current);
    }
  }
  return map;
}

/**
 * Creation-date fallback for paths Git has not seen (untracked files or a
 * non-git root): `birthtime`, falling back to `mtime` where birthtime is
 * unreliable (WSL).
 */
export function creationFallbackMs(stat) {
  const birth = stat.birthtimeMs;
  return birth && birth > 0 ? birth : stat.mtimeMs;
}
