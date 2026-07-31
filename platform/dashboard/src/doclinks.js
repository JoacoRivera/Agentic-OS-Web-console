/**
 * Doc link plumbing for the viewer (slice #9): a doc index built from the
 * tree, a remark step turning Obsidian wikilinks into link nodes, href
 * resolution for the custom `a` renderer, GitHub-style heading slugs, and a
 * rehype step stamping those slugs onto the rendered headings.
 */

/** Flatten the docs tree into { paths:Set, byBasename:Map<lowercase base -> path|null> }. */
export function buildDocIndex(tree) {
  const paths = new Set();
  const byBasename = new Map();
  const visit = (node) => {
    if (node.type === 'file') {
      paths.add(node.path);
      const base = node.name.replace(/\.md$/i, '').toLowerCase();
      // Wikilinks by basename are safe only when the basename is unique.
      byBasename.set(base, byBasename.has(base) ? null : node.path);
    } else {
      node.children.forEach(visit);
    }
  };
  (tree?.roots ?? []).forEach(visit);
  return { paths, byBasename };
}

const WIKILINK_RE = /\[\[([^\]]+)\]\]/g;

/**
 * Remark plugin: replace [[page]], [[page#heading]], [[page|alias]] inside
 * text nodes with link nodes (url `wikilink:page#heading`). Operating on the
 * mdast tree keeps code blocks and inline code untouched.
 */
export function remarkWikilinks() {
  const visit = (node) => {
    if (!node.children) return;
    const next = [];
    for (const child of node.children) {
      if (child.type !== 'text' || !WIKILINK_RE.test(child.value)) {
        visit(child);
        next.push(child);
        continue;
      }
      WIKILINK_RE.lastIndex = 0;
      let last = 0;
      for (const match of child.value.matchAll(WIKILINK_RE)) {
        if (match.index > last) next.push({ type: 'text', value: child.value.slice(last, match.index) });
        const inner = match[1];
        const [targetPart, alias] = inner.split('|');
        const [page, fragment] = targetPart.split('#');
        next.push({
          type: 'link',
          url: `wikilink:${page.trim()}${fragment ? `#${fragment.trim()}` : ''}`,
          children: [{ type: 'text', value: (alias ?? inner).trim() }],
        });
        last = match.index + match[0].length;
      }
      if (last < child.value.length) next.push({ type: 'text', value: child.value.slice(last) });
    }
    node.children = next;
  };
  return visit;
}

/** Minimal posix-style normalize for browser-side relative resolution. */
function normalizePath(p) {
  const stack = [];
  for (const part of p.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') stack.pop();
    else stack.push(part);
  }
  return stack.join('/');
}

/**
 * Classify an href from the rendered markdown against the doc index.
 * Returns one of:
 *   { kind:'external', href } — http(s), opens in a new tab
 *   { kind:'anchor', fragment } — bare #section on the current doc
 *   { kind:'internal', path, fragment } — resolvable in-console target
 *   { kind:'unresolved', href } — renders disabled
 */
export function resolveDocHref(href, currentPath, docIndex) {
  if (!href) return { kind: 'unresolved', href };
  if (/^https?:\/\//i.test(href)) return { kind: 'external', href };

  if (href.startsWith('wikilink:')) {
    const [page, fragment] = href.slice('wikilink:'.length).split('#');
    const base = page.replace(/\.md$/i, '').split('/').pop().toLowerCase();
    const path = docIndex.byBasename.get(base);
    return path ? { kind: 'internal', path, fragment } : { kind: 'unresolved', href };
  }

  if (href.startsWith('#')) return { kind: 'anchor', fragment: href.slice(1) };
  if (/^[a-z][a-z0-9+.-]*:/i.test(href)) return { kind: 'unresolved', href }; // mailto: etc.

  const [rawPath, fragment] = href.split('#');
  let decoded = rawPath;
  try {
    decoded = decodeURIComponent(rawPath);
  } catch {
    /* malformed escape — try the raw form */
  }
  const dir = currentPath.includes('/') ? currentPath.slice(0, currentPath.lastIndexOf('/')) : '';
  const relative = normalizePath(dir ? `${dir}/${decoded}` : decoded);
  const rootRelative = normalizePath(decoded);
  for (const candidate of [relative, rootRelative]) {
    if (docIndex.paths.has(candidate)) return { kind: 'internal', path: candidate, fragment };
  }
  return { kind: 'unresolved', href };
}

/** GitHub-style heading slug (base form, no duplicate counter). */
export function slugify(text) {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '-');
}

/**
 * GitHub-style slugger: every returned slug is unique across the document,
 * including collisions with generated -1, -2, … suffixes.
 */
export function createSlugger() {
  const used = new Set();
  return (text) => {
    const base = slugify(text);
    let slug = base;
    let suffix = 0;
    while (used.has(slug)) {
      slug = `${base}-${++suffix}`;
    }
    used.add(slug);
    return slug;
  };
}

/** Prefix for rendered heading element ids — namespaced so doc slugs can't collide with app ids. */
export const HEADING_ID_PREFIX = 'doc-h-';

/** Element id for a heading slug. The one place slug → DOM id is decided. */
export function headingId(slug) {
  return `${HEADING_ID_PREFIX}${slug}`;
}

const HEADING_TAGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6']);

/** Plain text of a hast node: concatenate descendant text values. */
function hastText(node) {
  if (node.type === 'text') return node.value;
  return (node.children ?? []).map(hastText).join('');
}

/**
 * Rehype plugin: give every heading an id during rendering. It has to be a
 * rehype step, not an effect — ids assigned imperatively after mount are lost
 * on remount and are absent for any scroll that happens in the same commit.
 * As part of the render they exist before paint and survive re-renders. One
 * fresh slugger per transform keeps duplicate headings deterministic (-1, -2)
 * in document order.
 */
export function rehypeHeadingIds() {
  return (tree) => {
    const slugFor = createSlugger();
    const visit = (node) => {
      if (node.type === 'element' && HEADING_TAGS.has(node.tagName)) {
        node.properties = node.properties ?? {};
        node.properties.id = headingId(slugFor(hastText(node)));
      }
      (node.children ?? []).forEach(visit);
    };
    visit(tree);
  };
}
