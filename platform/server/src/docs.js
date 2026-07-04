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

/** Flatten every .md file across the doc roots as {path, name, source}. */
export async function listDocFiles(config) {
  const { roots } = await buildDocsTree(config);
  const files = [];
  const visit = (node) => {
    if (node.type === 'file') files.push({ path: node.path, name: node.name, source: node.source });
    else for (const child of node.children) visit(child);
  };
  for (const root of roots) visit(root);
  return files;
}

const SEARCH_RESULT_LIMIT = 50;
const SNIPPETS_PER_FILE = 3;
const SNIPPET_MAX_CHARS = 200;

/**
 * Search the doc roots: filename (path substring) + content (line) matches,
 * case-insensitive. Raw *names* are metrics-grade metadata and always
 * searchable; raw *bodies/snippets* are gated by EXPOSE_RAW_CONTENT
 * (ADR-0005) — while the flag is off, raw files are never content-searched
 * and never contribute snippets.
 */
export async function searchDocs(config, query) {
  const q = String(query ?? '').trim().toLowerCase();
  if (!q) {
    const err = new Error('query must be a non-empty string');
    err.name = 'BadQueryError';
    err.status = 400;
    throw err;
  }

  const results = [];
  let truncated = false;
  for (const file of await listDocFiles(config)) {
    const nameMatch = file.path.toLowerCase().includes(q);

    let snippets = [];
    let contentMatches = 0;
    const contentSearchable = file.source !== 'raw' || config.EXPOSE_RAW_CONTENT;
    if (contentSearchable) {
      let text;
      try {
        text = await fs.readFile(path.join(config.REPO_ROOT, file.path), 'utf8');
      } catch {
        text = ''; // unreadable — filename match may still count
      }
      const lines = text.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (!lines[i].toLowerCase().includes(q)) continue;
        contentMatches++;
        if (snippets.length < SNIPPETS_PER_FILE) {
          snippets.push({ line: i + 1, text: lines[i].trim().slice(0, SNIPPET_MAX_CHARS) });
        }
      }
    }

    if (!nameMatch && contentMatches === 0) continue;
    if (results.length >= SEARCH_RESULT_LIMIT) {
      truncated = true;
      break;
    }
    results.push({ ...file, nameMatch, contentMatches, snippets });
  }

  results.sort((a, b) => Number(b.nameMatch) - Number(a.nameMatch) || a.path.localeCompare(b.path));
  return { query: q, results, truncated, generatedAt: new Date().toISOString() };
}

// Markdown inline links: capture the href up to the first whitespace or
// closing paren (an optional "title" may follow the href).
const MD_LINK_RE = /\[[^\]]*\]\(<?([^)\s>]+)>?(?:\s[^)]*)?\)/g;
// Obsidian wikilinks: [[page]], [[page#heading]], [[page|alias]].
const WIKILINK_RE = /\[\[([^\]]+)\]\]/g;

/** True when an href points outside the repo (scheme'd URL, mailto, etc.). */
const isExternalHref = (href) => /^[a-z][a-z0-9+.-]*:/i.test(href);

/**
 * Docs that link to `relPath`, resolving the P1 link forms: relative links
 * (against the linking file's dir), root-relative repo links, Obsidian
 * wikilinks matched by basename (incl. [[page#heading]]), and heading
 * anchors (file.md#section — the fragment is ignored for matching; a bare
 * #section is a self-link, never a backlink). Raw files as backlink
 * *sources* are gated by EXPOSE_RAW_CONTENT — which raw capture cites a doc
 * is content-derived, not name metadata (ADR-0005).
 */
export async function findBacklinks(config, relPath) {
  const abs = safeResolve(config.REPO_ROOT, relPath);
  const target = path.relative(config.REPO_ROOT, abs).replaceAll('\\', '/');
  const targetBase = path.posix.basename(target).replace(/\.md$/i, '').toLowerCase();
  const files = await listDocFiles(config);
  const basenameCounts = new Map();
  for (const file of files) {
    const base = path.posix.basename(file.path).replace(/\.md$/i, '').toLowerCase();
    basenameCounts.set(base, (basenameCounts.get(base) ?? 0) + 1);
  }
  const targetBaseIsUnique = basenameCounts.get(targetBase) === 1;

  const backlinks = [];
  for (const file of files) {
    if (file.path === target) continue;
    if (file.source === 'raw' && !config.EXPOSE_RAW_CONTENT) continue;

    let text;
    try {
      text = await fs.readFile(path.join(config.REPO_ROOT, file.path), 'utf8');
    } catch {
      continue;
    }

    const dir = path.posix.dirname(file.path);
    let count = 0;

    for (const [, rawHref] of text.matchAll(MD_LINK_RE)) {
      if (isExternalHref(rawHref)) continue;
      const href = rawHref.split('#')[0];
      if (!href) continue; // bare #anchor — self-link
      let decoded = href;
      try {
        decoded = decodeURIComponent(href);
      } catch {
        /* malformed escape — match on the raw form */
      }
      const relative = path.posix.normalize(path.posix.join(dir, decoded));
      const rootRelative = path.posix.normalize(decoded);
      if (relative === target || rootRelative === target) count++;
    }

    for (const [, inner] of text.matchAll(WIKILINK_RE)) {
      const page = inner.split('|')[0].split('#')[0].trim();
      const base = path.posix.basename(page).replace(/\.md$/i, '').toLowerCase();
      if (targetBaseIsUnique && base && base === targetBase) count++;
    }

    if (count > 0) backlinks.push({ ...file, count });
  }

  backlinks.sort((a, b) => a.path.localeCompare(b.path));
  return { path: target, backlinks, generatedAt: new Date().toISOString() };
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
