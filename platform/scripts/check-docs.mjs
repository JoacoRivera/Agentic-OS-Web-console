// check:docs — deterministic docs-API check against the live repo (permanent
// allowlist). Drives the docs module in-process (tree/read/search/backlinks)
// and asserts the safety behaviors: traversal rejected, raw content gated by
// EXPOSE_RAW_CONTENT (ADR-0005) while raw file *names* still appear.
//
// Usage: REPO_ROOT=<memory repo> node scripts/check-docs.mjs
import { createConfig } from '../server/src/config.js';
import {
  DOC_ROOTS,
  buildDocsTree,
  readDocFile,
  searchDocs,
  findBacklinks,
  listDocFiles,
} from '../server/src/docs.js';

const config = createConfig({ ...process.env, EXPOSE_RAW_CONTENT: 'false' });

let failed = 0;
const record = (name, ok, detail = '') => {
  if (!ok) failed++;
  console.log(`${ok ? '✔' : '✖'} ${name}${detail ? ` — ${detail}` : ''}`);
};

const tree = await buildDocsTree(config);
record('tree returns roots[]', Array.isArray(tree.roots) && tree.roots.length > 0);
record(
  'docs roots match the active memory-repo surface',
  DOC_ROOTS.map(({ root }) => root).join('|') ===
    'AGENTS.md|wiki|raw|templates|.claude/skills'
);

const files = await listDocFiles(config);
const wikiFile = files.find((f) => f.path.startsWith('wiki/') && f.path.endsWith('.md'))?.path;
const rawFile = files.find((f) => f.source === 'raw' && f.path.endsWith('.md'))?.path;
record('doc listing finds wiki files', Boolean(wikiFile), wikiFile ?? 'none');

if (wikiFile) {
  const doc = await readDocFile(config, wikiFile);
  record('a wiki doc reads with markdown body', typeof doc.markdown === 'string' && doc.markdown.length > 0, wikiFile);
} else {
  record('a wiki doc reads with markdown body', false, 'no wiki file to read');
}

try {
  await readDocFile(config, '../../etc/passwd');
  record('traversal read is rejected', false, 'no error thrown');
} catch (err) {
  record('traversal read is rejected', err.name === 'PathSafetyError', err.message);
}

if (rawFile) {
  try {
    await readDocFile(config, rawFile);
    record('raw content is hidden by default (ADR-0005)', false, `${rawFile} was served`);
  } catch (err) {
    record('raw content is hidden by default (ADR-0005)', err.name === 'RawContentHiddenError', err.message);
  }
} else {
  record('raw content is hidden by default (ADR-0005)', true, 'no raw file in this repo — vacuous');
}

const search = await searchDocs(config, 'memory');
record('search returns results[]', Array.isArray(search.results));
record(
  'search snippets never leak raw content while gated',
  search.results
    .filter((r) => r.source === 'raw')
    .every((r) => r.snippets.length === 0 && r.contentMatches === 0),
);

try {
  await searchDocs(config, '');
  record('empty search query is rejected', false, 'no error thrown');
} catch (err) {
  record('empty search query is rejected', err.name === 'BadQueryError', err.message);
}

const backlinks = await findBacklinks(config, 'wiki/index.md');
record('backlinks returns backlinks[]', Array.isArray(backlinks.backlinks));

try {
  await findBacklinks(config, '../../etc/passwd');
  record('backlinks traversal is rejected', false, 'no error thrown');
} catch (err) {
  record('backlinks traversal is rejected', err.name === 'PathSafetyError', err.message);
}

console.log(
  failed === 0
    ? `\ncheck:docs PASS (repo: ${config.REPO_ROOT})`
    : `\ncheck:docs FAIL — ${failed} case(s) (repo: ${config.REPO_ROOT})`
);
process.exit(failed === 0 ? 0 : 1);
