import fs from 'node:fs/promises';
import path from 'node:path';
import matter from 'gray-matter';
import { recall, tokenize, fullSummary, pageTitle, pyRstrip, pyStrip } from './recall.js';

/**
 * Memory recall (ADR-0001/0005): a deterministic, read-only mirror of the
 * memory repo's recall path, in the order its `AGENTS.md` §Query uses it:
 *   1. question-first BM25F recall — `scripts/wiki_recall.py`
 *      (`scripts/aos_wiki/recall.py`, ported in `./recall.js`);
 *   2. tag recall — `scripts/wiki-tags.py`: substring search over the tag
 *      vocabulary, pages ranked by matched-tag count.
 * Both rank one page set, loaded here by `aos_wiki/recall.py`'s rules
 * (`load_pages` + `aos_wiki/frontmatter.py`). The memory repo's scripts are
 * the reference; when they change, this module, `./recall.js` and
 * `scripts/check-memory-recall.mjs` change with them.
 *
 * wiki/** only — enumerated directly (not via docs.listDocFiles) so this
 * feature never traverses raw/ metadata at all, regardless of
 * EXPOSE_RAW_CONTENT (ADR-0005: which memory tier this reads is a different
 * question from whether the read path is safe). Symlinks are not followed
 * (the reference's rglob would read a symlinked file; the console never
 * reads outside wiki/). This module never shells out and never invokes
 * Hermes/Claude/Codex/any Skill (ADR-0001); it only helps find pages —
 * synthesis stays a copy-only handoff in the UI.
 */

const SKIP_NAMES = new Set(['index.md', 'log.md', '_template.md']);
const SUMMARY_MAX_CHARS = 160;
const RESULT_LIMIT = 50;
// `aos_wiki/frontmatter.split`: a `---` first line up to the next line that
// starts with `---`, anchored at offset 0 (a bare "---" mid-body never
// counts). No block → the page is skipped, not indexed with empty tags.
const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---/;

export class BadQueryError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BadQueryError';
    this.status = 400;
  }
}

/** The display summary: the full `>` summary truncated the way the reference prints it (`[:160].rstrip() + "…"`, in code points). */
function displaySummary(summary) {
  const chars = [...summary];
  return chars.length <= SUMMARY_MAX_CHARS ? summary : pyRstrip(chars.slice(0, SUMMARY_MAX_CHARS).join('')) + '…';
}

/**
 * `aos_wiki/frontmatter.tags`: the top-level `tags:` list, items stripped,
 * empties dropped, not deduped; no list (a scalar `tags: foo`, a mapping) or
 * invalid YAML → []. A repeated key takes the last one (`json: true` reaches
 * js-yaml through gray-matter's options and stops it throwing on duplicate
 * keys, as PyYAML does not). Known inexactness: the reference reads each item
 * "as written" from PyYAML nodes, js-yaml resolves types — numbers/booleans
 * are coerced back with String() (`1.0` comes back as `1`), and null/date/
 * nested items are dropped. scripts/check-memory-recall.mjs would catch a
 * live page that hits it.
 */
function parseTags(block) {
  let data;
  try {
    data = matter(`---\n${block}\n---\n`, { json: true }).data;
  } catch {
    return [];
  }
  const raw = data?.tags;
  if (!Array.isArray(raw)) return [];
  const tags = [];
  for (const item of raw) {
    if (typeof item !== 'string' && typeof item !== 'number' && typeof item !== 'boolean') continue;
    const tag = pyStrip(String(item));
    if (tag) tags.push(tag);
  }
  return tags;
}

/**
 * Python `read_text(encoding="utf-8", errors="ignore")` with universal
 * newlines: invalid bytes are dropped (approximated: a file that is not
 * valid UTF-8 loses its U+FFFD replacements), `\r\n`/`\r` become `\n`.
 */
