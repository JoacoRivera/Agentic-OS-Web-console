import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { createConfig } from '../src/config.js';
import { numericValue, parseExamNote, collectPendingFromText } from '../src/familyHealth.js';

// ADR-0010: the fixture is synthetic (invented members and values). The
// memory repo is a temp dir holding one matching wiki member page so the
// cross-link is exercised without touching the live repo.
const FIXTURE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/family-health');
const PROXY_SECRET = 'test-proxy-secret-'.padEnd(40, 'x');

let repoRoot;
before(async () => {
  repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'fh-repo-'));
  const page = path.join(repoRoot, 'wiki/projects/family-health-tracker/ada-example.md');
  await fs.mkdir(path.dirname(page), { recursive: true });
  await fs.writeFile(page, '---\ntags: [family-health-tracker]\n---\n\n# Ada Example\n');
  await fs.writeFile(path.join(repoRoot, 'AGENTS.md'), '# Schema\n');
});
after(async () => {
  await fs.rm(repoRoot, { recursive: true, force: true });
});

const app = (extra = {}) =>
  createApp(createConfig({ REPO_ROOT: repoRoot, HEALTH_REPO_ROOT: FIXTURE, ...extra }));
const get = (a, url) => request(a).get(url).set('Host', '127.0.0.1:3001');

test('unset HEALTH_REPO_ROOT: every family-health route is 404 not-configured and status says so', async () => {
  const a = createApp(createConfig({ REPO_ROOT: repoRoot }));
  for (const url of ['/api/family-health/summary', '/api/family-health/members', '/api/family-health/file?path=family-overview.md']) {
    const res = await get(a, url);
    assert.equal(res.status, 404, url);
    assert.equal(res.body.error, 'family-health-not-configured');
  }
  const status = await get(a, '/api/status');
  assert.equal(status.body.familyHealthConfigured, false);
  assert.equal(status.body.familyHealthAllowProxy, false);
});

test('config: a health root inside the memory repo (or containing it) is invalid', () => {
  assert.throws(
    () => createConfig({ REPO_ROOT: repoRoot, HEALTH_REPO_ROOT: path.join(repoRoot, 'raw/snapshot') }),
    /Invalid HEALTH_REPO_ROOT/
  );
  assert.throws(
    () => createConfig({ REPO_ROOT: path.join(FIXTURE, 'members'), HEALTH_REPO_ROOT: FIXTURE }),
    /Invalid HEALTH_REPO_ROOT/
  );
  assert.equal(createConfig({ REPO_ROOT: repoRoot, HEALTH_REPO_ROOT: '' }).HEALTH_REPO_ROOT, null);
});

test('config: FAMILY_HEALTH_ALLOW_PROXY is dead config without a root or without a proxy', () => {
  assert.throws(() => createConfig({ REPO_ROOT: repoRoot, FAMILY_HEALTH_ALLOW_PROXY: 'true' }), /Invalid FAMILY_HEALTH_ALLOW_PROXY/);
  assert.throws(
    () => createConfig({ REPO_ROOT: repoRoot, HEALTH_REPO_ROOT: FIXTURE, FAMILY_HEALTH_ALLOW_PROXY: 'true' }),
    /Invalid FAMILY_HEALTH_ALLOW_PROXY/
  );
  const ok = createConfig({
    REPO_ROOT: repoRoot,
    HEALTH_REPO_ROOT: FIXTURE,
    FAMILY_HEALTH_ALLOW_PROXY: 'true',
    PROXY_HOSTNAME: 'aos-console.home.arpa',
    PROXY_SECRET,
  });
  assert.equal(ok.FAMILY_HEALTH_ALLOW_PROXY, true);
});

