import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * Audit log: one JSON line per executed operation (op, ts, status, files,
 * output) in platform/logs/operations.log. The reader tails it; the append
 * half is called by the Phase 3 executor on every run, success or failure
 * (ADR-0001 — every write/exec leaves an audit entry).
 *
 * Retention (roadmap §4.3): size-based rollover. When the live file reaches
 * AUDIT_ROTATE_BYTES it is renamed to `.1` (older rotations shift up; the
 * oldest beyond AUDIT_ROTATE_KEEP is dropped) and a fresh live file starts.
 * Rotation only ever renames whole files — the append-only property holds:
 * no line is rewritten, and the reader spans the rotation boundary.
 */

export const AUDIT_TAIL_LIMIT = 200;

const rotatedPath = (base, i) => `${base}.${i}`;

async function rotateIfNeeded(config) {
  let size;
  try {
    size = (await fs.stat(config.AUDIT_LOG_PATH)).size;
  } catch {
    return; // no live file yet — nothing to rotate
  }
  if (size < config.AUDIT_ROTATE_BYTES) return;

  const keep = Math.max(1, config.AUDIT_ROTATE_KEEP);
  await fs.rm(rotatedPath(config.AUDIT_LOG_PATH, keep), { force: true });
  for (let i = keep - 1; i >= 1; i--) {
    try {
      await fs.rename(rotatedPath(config.AUDIT_LOG_PATH, i), rotatedPath(config.AUDIT_LOG_PATH, i + 1));
    } catch {
      /* gap in the rotation chain — fine */
    }
  }
  await fs.rename(config.AUDIT_LOG_PATH, rotatedPath(config.AUDIT_LOG_PATH, 1));
}

/** Append one entry as a JSON line, creating the logs dir on first write. */
export async function appendAuditEntry(config, entry) {
  await fs.mkdir(path.dirname(config.AUDIT_LOG_PATH), { recursive: true });
  await rotateIfNeeded(config);
  await fs.appendFile(config.AUDIT_LOG_PATH, JSON.stringify(entry) + '\n', 'utf8');
}

async function readLines(filePath) {
  try {
    return (await fs.readFile(filePath, 'utf8')).split('\n').filter((line) => line.trim() !== '');
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    return [];
  }
}

/**
 * GET /api/audit — tail of the operations log, spanning rotated files
 * (oldest → newest) so a fresh post-rotation live file still shows history.
 * Missing files = empty log.
 */
export async function readAuditTail(config, limit = AUDIT_TAIL_LIMIT) {
  const lines = [];
  for (let i = Math.max(1, config.AUDIT_ROTATE_KEEP); i >= 1; i--) {
    lines.push(...(await readLines(rotatedPath(config.AUDIT_LOG_PATH, i))));
  }
  lines.push(...(await readLines(config.AUDIT_LOG_PATH)));

  const entries = lines.slice(-limit).map((line) => {
    // JSON lines are the canonical format; anything else is surfaced
    // verbatim rather than dropped — the audit trail must not silently
    // lose lines.
    try {
      return JSON.parse(line);
    } catch {
      return { raw: line };
    }
  });

  return {
    entries,
    shown: entries.length,
    total: lines.length,
    path: config.AUDIT_LOG_PATH,
    generatedAt: new Date().toISOString(),
  };
}
