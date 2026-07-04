import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * Audit log: one JSON line per executed operation (op, ts, status, files,
 * output) in platform/logs/operations.log. The reader tails it; the append
 * half is called by the Phase 3 executor on every run, success or failure
 * (ADR-0001 — every write/exec leaves an audit entry).
 */

export const AUDIT_TAIL_LIMIT = 200;

/** Append one entry as a JSON line, creating the logs dir on first write. */
export async function appendAuditEntry(config, entry) {
  await fs.mkdir(path.dirname(config.AUDIT_LOG_PATH), { recursive: true });
  await fs.appendFile(config.AUDIT_LOG_PATH, JSON.stringify(entry) + '\n', 'utf8');
}

/** GET /api/audit — tail of the operations log; missing file = empty log. */
export async function readAuditTail(config, limit = AUDIT_TAIL_LIMIT) {
  let text = '';
  try {
    text = await fs.readFile(config.AUDIT_LOG_PATH, 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }

  const lines = text.split('\n').filter((line) => line.trim() !== '');
  const entries = lines.slice(-limit).map((line) => {
    // JSON lines are the P3 format; anything else is surfaced verbatim
    // rather than dropped — the audit trail must not silently lose lines.
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
