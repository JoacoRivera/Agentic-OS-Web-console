import fs from 'node:fs/promises';
import path from 'node:path';
import matter from 'gray-matter';
import { safeResolve } from './paths.js';

/**
 * Docs explorer backend: directory tree + single-file read across the doc
 * roots. Every node is tagged with a `source` kind so the UI can visually
 * distinguish candid raw captures from polished wiki docs.
 *
 * Raw *content* is gated by EXPOSE_RAW_CONTENT (default false, ADR-0005);
 * the tree still lists raw/ paths (names are metrics-grade metadata — the
 * review queue already surfaces them), but /api/docs/file withholds raw
 * bodies unless the flag is on. Path safety (safeResolve) is a separate
 * concern and does not make a root safe to expose.
 */

export const DOC_ROOTS = [
  { root: 'AGENTS.md', source: 'root' },
  { root: 'wiki', source: 'wiki' },
  { root: 'raw', source: 'raw' },
  { root: 'templates', source: 'template' },
  { root: 'dashboards', source: 'dashboard' },
  { root: '.claude/skills', source: 'skill' },
];

export class RawContentHiddenError extends Error {
  constructor() {
    super(
      'raw content is hidden by default (EXPOSE_RAW_CONTENT=false); raw metrics are unaffected (ADR-0005)'
    );
    this.name = 'RawContentHiddenError';
    this.status = 403;
  }
}

/** Source kind for a repo-relative path (normalized, forward slashes). */
export function sourceKind(relPath) {
  const match = DOC_ROOTS.find(
    ({ root }) => relPath === root || relPath.startsWith(root + '/')
  );
  return match ? match.source : null;
}

const byTreeOrder = (a, b) => {
  if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
  return a.name.localeCompare(b.name);
};

/** Recursively list folders + .md files under `rel`, tagged with `source`. */
async function walkTree(repoRoot, rel, source) {
  let entries;
  try {
    entries = await fs.readdir(path.join(repoRoot, rel), { withFileTypes: true });
  } catch {
    return []; // missing root — no nodes
  }
  const nodes = [];
  for (const entry of entries) {
    if (entry.name === '.git') continue;
    const relPath = `${rel}/${entry.name}`;
    if (entry.isDirectory()) {
      nodes.push({
        name: entry.name,
        path: relPath,
        type: 'dir',
        source,
        children: await walkTree(repoRoot, relPath, source),
      });
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      nodes.push({ name: entry.name, path: relPath, type: 'file', source });
    }
  }
  return nodes.sort(byTreeOrder);
}

/** Build the docs tree: one top-level node per doc root that exists. */
export async function buildDocsTree(config) {
  const roots = [];
  for (const { root, source } of DOC_ROOTS) {
    const abs = path.join(config.REPO_ROOT, root);
    let stat;
    try {
      stat = await fs.stat(abs);
    } catch {
      continue; // missing root — omitted, not an error
    }
    if (stat.isFile()) {
      roots.push({ name: path.basename(root), path: root, type: 'file', source });
    } else {
      roots.push({
        name: root,
        path: root,
        type: 'dir',
        source,
        children: await walkTree(config.REPO_ROOT, root, source),
      });
    }
  }
  return { roots, generatedAt: new Date().toISOString() };
}

/**
 * Read one doc: markdown + parsed frontmatter + resolved relative & absolute
 * paths (for copy actions). Throws PathSafetyError (400) on unsafe paths and
 * RawContentHiddenError (403) for raw/** content while the flag is off —
 * gating is checked before the fs read so raw/ never leaks an existence
 * oracle either.
 */
export async function readDocFile(config, relPath) {
  const abs = safeResolve(config.REPO_ROOT, relPath);
  const normalized = path.relative(config.REPO_ROOT, abs).replaceAll('\\', '/');
  const source = sourceKind(normalized);
  if (source === 'raw' && !config.EXPOSE_RAW_CONTENT) {
    throw new RawContentHiddenError();
  }

  const [text, stat] = await Promise.all([fs.readFile(abs, 'utf8'), fs.stat(abs)]);

  // Invalid YAML frontmatter must not make a doc unreadable — fall back to
  // treating the whole file as body.
  let frontmatter = {};
  let markdown = text;
  try {
    const parsed = matter(text);
    frontmatter = parsed.data ?? {};
    markdown = parsed.content;
  } catch {
    /* malformed frontmatter — serve the raw text */
  }

  return {
    name: path.basename(normalized),
    path: normalized,
    absolutePath: abs,
    source,
    frontmatter,
    markdown,
    mtime: new Date(stat.mtimeMs).toISOString(),
  };
}
