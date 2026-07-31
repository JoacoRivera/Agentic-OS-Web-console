import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const platformDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const checkScript = path.join(platformDir, 'scripts', 'check-skills.mjs');

async function writeSkill(root, directoryName, declaredName) {
  const skillDir = path.join(root, '.claude', 'skills', directoryName);
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(
    path.join(skillDir, 'SKILL.md'),
    `---\nname: ${declaredName}\ndescription: Fixture.\n---\n\n# Fixture\n`
  );
}

function runCheck(repoRoot) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [checkScript], {
      cwd: platformDir,
      env: { ...process.env, REPO_ROOT: repoRoot },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += chunk;
    });
    child.stderr.on('data', (chunk) => {
      output += chunk;
    });
    child.on('close', (code) => resolve({ code, output }));
  });
}

test('check:skills fails deterministically when frontmatter.name drifts from its directory', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'check-skills-mismatch-'));
  try {
    await writeSkill(root, 'aos-z-drift', '"aos-z-drift "');
    await writeSkill(root, 'aos-a-drift', 'legacy-a');
    await writeSkill(root, 'aos-m-clean', 'aos-m-clean');

    const result = await runCheck(root);

    assert.equal(result.code, 1);
    assert.match(
      result.output,
      /✖ every SKILL\.md frontmatter\.name matches its directory — aos-a-drift: expected "aos-a-drift", found "legacy-a"/
    );
    assert.ok(
      result.output.indexOf('aos-a-drift') < result.output.indexOf('aos-z-drift')
    );
    assert.match(
      result.output,
      /aos-z-drift: expected "aos-z-drift", found "aos-z-drift "/
    );
    assert.match(result.output, /check:skills FAIL — 1 case\(s\)/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('check:skills accepts a clean fixture whose declared names match every directory', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'check-skills-clean-'));
  try {
    await writeSkill(root, 'aos-z-clean', 'aos-z-clean');
    await writeSkill(root, 'aos-a-clean', 'aos-a-clean');

    const result = await runCheck(root);

    assert.equal(result.code, 0);
    assert.match(
      result.output,
      /✔ every SKILL\.md frontmatter\.name matches its directory/
    );
    assert.match(result.output, /check:skills PASS .* 2 skills/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
