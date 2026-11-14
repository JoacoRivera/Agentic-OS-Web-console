import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_FINDINGS, MAX_MESSAGE_CHARS, parseWikiLintReport } from '../src/wikiLint.js';

/** Build a report in the lint's exact text shape (synthetic messages only). */
function report(errors, warnings, { extraErrorsInHeader = 0 } = {}) {
  const lines = [
    '## Deterministic wiki lint',
    `- errors: ${errors.length + extraErrorsInHeader}`,
    `- warnings: ${warnings.length}`,
    ...errors.map((m) => `ERROR   ${m}`),
    ...warnings.map((m) => `WARNING ${m}`),
  ];
  if (!errors.length && !warnings.length) lines.push('Clean pass — no mechanical issues found.');
  return lines.join('\n') + '\n';
}

test('a clean pass parses to zero counts and no findings', () => {
  const result = parseWikiLintReport(report([], []), 0);
  assert.deepEqual(result, {
    parsed: true,
    errors: 0,
    warnings: 0,
    findings: [],
    findingsTotal: 0,
    truncated: false,
    incomplete: false,
  });
});

test('errors and warnings are collected with their counts, errors first', () => {
  const stdout = report(
    ['wiki/example/page.md: broken link to missing.md', 'wiki/index.md: example/page.md not indexed'],
    ['wiki/example/other.md: orphan page']
  );
  const result = parseWikiLintReport(stdout, 1);
  assert.equal(result.parsed, true);
  assert.equal(result.errors, 2);
  assert.equal(result.warnings, 1);
  assert.deepEqual(
    result.findings.map((f) => f.level),
    ['error', 'error', 'warning']
  );
  assert.equal(result.findings[0].message, 'wiki/example/page.md: broken link to missing.md');
  assert.equal(result.incomplete, false);
  assert.equal(result.truncated, false);
});

test('warnings only is a successful exit (0) and still parses', () => {
  const result = parseWikiLintReport(report([], ['wiki/example/page.md: missing review_by']), 0);
  assert.equal(result.parsed, true);
  assert.equal(result.errors, 0);
  assert.equal(result.warnings, 1);
});

test("npm's preamble before the header is ignored", () => {
  const stdout =
    '\n> agentic-os-platform@0.1.0 check:wiki-structure\n> node scripts/check-wiki-structure.mjs\n\n' +
    report(['wiki/example/page.md: bad frontmatter'], []);
  const result = parseWikiLintReport(stdout, 1);
  assert.equal(result.parsed, true);
  assert.equal(result.errors, 1);
  assert.equal(result.findings.length, 1);
});

test('ERROR-looking lines before the header are not findings', () => {
  const stdout = 'ERROR   from npm, not the lint\n' + report([], []);
  const result = parseWikiLintReport(stdout, 0);
  assert.equal(result.parsed, true);
  assert.equal(result.findings.length, 0);
});

test('a missing header fails closed', () => {
  const result = parseWikiLintReport('something else entirely\n', 0);
  assert.equal(result.parsed, false);
  assert.match(result.reason, /header/);
  assert.equal('errors' in result, false);
});

test('a missing count fails closed', () => {
  const result = parseWikiLintReport('## Deterministic wiki lint\n- errors: 0\n', 0);
  assert.equal(result.parsed, false);
  assert.match(result.reason, /warnings/);
});

test('exit 2 with empty stdout fails closed with a reason', () => {
  const result = parseWikiLintReport('', 2);
  assert.equal(result.parsed, false);
  assert.match(result.reason, /not a lintable repo root/);
});

test('wrapper exit 3 and a null exit code fail closed', () => {
  assert.match(parseWikiLintReport('', 3).reason, /wrapper/);
  assert.match(parseWikiLintReport(report([], []), null).reason, /did not exit normally/);
});

test('exit 0 with errors in the report fails closed (never trust a contradiction)', () => {
  const result = parseWikiLintReport(report(['a', 'b', 'c'], []), 0);
  assert.equal(result.parsed, false);
  assert.match(result.reason, /contradicts/);
});

test('exit 1 with zero errors fails closed', () => {
  const result = parseWikiLintReport(report([], []), 1);
  assert.equal(result.parsed, false);
});

test('a header count that disagrees with the ERROR lines marks the result incomplete', () => {
  const result = parseWikiLintReport(report(['only one line'], [], { extraErrorsInHeader: 1 }), 1);
  assert.equal(result.parsed, true);
  assert.equal(result.errors, 2);
  assert.equal(result.findings.length, 1);
  assert.equal(result.incomplete, true);
});

test('findings are capped, with the total and a truncation flag', () => {
  const errors = Array.from({ length: 150 }, (_, i) => `wiki/example/page-${i}.md: broken link`);
  const result = parseWikiLintReport(report(errors, []), 1);
  assert.equal(result.errors, 150);
  assert.equal(result.findings.length, MAX_FINDINGS);
  assert.equal(result.findingsTotal, 150);
  assert.equal(result.truncated, true);
  assert.equal(result.incomplete, false);
});

test('a long message is cut to the per-message cap', () => {
  const result = parseWikiLintReport(report(['x'.repeat(2000)], []), 1);
  assert.equal(result.findings[0].message.length, MAX_MESSAGE_CHARS + 1); // + the ellipsis
  assert.ok(result.findings[0].message.endsWith('…'));
  assert.equal(result.truncated, true);
});

test('CRLF line endings parse the same', () => {
  const result = parseWikiLintReport(report(['wiki/example/page.md: x'], []).replace(/\n/g, '\r\n'), 1);
  assert.equal(result.parsed, true);
  assert.equal(result.errors, 1);
  assert.equal(result.findings[0].message, 'wiki/example/page.md: x');
});