const strictUtf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const lenientUtf8 = new TextDecoder('utf-8', { ignoreBOM: true });
function decodeLikePython(buf) {
  let text;
  try {
    text = strictUtf8.decode(buf);
  } catch {
    text = lenientUtf8.decode(buf).replace(/\uFFFD/g, '');
  }
  return text.replace(/\r\n?/g, '\n');
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

/**
 * Load every indexable wiki page as {path, title, tags, summary, body} by
 * `aos_wiki/recall.py`'s `load_pages` rules: no frontmatter block → skipped;
 * invalid YAML → still indexed, with no tags; title = first H1, else the
 * filename stem; summary = the whole first `>` run. wiki/** is walked
 * directly (never docs.listDocFiles), so raw/ is never even traversed here.
 */
export async function loadWikiPages(config) {
  const wikiRoot = path.join(config.REPO_ROOT, 'wiki');
  const relFiles = (await walkMarkdownFiles(wikiRoot))
    .filter((rel) => !SKIP_NAMES.has(path.posix.basename(rel)))
    .sort();

  const pages = [];
  for (const rel of relFiles) {
    let text;
    try {
      text = decodeLikePython(await fs.readFile(path.join(wikiRoot, rel)));
    } catch {
      continue; // unreadable — not indexable
    }
    const m = text.match(FRONTMATTER_RE);
    if (!m) continue; // no actual YAML frontmatter block — not indexable
    const body = text.slice(m[0].length);
    pages.push({
      path: `wiki/${rel}`,
      title: pageTitle(body, rel),
      tags: parseTags(m[1]),
      summary: fullSummary(body),
      body,
    });
  }
  return pages;
}

/** Tag recall (step 2, `wiki-tags.py --search` then `--tag`) over the shared page set. */
function tagRecall(pages, tokens) {
  const tagCounts = new Map(); // lowercased tag -> { tag, count }
  const pageTags = new Map(); // path -> deduped tags
  for (const page of pages) {
    const tags = dedupeTags(page.tags);
    pageTags.set(page.path, tags);
    for (const tag of tags) {
      const key = tag.toLowerCase();
      const entry = tagCounts.get(key) ?? { tag, count: 0 };
      entry.count += 1;
      tagCounts.set(key, entry);
    }
  }

  const matchedTagKeys = new Set();
  if (tokens.length) {
    for (const key of tagCounts.keys()) {
      if (tokens.some((t) => key.includes(t))) matchedTagKeys.add(key);
    }
  }
  const matchedTags = [...matchedTagKeys]
    .map((key) => tagCounts.get(key))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));

  const ranked = [];
  for (const page of pages) {
    const matched = pageTags.get(page.path).filter((t) => matchedTagKeys.has(t.toLowerCase()));
    if (matched.length === 0) continue;
    ranked.push({
      path: page.path,
      title: page.title,
      summary: displaySummary(page.summary),
      matchedTags: matched,
      matchCount: matched.length,
    });
  }
  ranked.sort((a, b) => b.matchCount - a.matchCount || a.path.localeCompare(b.path));

  return {
    tagsInVocabulary: tagCounts.size,
    matchedTags,
    results: ranked.slice(0, RESULT_LIMIT).map(({ matchCount, ...r }) => r),
    truncated: ranked.length > RESULT_LIMIT,
  };
}

/**
 * GET /api/memory/query?topic=&includeHistory= — the recall entry point.
 * Primary `results`: BM25F question-first recall, pages with score > 0 best
 * first (`wiki_recall.py`), history pages at half weight unless
 * `includeHistory`. Second step `tagRecall`: the topic's words as substrings
 * of the tag vocabulary, pages ranked by matched-tag count (`wiki-tags.py`).
 * An empty topic, or one from which neither step gets a term, is a bad
 * request (400); a topic nothing matches is an honest empty result (200),
 * never invented.
 */
export async function queryMemory(config, topicInput, { includeHistory = false } = {}) {
  const topic = String(topicInput ?? '').trim();
  if (!topic) {
    throw new BadQueryError('topic must be a non-empty string');
  }
  const tagTokens = [...new Set(topic.toLowerCase().split(/[^a-z0-9-]+/i).filter(Boolean))];
  if (tagTokens.length === 0 && tokenize(topic).length === 0) {
    throw new BadQueryError('topic must contain at least one searchable term');
  }

  const pages = await loadWikiPages(config);
  const matched = recall(topic, pages, { includeHistory }).filter((r) => r.score > 0);

  return {
    query: topic,
    pagesIndexed: pages.length,
    includeHistory,
    pagesMatched: matched.length,
    results: matched.slice(0, RESULT_LIMIT).map(({ page, score, history }) => ({
      path: page.path,
      title: page.title,
      summary: displaySummary(page.summary),
      tags: page.tags,
      score,
      history,
    })),
    truncated: matched.length > RESULT_LIMIT,
    tagRecall: tagRecall(pages, tagTokens),
    generatedAt: new Date().toISOString(),
  };
}
