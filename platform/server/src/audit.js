import fs from 'node:fs/promises';

/**
 * Audit log reader. Phase 3 appends one JSON line per executed operation
 * (op, ts, status, files, output) to platform/logs/operations.log; in P1
 * nothing is executable, so the tail is honestly empty. Reader only — the
 * append half lands with controlled execution (Phase 3, ADR-0001).
 */

export const AUDIT_TAIL_LIMIT = 200;

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
