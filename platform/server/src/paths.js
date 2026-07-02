import path from 'node:path';

/**
 * Roots a client-supplied path may resolve into, relative to the repo root.
 * Path safety prevents reading *outside* these roots; it does not make the
 * roots safe to *expose* (raw-content gating is a separate concern, ADR-0005).
 */
export const ALLOWED_ROOTS = [
  'wiki',
  'raw',
  'templates',
  'dashboards',
  '.claude/skills',
  'AGENTS.md',
];

export class PathSafetyError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PathSafetyError';
    this.status = 400;
  }
}

/**
 * Resolve a client-supplied relative path against the repo root.
 * Rejects: non-strings, absolute paths (POSIX and Windows), any `..`
 * traversal, resolution outside the repo root, and paths outside the
 * allowed roots. Returns the absolute path on success.
 */
export function safeResolve(repoRoot, relPath, allowedRoots = ALLOWED_ROOTS) {
  if (typeof relPath !== 'string' || relPath.length === 0) {
    throw new PathSafetyError('path must be a non-empty string');
  }
  if (relPath.includes('\0')) {
    throw new PathSafetyError('path contains a NUL byte');
  }
  if (path.isAbsolute(relPath) || /^[a-zA-Z]:[\\/]/.test(relPath) || relPath.startsWith('\\\\')) {
    throw new PathSafetyError('absolute paths are not allowed');
  }
  // Reject `..` in the raw input, not just post-normalization — a path that
  // merely normalizes back inside the roots is still a traversal attempt.
  if (relPath.split(/[\\/]/).includes('..')) {
    throw new PathSafetyError('path traversal is not allowed');
  }
  const normalized = path.normalize(relPath).replaceAll('\\', '/');
  const abs = path.resolve(repoRoot, normalized);
  const root = path.resolve(repoRoot);
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    throw new PathSafetyError('path resolves outside the repo root');
  }
  const inAllowedRoot = allowedRoots.some(
    (allowed) => normalized === allowed || normalized.startsWith(allowed + '/')
  );
  if (!inAllowedRoot) {
    throw new PathSafetyError('path is outside the allowed roots');
  }
  return abs;
}