test('summary: one row per member (template excluded), counts, overview join, wiki cross-link', async () => {
  const res = await get(app(), '/api/family-health/summary');
  assert.equal(res.status, 200);
  const { members, totals, notice, overviewPresent } = res.body;
  assert.equal(overviewPresent, true);
  assert.match(notice, /never a diagnosis/);
  assert.deepEqual(members.map((m) => m.name), ['Ada Example', 'Bo Example']);

  const ada = members[0];
  assert.equal(ada.slug, 'ada-example');
  assert.equal(ada.wikiPath, 'wiki/projects/family-health-tracker/ada-example.md');
  assert.equal(ada.overview.bloodType, 'O+');
  assert.equal(ada.overview.keyConditions, 'Low ferritin (fixture)');
  assert.equal(ada.examsN, 2);
  assert.equal(ada.documentsN, 1);
  assert.equal(ada.medicationsN, 2);
  assert.equal(ada.openFollowUpsN, 3);
  assert.equal(ada.flaggedN, 3);
  assert.equal(ada.originalsMissingN, 1);
  assert.equal(ada.pendingN, 7);
  assert.equal(ada.lastExamDate, '2026-03-05');

  const bo = members[1];
  assert.equal(bo.wikiPath, null);
  assert.equal(bo.medicationsN, 0, '"None recorded" is not a medication');
  assert.equal(bo.conditionsN, 0, '"None known." is not a condition');
  assert.equal(bo.pendingN, 0);
  assert.equal(bo.examsN, 2);
  assert.equal(bo.narrativeN, 1, 'the ultrasound note has no results-shaped table');
  assert.equal(ada.narrativeN, 0);

  assert.equal(totals.membersN, 2);
  assert.equal(totals.examsN, 4);
  assert.equal(totals.narrativeN, 1);
  assert.equal(totals.pendingN, 7);
  assert.equal(totals.lastExamDate, '2026-03-05');
});

test('member file: profile, timeline, exam summaries, documents listed by name only, markers', async () => {
  const res = await get(app(), '/api/family-health/member?name=' + encodeURIComponent('Ada Example'));
  assert.equal(res.status, 200);
  const { profile, history, exams, documents, markers, stats } = res.body;
  assert.equal(profile.identity.find((f) => f.key === 'Blood type').value, 'O+');
  assert.deepEqual(profile.medications.map((m) => m.medication), ['Iron (fixture)', 'Vitamin D (fixture)']);
  assert.equal(profile.medications[0].dose, '100 mg');
  assert.equal(profile.careTeam[0].name, 'Dr. Fixture');
  assert.equal(profile.lastReviewed, '2026-03-05');
  assert.deepEqual(history.map((h) => h.date), ['2026-03-05', '2026-01-10']);
  assert.deepEqual(exams.map((e) => e.date), ['2026-01-10', '2026-03-05']);
  assert.equal(exams[1].originalMissing, true);
  assert.equal(exams[1].pendingResultsN, 1);
  assert.equal(documents.length, 1);
  assert.equal(documents[0].name, '2026-01-10_bloodwork.pdf');
  assert.equal(documents[0].ext, 'pdf');
  assert.ok(documents[0].absolutePath.endsWith('documents/2026-01-10_bloodwork.pdf'));
  assert.equal('markdown' in documents[0], false, 'binaries are never served');
  assert.deepEqual(
    markers.map((m) => [m.marker, m.n]),
    [['Ferritin', 2], ['Hemoglobin', 2], ['Vitamin D', 1]],
    'numeric results only; the Pending row and the text-only Culture row are excluded'
  );
  assert.equal(stats.examsN, 2);
});

