import fs from 'node:fs/promises';
import path from 'node:path';
import matter from 'gray-matter';

/**
 * Memory recall (ADR-0001/0005): a deterministic, read-only mirror of the
 * aos-query-memory Skill's mechanical half (scripts/wiki-tags.py) — recall by
 * frontmatter `tags` first, pages ranked by match count, each with its
 * one-line `>` summary. wiki/** only — enumerated directly (not via
 * docs.listDocFiles) so this feature never traverses raw/ metadata at all,
 * regardless of EXPOSE_RAW_CONTENT (ADR-0005: which memory tier this reads
 * is a different question from whether the read path is safe). This module
 * never shells out and never invokes Hermes/Claude/Codex/any Skill
 * (ADR-0001); it only helps find pages — synthesis stays a copy-only
 * handoff in the UI.
 */

const SKIP_NAMES = new Set(['index.md', 'log.md', '_template.md']);
const SUMMARY_MAX_CHARS = 160;
const RESULT_LIMIT = 50;
// A page is only indexable when it has an actual YAML frontmatter block —
// mirrors wiki-tags.py's `frontmatter()` regex, so a bare "---" mid-body
// doesn't count and pages with no block at all are skipped, not indexed
// with empty tags.
const FRONTMATTER_RE = /^---\r?\n[\s\S]*?\r?\n---/;

export class BadQueryError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BadQueryError';
    this.status = 400;
  }
}

/** The `> one-line summary` under the H1, per the wiki page convention. */
function parseSummary(markdown) {
  const m = markdown.match(/^>[ \t]*(.+)$/m);
  if (!m) return '';
  const line = m[1].trim().replace(/\s+/g, ' ');
  return line.length <= SUMMARY_MAX_CHARS ? line : line.slice(0, SUMMARY_MAX_CHARS).trimEnd() + '…';
}

function parseTitle(markdown) {
  return markdown.match(/^#[ \t]+(.+)$/m)?.[1]?.trim() ?? null;
}

/** Recursively collect .md file paths under `dir`, relative to `dir` (posix-joined). */
async function walkMarkdownFiles(dir, rel = '') {
  let entries;
  try {
    entries = await fs.readdir(path.join(dir, rel), { withFileTypes: true });
  } catch {
    return []; // missing dir — no files
  }
  let files = [];
  for (const entry of entries) {
    const relPath = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      files = files.concat(await walkMarkdownFiles(dir, relPath));
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      files.push(relPath);
    }
  }
  return files;
}

/** Dedupe tags case-insensitively, keeping the first-seen casing (matches the substring-search vocabulary, which is also case-insensitive). */
function dedupeTags(tags) {
  const seen = new Set();
  const deduped = [];
  for (const tag of tags) {
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(tag);
  }
  return deduped;
}

/** Load every wiki page's {path, tags, title, summary} — the tag index. wiki/** is walked directly (never docs.listDocFiles), so raw/ is never even traversed here. */
async function loadWikiPages(config) {
  const wikiRoot = path.join(config.REPO_ROOT, 'wiki');
  const relFiles = (await walkMarkdownFiles(wikiRoot))
    .filter((rel) => !SKIP_NAMES.has(path.posix.basename(rel)))
    .sort();

  const pages = [];
  for (const rel of relFiles) {
    let text;
    try {
      text = await fs.readFile(path.join(wikiRoot, rel), 'utf8');
    } catch {
      continue; // unreadable — not indexable
    }
    if (!FRONTMATTER_RE.test(text)) continue; // no actual YAML frontmatter block — not indexable
    let fm = {};
    let markdown = text;
    try {
      const parsed = matter(text);
      fm = parsed.data ?? {};
      markdown = parsed.content;
    } catch {
      continue; // malformed frontmatter — not indexable
    }
    const tagsRaw = fm.tags;
    const tags = dedupeTags(
      Array.isArray(tagsRaw)
        ? tagsRaw.filter((t) => typeof t === 'string')
        : typeof tagsRaw === 'string'
          ? [tagsRaw]
          : []
    );
    pages.push({ path: `wiki/${rel}`, tags, title: parseTitle(markdown), summary: parseSummary(markdown) });
  }
  return pages;
}

/**
 * GET /api/memory/query?topic= — the recall entry point. Step 1: turn the
 * free-text topic into candidate tags by substring search over the tag
 * vocabulary (mirrors `wiki-tags.py --search`). Step 2: rank pages by how
 * many of those tags they carry (mirrors `wiki-tags.py --tag`). An empty/
 * unsearchable topic is a bad request (400); a topic with no matching tags
 * is an honest empty result (200), never invented.
 */
export async function queryMemory(config, topicInput) {
  const topic = String(topicInput ?? '').trim();
  if (!topic) {
    throw new BadQueryError('topic must be a non-empty string');
  }
  const tokens = [...new Set(topic.toLowerCase().split(/[^a-z0-9-]+/i).filter(Boolean))];
  if (tokens.length === 0) {
    throw new BadQueryError('topic must contain at least one searchable term');
  }

  const pages = await loadWikiPages(config);

  const tagCounts = new Map(); // lowercased tag -> { tag, count }
  for (const page of pages) {
    for (const tag of page.tags) {
      const key = tag.toLowerCase();
      const entry = tagCounts.get(key) ?? { tag, count: 0 };
      entry.count += 1;
      tagCounts.set(key, entry);
    }
  }

  const matchedTagKeys = new Set();
  for (const key of tagCounts.keys()) {
    if (tokens.some((t) => key.includes(t))) matchedTagKeys.add(key);
  }
  const matchedTags = [...matchedTagKeys]
    .map((key) => tagCounts.get(key))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));

  const ranked = [];
  for (const page of pages) {
    const matched = page.tags.filter((t) => matchedTagKeys.has(t.toLowerCase()));
    if (matched.length === 0) continue;
    ranked.push({
      path: page.path,
      title: page.title,
      summary: page.summary,
      matchedTags: matched,
      matchCount: matched.length,
    });
  }
  ranked.sort((a, b) => b.matchCount - a.matchCount || a.path.localeCompare(b.path));

  let truncated = false;
  const results = [];
  for (const r of ranked) {
    if (results.length >= RESULT_LIMIT) {
      truncated = true;
      break;
    }
    results.push({ path: r.path, title: r.title, summary: r.summary, matchedTags: r.matchedTags });
  }

  return {
    query: topic,
    pagesIndexed: pages.length,
    tagsInVocabulary: tagCounts.size,
    matchedTags,
    results,
    truncated,
    generatedAt: new Date().toISOString(),
  };
}
