import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { safeResolve, PathSafetyError, ALLOWED_ROOTS } from '../src/paths.js';

const ROOT = '/repo';

test('resolves paths inside allowed roots', () => {
  assert.equal(safeResolve(ROOT, 'wiki/index.md'), path.join(ROOT, 'wiki/index.md'));
  assert.equal(safeResolve(ROOT, 'raw/projects/x.md'), path.join(ROOT, 'raw/projects/x.md'));
  assert.equal(safeResolve(ROOT, 'AGENTS.md'), path.join(ROOT, 'AGENTS.md'));
  assert.equal(
    safeResolve(ROOT, '.claude/skills/ingest/SKILL.md'),
    path.join(ROOT, '.claude/skills/ingest/SKILL.md')
  );
});

test('rejects .. traversal in any position', () => {
  for (const p of ['../etc/passwd', 'wiki/../../etc', 'wiki/../raw/x.md', '..', 'wiki/a/../../..']) {
    assert.throws(() => safeResolve(ROOT, p), PathSafetyError, p);
  }
});

test('rejects absolute paths (POSIX, Windows, UNC)', () => {
  for (const p of ['/etc/passwd', '/repo/wiki/index.md', 'C:\\Windows\\system32', 'C:/x', '\\\\share\\x']) {
    assert.throws(() => safeResolve(ROOT, p), PathSafetyError, p);
  }
});

test('rejects paths outside the allowed roots even when inside the repo', () => {
  for (const p of ['secrets.md', 'platform/server/src/config.js', '.claude/settings.json', 'wikis/x.md']) {
    assert.throws(() => safeResolve(ROOT, p), PathSafetyError, p);
  }
});

test('an allowed-root prefix must be a whole path segment', () => {
  // "wiki-evil" starts with "wiki" as a string but is not under the wiki root.
  assert.throws(() => safeResolve(ROOT, 'wiki-evil/x.md'), PathSafetyError);
  assert.throws(() => safeResolve(ROOT, 'AGENTS.md.bak'), PathSafetyError);
});

test('rejects non-strings, empty strings, and NUL bytes', () => {
  for (const p of ['', null, undefined, 42, 'wiki/\0.md']) {
    assert.throws(() => safeResolve(ROOT, p), PathSafetyError);
  }
});

test('allowed roots match the plan', () => {
  assert.deepEqual(ALLOWED_ROOTS, ['wiki', 'raw', 'templates', 'dashboards', '.claude/skills', 'AGENTS.md']);
});
