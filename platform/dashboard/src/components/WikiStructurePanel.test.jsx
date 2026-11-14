import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, test, vi } from 'vitest';
import WikiStructurePanel from './WikiStructurePanel.jsx';

// Mocked at the fetch/EventSource seams; every path and message is synthetic.

const URL = '/api/maintenance/wiki-structure';
const operation = {
  id: 'check:wiki-structure',
  type: 'executable',
  title: 'Wiki structure check',
  description: 'Run the deterministic wiki lint.',
  commandPreview: 'npm run check:wiki-structure',
  migrationOnly: false,
};
const jsonResponse = (body, status = 200) => ({ ok: status < 300, status, json: async () => body });
const run = (result, extra = {}) => ({
  ts: '2026-11-14T06:00:00.000Z',
  status: result?.parsed && result.errors > 0 ? 'failed' : 'ok',
  exitCode: result?.parsed && result.errors > 0 ? 1 : 0,
  durationMs: 15000,
  result,
  ...extra,
});

function mockOnce(lastRun) {
  const fetchMock = vi.fn((url) => {
    if (url === URL) return Promise.resolve(jsonResponse({ operation, lastRun, generatedAt: 'now' }));
    throw new Error(`Unexpected fetch: ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('WikiStructurePanel', () => {
  test('never run: says so and offers the executable card', async () => {
    mockOnce(null);
    render(<WikiStructurePanel />);
    expect(await screen.findByText('never run')).toBeInTheDocument();
    expect(screen.getByText(/no run on record/i)).toBeInTheDocument();
    expect(screen.getByText('Wiki structure check')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'dry-run' })).toBeInTheDocument();
    expect(screen.getByText(/only the/)).toHaveTextContent('lint | maintenance pass');
  });

  test('a clean run shows the clean chip and the snapshot wording', async () => {
    mockOnce(run({ parsed: true, errors: 0, warnings: 0, findings: [], findingsTotal: 0, truncated: false, incomplete: false }));
    render(<WikiStructurePanel />);
    expect(await screen.findByText('clean')).toBeInTheDocument();
    expect(screen.getByText(/a snapshot of that run, not live/)).toHaveTextContent('2026-11-14T06:00:00.000Z');
    expect(screen.getByText(/a snapshot of that run/)).toHaveTextContent('15.0s');
  });

  test('errors and warnings are counted and listed errors first', async () => {
    mockOnce(
      run({
        parsed: true,
        errors: 2,
        warnings: 1,
        findings: [
          { level: 'error', message: 'wiki/example/a.md: broken link' },
          { level: 'error', message: 'wiki/example/b.md: bad frontmatter' },
          { level: 'warning', message: 'wiki/example/c.md: orphan page' },
        ],
        findingsTotal: 3,
        truncated: false,
        incomplete: false,
      })
    );
    const { container } = render(<WikiStructurePanel />);
    expect(await screen.findByText('2 errors')).toBeInTheDocument();
    expect(screen.getByText('1 warning')).toBeInTheDocument();
    const rows = [...container.querySelectorAll('table.kv tr')].map((tr) => tr.textContent);
    expect(rows).toEqual([
      'errorwiki/example/a.md: broken link',
      'errorwiki/example/b.md: bad frontmatter',
      'warningwiki/example/c.md: orphan page',
    ]);
  });

  test('truncated and incomplete results say so', async () => {
    mockOnce(
      run({
        parsed: true,
        errors: 150,
        warnings: 0,
        findings: [{ level: 'error', message: 'wiki/example/a.md: x' }],
        findingsTotal: 140,
        truncated: true,
        incomplete: true,
      })
    );
    render(<WikiStructurePanel />);
    expect(await screen.findByText('150 errors')).toBeInTheDocument();
    expect(screen.getByText(/showing 1 of 140 findings/i)).toBeInTheDocument();
    expect(screen.getByText(/do not match the report/i)).toBeInTheDocument();
  });

  test('an unparsed run shows the reason and never a zero count', async () => {
    mockOnce(
      run(
        { parsed: false, reason: 'the lint reported REPO_ROOT is not a lintable repo root (exit 2)' },
        { status: 'failed', exitCode: 2 }
      )
    );
    const { container } = render(<WikiStructurePanel />);
    expect(await screen.findByText('failed')).toBeInTheDocument();
    expect(screen.getByText(/not a lintable repo root/)).toBeInTheDocument();
    expect(screen.getByText(/Audit Log/)).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/\b0 errors?\b/);
    expect(screen.queryByText('clean')).not.toBeInTheDocument();
  });

  test('an audit entry without a result is shown as failed, not clean', async () => {
    mockOnce(run(null));
    render(<WikiStructurePanel />);
    expect(await screen.findByText('failed')).toBeInTheDocument();
    expect(screen.getByText(/no parsed result/)).toBeInTheDocument();
  });

  test('an endpoint error is surfaced', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(jsonResponse({ message: 'boom' }, 500))));
    render(<WikiStructurePanel />);
    expect(await screen.findByText(/unavailable — boom/)).toBeInTheDocument();
  });

  test('refetches the last run when the card finishes a run', async () => {
    const user = userEvent.setup();
    const sources = [];
    vi.stubGlobal(
      'EventSource',
      class {
        constructor(url) {
          this.url = url;
          this.listeners = {};
          this.close = vi.fn();
          sources.push(this);
        }
        addEventListener(type, cb) {
          this.listeners[type] = cb;
        }
        removeEventListener() {}
      }
    );
    let lastRun = null;
    const fetchMock = vi.fn((url) => {
      if (url === URL) return Promise.resolve(jsonResponse({ operation, lastRun, generatedAt: 'now' }));
      if (url.endsWith('/dry-run')) {
        return Promise.resolve(jsonResponse({ confirmToken: 't', command: 'npm run check:wiki-structure', cwd: '/p' }));
      }
      if (url.endsWith('/run')) return Promise.resolve(jsonResponse({ runId: 'run-1' }, 202));
      throw new Error(`Unexpected fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<WikiStructurePanel />);
    await user.click(await screen.findByRole('button', { name: 'dry-run' }));
    await user.click(await screen.findByRole('button', { name: /confirm & run/i }));
    await screen.findByText(/streaming · run run-1/);

    lastRun = run({ parsed: true, errors: 0, warnings: 0, findings: [], findingsTotal: 0, truncated: false, incomplete: false });
    act(() => {
      sources[0].listeners.done({ data: JSON.stringify({ status: 'ok', exitCode: 0, durationMs: 1, stdout: '', stderr: '' }) });
    });
    await waitFor(() => expect(screen.getByText('clean')).toBeInTheDocument());
    expect(fetchMock.mock.calls.filter(([u]) => u === URL)).toHaveLength(2);
  });
});
