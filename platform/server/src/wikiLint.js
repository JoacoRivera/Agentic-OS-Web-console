/**
 * Parser for the memory repo's deterministic wiki lint report
 * (`scripts/wiki-lint.py` → `scripts/aos_wiki/lint.py` main()), run by the
 * `check:wiki-structure` Executable Operation (ADR-0001 amendment,
 * 2026-11-14). The lint has no JSON output; its stdout is a fixed text
 * report:
 *
 *   ## Deterministic wiki lint
 *   - errors: N
 *   - warnings: N
 *   ERROR   <message>        (one per error)
 *   WARNING <message>        (one per warning)
 *   Clean pass — …           (only when both counts are zero)
 *
 * Exit codes: 0 = no errors (warnings allowed), 1 = at least one error,
 * 2 = not a lintable repo root; the console's wrapper adds 3 = wrapper
 * failure (script missing, interpreter not spawnable).
 *
 * The header counts are authoritative. Anything that does not fit the
 * contract fails closed: `{ parsed: false, reason }` — never zeros, so a
 * failed or unreadable run can never look like a clean one.
 */

export const WIKI_LINT_HEADER = '## Deterministic wiki lint';
export const MAX_FINDINGS = 100;
export const MAX_MESSAGE_CHARS = 500;

const FINDING_PREFIXES = [
  { prefix: 'ERROR   ', level: 'error' },
  { prefix: 'WARNING ', level: 'warning' },
];

function exitReason(exitCode) {
  if (exitCode === null || exitCode === undefined) {
    return 'the lint did not exit normally (spawn failure or timeout) — see the Audit Log';
  }
  if (exitCode === 2) return 'the lint reported REPO_ROOT is not a lintable repo root (exit 2) — see stderr in the Audit Log';
  if (exitCode === 3) return 'the wrapper could not run the lint (exit 3: script missing or interpreter not spawnable) — see stderr in the Audit Log';
  return `unexpected exit code ${exitCode} — see the Audit Log`;
}

const unparsed = (reason) => ({ parsed: false, reason });

/**
 * Parse a full lint stdout (npm's own preamble may precede the header) plus
 * the run's exit code into a structured result.
 */
export function parseWikiLintReport(stdout, exitCode) {
  if (exitCode !== 0 && exitCode !== 1) return unparsed(exitReason(exitCode));

  const lines = String(stdout ?? '').split('\n').map((line) => line.replace(/\r$/, ''));
  const headerAt = lines.findIndex((line) => line.trim() === WIKI_LINT_HEADER);
  if (headerAt === -1) return unparsed(`report header "${WIKI_LINT_HEADER}" not found in the output`);

  const body = lines.slice(headerAt + 1);
  const count = (label) => {
    const re = new RegExp(`^- ${label}: (\\d+)$`);
    for (const line of body) {
      const m = re.exec(line.trim());
      if (m) return Number(m[1]);
    }
    return null;
  };
  const errors = count('errors');
  const warnings = count('warnings');
  if (errors === null) return unparsed('the "- errors: N" count is missing from the report');
  if (warnings === null) return unparsed('the "- warnings: N" count is missing from the report');
  if (exitCode === 0 && errors > 0) {
    return unparsed(`exit code 0 contradicts the report's ${errors} error(s)`);
  }
  if (exitCode === 1 && errors === 0) {
    return unparsed("exit code 1 contradicts the report's 0 errors");
  }

  const collected = [];
  for (const line of body) {
    const match = FINDING_PREFIXES.find(({ prefix }) => line.startsWith(prefix));
    if (match) collected.push({ level: match.level, message: line.slice(match.prefix.length) });
  }
  const errorLines = collected.filter((f) => f.level === 'error');
  const warningLines = collected.filter((f) => f.level === 'warning');
  const ordered = [...errorLines, ...warningLines];

  let messageCut = false;
  const findings = ordered.slice(0, MAX_FINDINGS).map(({ level, message }) => {
    if (message.length <= MAX_MESSAGE_CHARS) return { level, message };
    messageCut = true;
    return { level, message: `${message.slice(0, MAX_MESSAGE_CHARS)}…` };
  });

  return {
    parsed: true,
    errors,
    warnings,
    findings,
    findingsTotal: ordered.length,
    truncated: ordered.length > findings.length || messageCut,
    incomplete: errorLines.length !== errors || warningLines.length !== warnings,
  };
}
