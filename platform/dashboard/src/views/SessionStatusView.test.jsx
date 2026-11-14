import { render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import SessionStatusView from './SessionStatusView.jsx';

// Synthetic payloads only: `example-host`, no real branch or capture.
const base = {
  today: '2026-11-13',
  maintenance: { state: 'ok', lastPass: '2026-11-10', ageDays: 3, reason: null },
  captures: {
    state: 'ok',
    draftN: 0,
    oldestDraftDays: null,
    ingestedSincePass: 1,
    lastPass: '2026-11-10',
    heldN: 0,
    oldestHeldDays: null,
    holdReasons: [],
  },
  git: { state: 'ok', branch: 'main', upstream: 'origin/main', ahead: 0, behind: 0, dirtyN: 0 },
  setup: {
    githook: { state: 'ok', fix: null, reason: null },
    host: { state: 'ok', name: 'example-host', reason: null },
    lintDeps: { state: 'not-checked', reason: 'python-environment', command: 'python3 scripts/aos_status.py' },
    skills: {
      state: 'not-checked',
      reason: 'reads-outside-repo-root',
      command: 'python3 scripts/sync-skills.py --check --global',
    },
  },
  lines: [],
  mirrors: 'scripts/aos_status.py',
  generatedAt: '2026-11-13T12:00:00.000Z',
};

const json = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });

function serve(payload, status = 200) {
  const fetchMock = vi.fn(() => Promise.resolve(json(payload, status)));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const panel = (title) => screen.getByText(title, { selector: '.label' }).closest('.panel');

afterEach(() => vi.unstubAllGlobals());

describe('SessionStatusView', () => {
  test('ok state: every panel renders from /api/session-status', async () => {
    const fetchMock = serve(base);
    render(<SessionStatusView refreshKey={0} />);
    await waitFor(() => expect(screen.getByText('Maintenance pass')).toBeInTheDocument());
    expect(fetchMock).toHaveBeenCalledWith('/api/session-status');
    expect(within(panel('Maintenance pass')).getByText('OK')).toBeInTheDocument();
    expect(within(panel('Maintenance pass')).getByText('2026-11-10')).toBeInTheDocument();
    expect(within(panel('Git')).getByText('main')).toBeInTheDocument();
    expect(within(panel('Git')).getByText('ahead 0 / behind 0')).toBeInTheDocument();
    expect(within(panel('Git')).getByText(/As of last fetch/)).toBeInTheDocument();
    expect(screen.getByText(/clone at REPO_ROOT on example-host/)).toBeInTheDocument();
    expect(within(panel('Setup')).getByText('example-host in wiki/agentic-os-locations.md')).toBeInTheDocument();
  });

  test('due and overdue maintenance render warn badges', async () => {
    serve({ ...base, maintenance: { state: 'overdue', lastPass: '2026-11-01', ageDays: 12, reason: null } });
    const { unmount } = render(<SessionStatusView refreshKey={0} />);
    await waitFor(() => expect(screen.getByText('OVERDUE')).toHaveClass('badge', 'warn'));
    unmount();

    serve({ ...base, maintenance: { state: 'due', lastPass: null, ageDays: null, reason: 'no-pass' } });
    render(<SessionStatusView refreshKey={0} />);
    await waitFor(() => expect(screen.getByText('DUE')).toHaveClass('badge', 'warn'));
    expect(screen.getByText(/entry in the log/)).toBeInTheDocument();
  });

  test('captures show the oldest age and the holds', async () => {
    serve({
      ...base,
      captures: { ...base.captures, draftN: 2, oldestDraftDays: 9, heldN: 1, oldestHeldDays: 20, holdReasons: ['waiting on owner'] },
    });
    render(<SessionStatusView refreshKey={0} />);
    await waitFor(() => expect(screen.getByText('2 for /aos-ingest · oldest 9d')).toBeInTheDocument());
    expect(screen.getByText('1 · oldest 20d · not overdue')).toBeInTheDocument();
    expect(screen.getByText(/waiting on owner/)).toBeInTheDocument();
  });

  test('git unavailable shows the reason and no zeros', async () => {
    serve({ ...base, git: { state: 'unavailable', reason: 'not-a-repository' } });
    render(<SessionStatusView refreshKey={0} />);
    await waitFor(() => expect(screen.getByText(/REPO_ROOT is not a git repository/)).toBeInTheDocument());
    const git = panel('Git');
    expect(within(git).queryByText(/ahead/)).toBeNull();
    expect(within(git).queryByText(/\b0\b/)).toBeNull();
    expect(within(git).queryByText('clean')).toBeNull();
  });

  test('not-checked rows show the reason and the command, never an ok dot', async () => {
    serve(base);
    render(<SessionStatusView refreshKey={0} />);
    await waitFor(() => expect(screen.getByText('Lint deps')).toBeInTheDocument());
    for (const [name, command, reason] of [
      ['Lint deps', 'python3 scripts/aos_status.py', /Python environment/],
      ['Skills sync', 'python3 scripts/sync-skills.py --check --global', /allowed roots/],
    ]) {
      const row = screen.getByText(name).closest('tr');
      expect(within(row).getByText('not checked')).toBeInTheDocument();
      expect(within(row).getByText(reason)).toBeInTheDocument();
      expect(within(row).getByTitle(command)).toBeInTheDocument();
      expect(row.querySelector('.status-dot')).toBeNull();
      expect(row.querySelector('.chip.ok')).toBeNull();
    }
  });

  test('a failed fetch shows the unavailable placeholder', async () => {
    serve({ error: 'session-status-failed' }, 500);
    render(<SessionStatusView refreshKey={0} />);
    await waitFor(() => expect(screen.getByText(/Session status unavailable — HTTP 500/)).toBeInTheDocument());
  });

  test('a manual refresh fetches again', async () => {
    const fetchMock = serve(base);
    const { rerender } = render(<SessionStatusView refreshKey={0} />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    rerender(<SessionStatusView refreshKey={1} />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });
});