test('member file: a narrative note (no results-shaped table) carries an outline, never body text', async () => {
  const res = await get(app(), '/api/family-health/member?name=' + encodeURIComponent('Bo Example'));
  assert.equal(res.status, 200);
  const { exams, stats } = res.body;
  assert.deepEqual(exams.map((e) => [e.date, e.kind]), [['2026-01-20', 'results'], ['2026-02-14', 'narrative']]);
  const note = exams[1];
  assert.equal(note.hasResultsTable, false);
  assert.equal(note.resultsN, 0);
  assert.equal(note.type, 'Abdominal ultrasound (fixture)');
  assert.equal(note.orderedBy, 'Dr. Fixture', '"Performed by" is read as the ordering physician');
  assert.equal(note.reason, 'Routine check (fixture)');
  assert.equal(note.originalMissing, false);
  assert.deepEqual(note.sections.map((s) => s.heading), ['Findings', 'Measurements', 'Follow-up']);
  const [findings, measurements, followUp] = note.sections;
  assert.equal(findings.fieldsN, 2);
  assert.equal(findings.bulletsN, 1);
  assert.equal(findings.paragraphsN, 1);
  assert.deepEqual(findings.tables, []);
  assert.deepEqual(measurements.tables, [{ headers: ['Item', 'Result'], rowsN: 2 }], 'a table without a reference-range column is outlined, not read as results');
  assert.equal(measurements.paragraphsN, 0, 'table lines are not paragraphs');
  assert.equal(followUp.checkboxesN, 1);
  assert.equal(followUp.openCheckboxesN, 0);
  assert.equal(JSON.stringify(note).includes('No free fluid'), false, 'outline carries no sentence from the note');
  assert.equal(JSON.stringify(note).includes('14 cm'), false, 'outline carries no cell value');
  assert.equal(stats.narrativeN, 1);
  assert.equal(stats.lastExamDate, '2026-02-14');
  // The results note keeps an outline too, with its results table headers.
  assert.equal(exams[0].sections[0].heading, 'Results');
  assert.deepEqual(exams[0].sections[0].tables[0].headers, ['Marker', 'Result', 'Unit', 'Reference range', 'Flag']);
});

test('member lookups: template, traversal and unknown names are refused without a path leak', async () => {
  for (const name of ['_TEMPLATE', '../reference', 'Ada Example/..', '.hidden']) {
    const res = await get(app(), '/api/family-health/member?name=' + encodeURIComponent(name));
    assert.equal(res.status, 400, name);
    assert.equal(res.body.error, 'bad-member');
  }
  const missing = await get(app(), '/api/family-health/member?name=Nobody');
  assert.equal(missing.status, 404);
  assert.equal(missing.body.error, 'not-found');
  assert.ok(!JSON.stringify(missing.body).includes(FIXTURE), 'error bodies carry no paths');
});

test('pending: all four signal kinds plus reference checklists, filterable by member', async () => {
  const res = await get(app(), '/api/family-health/pending');
  assert.equal(res.status, 200);
  assert.equal(res.body.total, 8);
  assert.deepEqual(res.body.byKind, { checkbox: 4, marker: 2, 'pending-result': 1, 'original-missing': 1 });
  const ref = res.body.items.find((it) => it.path === 'reference/questions.md');
  assert.equal(ref.member, null);
  assert.equal(ref.text, 'Ask about iron dose.');
  const pendingResult = res.body.items.find((it) => it.kind === 'pending-result');
  assert.equal(pendingResult.text, 'Vitamin D: Pending');
  assert.equal(pendingResult.date, '2026-03-05');
  const historyMarker = res.body.items.find((it) => it.kind === 'marker' && it.path.endsWith('history.md'));
  assert.equal(historyMarker.date, '2026-03-05', 'a marker inherits its history entry date');

  const ada = await get(app(), '/api/family-health/pending?member=' + encodeURIComponent('Ada Example'));
  assert.equal(ada.body.total, 7);
  const bo = await get(app(), '/api/family-health/pending?member=' + encodeURIComponent('Bo Example'));
  assert.equal(bo.body.total, 0);
});

