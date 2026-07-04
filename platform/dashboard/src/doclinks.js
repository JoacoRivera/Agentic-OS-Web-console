/**
 * Doc link plumbing for the viewer (slice #9): a doc index built from the
 * tree, a remark step turning Obsidian wikilinks into link nodes, href
 * resolution for the custom `a` renderer, GitHub-style heading slugs, and
 * TOC extraction from raw markdown.
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

/** GitHub-style heading slug (no duplicate counter — P1 keeps it simple). */
export function slugify(text) {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '-');
}

/** Plain text of a react-markdown heading's children. */
export function headingText(children) {
  const flat = (node) => {
    if (node == null || typeof node === 'boolean') return '';
    if (typeof node === 'string' || typeof node === 'number') return String(node);
    if (Array.isArray(node)) return node.map(flat).join('');
    return flat(node.props?.children);
  };
  return flat(children);
}

/** Extract {depth, text, slug} headings from markdown, skipping code fences. */
export function extractToc(markdown) {
  const toc = [];
  let inFence = false;
  for (const line of (markdown ?? '').split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const match = line.match(/^(#{1,4})\s+(.+?)\s*#*\s*$/);
    if (!match) continue;
    const text = match[2].replace(/\[\[([^\]]+)\]\]/g, '$1').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
    toc.push({ depth: match[1].length, text, slug: slugify(text) });
  }
  return toc;
}
