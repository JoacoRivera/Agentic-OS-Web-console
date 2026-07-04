import fs from 'node:fs/promises';
import path from 'node:path';
import matter from 'gray-matter';
import { scanWorkflowsRoot } from './workflows.js';

/**
 * Skill registry (ADR-0001): Skills are LLM-facing capability packs the
 * console can only *describe*, never execute. The registry is a pure
 * directory scan of `.claude/skills/<name>/SKILL.md` — it reports exactly what
 * exists and never hardcodes a phantom skill (e.g. /bw2-update-memory).
 */

export const SKILLS_ROOT = '.claude/skills';

/** First non-empty, non-heading body line — the description fallback. */
function firstBodyLine(body) {
  for (const line of body.split('\n')) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('#')) return trimmed;
  }
  return null;
}

/**
 * Guess the related workflow: the registry-eligible workflow whose basename
 * is mentioned earliest in the skill text. A guess, not frontmatter truth —
 * null when nothing matches.
 */
function guessRelatedWorkflow(text, workflowPaths) {
  let best = null;
  let bestIndex = Infinity;
  for (const wfPath of workflowPaths) {
    const base = path.posix.basename(wfPath).replace(/\.md$/i, '');
    const index = text.indexOf(base);
    if (index !== -1 && index < bestIndex) {
      best = wfPath;
      bestIndex = index;
    }
  }
  return best;
}

/**
 * GET /api/skills — scan the skills root. A skill is a directory containing
 * SKILL.md; anything else (stray files, empty dirs) is not a skill and is
 * simply omitted. Name and invocation come from the directory name — that is
 * what Claude dispatches on.
 */
export async function listSkills(config) {
  let entries = [];
  try {
    entries = await fs.readdir(path.join(config.REPO_ROOT, SKILLS_ROOT), {
      withFileTypes: true,
    });
  } catch {
    /* no skills root — an empty registry, honestly reported */
  }

  const { workflowPaths } = await scanWorkflowsRoot(config);

  const skills = (
    await Promise.all(
      entries
        .filter((e) => e.isDirectory())
        .map(async (dir) => {
          const relPath = `${SKILLS_ROOT}/${dir.name}/SKILL.md`;
          const abs = path.join(config.REPO_ROOT, relPath);
          let text;
          let stat;
          try {
            [text, stat] = await Promise.all([fs.readFile(abs, 'utf8'), fs.stat(abs)]);
          } catch {
            return null; // directory without SKILL.md — not a skill
          }
          // Tolerant parse: a broken frontmatter block still yields a skill
          // row (the file exists); description just falls back to the body.
          let fm = {};
          let body = text;
          try {
            const parsed = matter(text);
            fm = parsed.data ?? {};
            body = parsed.content;
          } catch {
            /* fall through to body fallback */
          }
          return {
            name: dir.name,
            invocation: `/${dir.name}`,
            description:
              (typeof fm.description === 'string' && fm.description.trim()) ||
              firstBodyLine(body),
            path: relPath,
            absolutePath: abs,
            mtime: new Date(stat.mtimeMs).toISOString(),
            relatedWorkflow: guessRelatedWorkflow(text, workflowPaths),
          };
        })
    )
  )
    .filter(Boolean)
    .sort((a, b) => a.name.localeCompare(b.name));

  return { skills, total: skills.length, root: SKILLS_ROOT, generatedAt: new Date().toISOString() };
}