test('trends: one marker across exam notes, each point keeps its own unit and range', async () => {
  const res = await get(app(), '/api/family-health/trends?member=' + encodeURIComponent('Ada Example') + '&marker=ferritin');
  assert.equal(res.status, 200);
  assert.deepEqual(
    res.body.points.map((p) => [p.date, p.value, p.range]),
    [['2026-01-10', 18.5, '10 – 300 (lab A)'], ['2026-03-05', 22, '15 – 150 (lab B)']]
  );
  assert.equal(res.body.excludedN, 0);
  const vitD = await get(app(), '/api/family-health/trends?member=' + encodeURIComponent('Ada Example') + '&marker=Vitamin%20D');
  assert.deepEqual(vitD.body.points.map((p) => p.value), [25]);
  assert.equal(vitD.body.excludedN, 1, 'the Pending row is excluded, not coerced');
  const noMarker = await get(app(), '/api/family-health/trends?member=' + encodeURIComponent('Ada Example'));
  assert.equal(noMarker.status, 400);
});

test('file: markdown inside the health root only; binaries, memory-repo paths and traversal are refused', async () => {
  const ok = await get(app(), '/api/family-health/file?path=' + encodeURIComponent('members/Ada Example/exams/2026-01-10_bloodwork.md'));
  assert.equal(ok.status, 200);
  assert.match(ok.body.markdown, /Baseline bloodwork/);
  assert.equal(ok.body.path, 'members/Ada Example/exams/2026-01-10_bloodwork.md');

  const pdf = await get(app(), '/api/family-health/file?path=' + encodeURIComponent('members/Ada Example/documents/2026-01-10_bloodwork.pdf'));
  assert.equal(pdf.status, 404);
  for (const p of ['../../etc/passwd', '/etc/passwd', 'wiki/index.md', 'AGENTS.md', '.git/config', 'README.md']) {
    const res = await get(app(), '/api/family-health/file?path=' + encodeURIComponent(p));
    assert.equal(res.status, 400, p);
    assert.equal(res.body.error, 'unsafe-path');
  }
});

test('the memory-repo APIs never reach the health root and never mention its members', async () => {
  const a = app();
  const viaDocs = await get(a, '/api/docs/file?path=' + encodeURIComponent('members/Ada Example/profile.md'));
  assert.equal(viaDocs.status, 400);
  const tree = await get(a, '/api/docs/tree');
  assert.ok(!JSON.stringify(tree.body).includes('Ada Example'));
  // The wiki member page is memory content and may match; the health root's
  // own text (a lab name that exists only in the fixture) must not.
  const search = await get(a, '/api/docs/search?q=' + encodeURIComponent('Fixture Lab'));
  assert.equal(search.status, 200);
  assert.equal(search.body.results.length, 0);
  const metrics = await get(a, '/api/metrics');
  assert.ok(!JSON.stringify(metrics.body).includes('Fixture Lab'));
});

test('proxy: family-health is refused through the proxy hostname by default and allowed only with the flag', async () => {
  const proxied = { PROXY_HOSTNAME: 'aos-console.home.arpa', PROXY_SECRET };
  const viaProxy = (a) =>
    request(a)
      .get('/api/family-health/summary')
      .set('Host', 'aos-console.home.arpa')
      .set('X-AOS-Proxy-Auth', PROXY_SECRET);

  const refused = await viaProxy(app(proxied));
  assert.equal(refused.status, 403);
  assert.equal(refused.body.error, 'family-health-proxy-refused');
  const loopbackStillOk = await get(app(proxied), '/api/family-health/summary');
  assert.equal(loopbackStillOk.status, 200);
  const otherRouteStillOk = await request(app(proxied))
    .get('/api/status')
    .set('Host', 'aos-console.home.arpa')
    .set('X-AOS-Proxy-Auth', PROXY_SECRET);
  assert.equal(otherRouteStillOk.status, 200);

  const allowed = await viaProxy(app({ ...proxied, FAMILY_HEALTH_ALLOW_PROXY: 'true' }));
  assert.equal(allowed.status, 200);
  const noSecret = await request(app({ ...proxied, FAMILY_HEALTH_ALLOW_PROXY: 'true' }))
    .get('/api/family-health/summary')
    .set('Host', 'aos-console.home.arpa');
  assert.equal(noSecret.status, 403, 'the ADR-0005 proxy secret still applies first');
});

