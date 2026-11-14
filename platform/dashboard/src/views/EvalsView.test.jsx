import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, test, vi } from 'vitest';
import EvalsView from './EvalsView.jsx';

// Synthetic payload (invented ids). The view shows recorded verdicts only —
// the console never runs or judges an eval (ADR-0001).
const R = 'wiki/workflows/evals/results';
const run = (date, verdict, line, extra = {}) => ({
  date,
  path: `${R}/${date}.md`,
  line,
  verdict,
  subject: null,
  note: null,
  type: 'judgment',
  confirmed: false,
  missingFields: [],
  ...extra,
});

const payload = {
  root: 'wiki/workflows/evals',
  evals: [
    {
      id: 'eval-beta',
      case: { path: 'wiki/workflows/evals/cases/beta.md', title: 'Eval — Beta', type: 'judgment' },
      lastRunDate: '2026-02-07',
      latest: { verdict: 'PASS', date: '2026-02-07' },
      counts: { PASS: 1, PARTIAL: 1, FAIL: 1 },
      // Newest first, as the API returns them.
      runs: [
        run('2026-02-07', 'PASS', 12, { note: 'rerun', confirmed: true }),
        run('2026-02-07', 'FAIL', 24),
        run('2026-01-10', 'PARTIAL', 20, { note: 'first run' }),
      ],
    },
    {
      id: 'eval-gamma',
      case: { path: 'wiki/workflows/evals/cases/gamma.md', title: 'Eval — Gamma', type: 'mixed' },
      lastRunDate: null,
      latest: null,
      counts: { PASS: 0, PARTIAL: 0, FAIL: 0 },
      runs: [],
    },
    {
      id: 'eval-retired',
      case: null,
      lastRunDate: '2026-01-10',
      latest: { verdict: 'PASS', date: '2026-01-10' },
      counts: { PASS: 1, PARTIAL: 0, FAIL: 0 },
      runs: [run('2026-01-10', 'PASS', 30, { subject: 'fixture A only', type: 'mixed' })],
    },
  ],
  suite: {
    cases: 2,
    resultFiles: 2,
    runs: 4,
    lastRunDate: '2026-02-07',
    fullSuiteDates: ['2026-02-07'],
    lastFullSuiteDate: '2026-02-07',
    neverFullSuite: false,
    ageDays: 13,
    dueDays: 28,
    due: false,
    neverRun: ['eval-gamma'],
    withoutCase: ['eval-retired'],
  },
  problemCount: 1,
  problems: [{ path: `${R}/notes.md`, line: null, reason: 'bad-filename' }],
  orderNote: 'Runs carry a date, not a time.',
  generatedAt: '2026-02-20T12:00:00.000Z',
};

function stubFetch(response) {
  const fetchMock = vi.fn(() => Promise.resolve(response));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('EvalsView', () => {
  test('renders the notice, suite clock and one row per eval', async () => {
    const fetchMock = stubFetch({ ok: true, status: 200, json: async () => payload });
    render(<EvalsView onOpenDoc={() => {}} />);

    expect(await screen.findByText(/The console never runs or judges an eval/)).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith('/api/evals');
    expect(screen.getByText(/Last full-suite run 2026-02-07 \(13 days ago\)/)).toBeInTheDocument();
    expect(screen.getByText(/due at 28 days \(memory-repo lint check 23\)/)).toBeInTheDocument();
    expect(screen.getByText('Cases never run:').parentElement).toHaveTextContent('eval-gamma');
    expect(screen.getByText('Runs recorded but no case page:').parentElement).toHaveTextContent('eval-retired');
    expect(within(screen.getByRole('list', { name: 'format problems' })).getByText(/notes\.md — bad-filename/)).toBeInTheDocument();

    for (const id of ['eval-beta', 'eval-gamma', 'eval-retired']) {
      expect(screen.getByRole('button', { name: id })).toBeInTheDocument();
    }
    const gammaRow = screen.getByRole('button', { name: 'eval-gamma' }).closest('tr');
    expect(within(gammaRow).getAllByText('never run').length).toBeGreaterThan(0);
  });

  test('history strip: one labelled mark per run, oldest → newest, readable without colour', async () => {
    stubFetch({ ok: true, status: 200, json: async () => payload });
    render(<EvalsView onOpenDoc={() => {}} />);

    const strip = await screen.findByRole('list', { name: 'eval-beta recorded verdicts, oldest to newest' });
    const marks = within(strip).getAllByRole('listitem');
    expect(marks.map((m) => m.textContent)).toEqual(['~', 'F', 'P']);
    expect(marks.map((m) => m.getAttribute('aria-label'))).toEqual([
      '2026-01-10 · PARTIAL · note: first run',
      '2026-02-07 · FAIL',
      '2026-02-07 · PASS · note: rerun',
    ]);
  });

  test('expanding a row lists its runs; a result link opens the file in Documentation', async () => {
    const user = userEvent.setup();
    const onOpenDoc = vi.fn();
    stubFetch({ ok: true, status: 200, json: async () => payload });
    render(<EvalsView onOpenDoc={onOpenDoc} />);

    const toggle = await screen.findByRole('button', { name: 'eval-beta' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');

    const list = screen.getByRole('list', { name: 'eval-beta recorded runs, latest record first' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(3);
    expect(within(list).getByText('confirmed by owner')).toBeInTheDocument();

    await user.click(within(list).getAllByRole('button', { name: `${R}/2026-01-10.md` })[0]);
    expect(onOpenDoc).toHaveBeenCalledWith(`${R}/2026-01-10.md`);

    await user.click(screen.getByRole('button', { name: 'wiki/workflows/evals/cases/beta.md' }));
    expect(onOpenDoc).toHaveBeenCalledWith('wiki/workflows/evals/cases/beta.md');
  });

  test('offers no control that runs, judges or executes an eval', async () => {
    const user = userEvent.setup();
    stubFetch({ ok: true, status: 200, json: async () => payload });
    render(<EvalsView onOpenDoc={() => {}} />);
    await user.click(await screen.findByRole('button', { name: 'eval-beta' }));

    for (const button of screen.getAllByRole('button')) {
      expect(button.textContent).not.toMatch(/\b(run|judge|execute)\b/i);
    }
  });

  test('shows the error state when the API fails', async () => {
    stubFetch({ ok: false, status: 500, json: async () => ({ error: 'evals-failed', message: 'boom' }) });
    render(<EvalsView onOpenDoc={() => {}} />);
    expect(await screen.findByText('Evals unavailable — boom')).toBeInTheDocument();
  });
});