test('parsers: numeric cells, header columns by name, and pending markers are literal', () => {
  assert.equal(numericValue('18.93'), 18.93);
  assert.equal(numericValue('825,00'), 825);
  assert.equal(numericValue('<0.5'), 0.5);
  assert.equal(numericValue('**140**'), 140);
  assert.equal(numericValue('Pending'), null);
  assert.equal(numericValue('No se observan'), null);

  const note = parseExamNote(
    [
      '# Panel — X',
      '',
      '- **Date:** 2026-05-01',
      '- **Original document:** — (not attached)',
      '',
      '## Resultados',
      '',
      '| Analito | Unidad | Valor | Rango de referencia | Estado |',
      '|---|---|---|---|---|',
      '| TSH | uUI/mL | 4.9 | 0.4 – 4.2 | ↑ Alto |',
      '',
      '## Seguimiento',
      '- [ ] Revisar con endocrinología.',
    ].join('\n'),
    'members/X/exams/2026-05-01_panel.md'
  );
  assert.equal(note.originalMissing, true);
  assert.equal(note.results[0].marker, 'TSH');
  assert.equal(note.results[0].numeric, 4.9);
  assert.equal(note.results[0].unit, 'uUI/mL');
  assert.equal(note.results[0].flagged, true);
  assert.equal(note.openFollowUpsN, 1);

  // A lab note without "## Results" but with result-shaped tables in several
  // sections is still read; a prescriptions table (no reference range) is not.
  const multi = parseExamNote(
    [
      '# Panel — X',
      '',
      '## CBC',
      '| Marker | Result | Unit | Reference range | Flag |',
      '|---|---|---|---|---|',
      '| Hemoglobin | 13.1 | g/dL | 12 – 16 | OK |',
      '',
      '## Differential',
      '| Marker | Result | Unit | Reference range | Flag |',
      '|---|---|---|---|---|',
      '| Neutrophils | 62 | % | 40 – 75 | OK |',
      '| Monocytes | 9 | % | 2 – 8 | ↑ |',
      '',
      '## Prescriptions',
      '| Medication | Dose | Frequency |',
      '|---|---|---|',
      '| Iron | 100 mg | daily |',
    ].join('\n'),
    'members/X/exams/2026-05-02_panel.md'
  );
  assert.equal(multi.hasResultsTable, true);
  assert.equal(multi.kind, 'results');
  assert.deepEqual(multi.results.map((r) => r.marker), ['Hemoglobin', 'Neutrophils', 'Monocytes']);
  assert.equal(multi.flaggedN, 1);

  // A visit note: "Ordered / performed by" header, a prescriptions table and
  // prose only → narrative, with an outline of headings and counts.
  const visit = parseExamNote(
    ['# Visit — X', '', '- **Date:** 2026-06-01', '- **Ordered / performed by:** Dr. Y', '- **Original document:** —', '', '## Printed diagnoses', '- one', '- two', '', '## Prescriptions', '| Medication | Dose | Frequency |', '|---|---|---|', '| Iron | 100 mg | daily |', '', 'Take with food.'].join('\n'),
    'members/X/exams/2026-06-01_visit.md'
  );
  assert.equal(visit.kind, 'narrative');
  assert.equal(visit.hasResultsTable, false);
  assert.equal(visit.orderedBy, 'Dr. Y');
  assert.equal(visit.originalMissing, true);
  assert.deepEqual(
    visit.sections.map((s) => [s.heading, s.bulletsN, s.tables.length, s.paragraphsN]),
    [['Printed diagnoses', 2, 0, 0], ['Prescriptions', 0, 1, 1]]
  );

  const items = collectPendingFromText('- plain\n- **Pendiente:** llamar\n- [ ] open\n- [x] done\nno marker here pending\n', 'reference/q.md', null);
  assert.deepEqual(items.map((i) => i.kind), ['marker', 'checkbox']);
});
