import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, test, vi } from 'vitest';
import ExecutableOperationCard from './ExecutableOperationCard.jsx';

// jsdom has no layout engine and no real network/EventSource implementation:
// these tests characterize DOM/state behavior against mocked fetch/EventSource
// boundaries, not visual layout/paint or real browser SSE transport behavior.

const op = {
  id: 'check:demo',
  type: 'executable',
  title: 'Demo check',
  description: 'A deterministic check for tests.',
  commandPreview: 'npm run check:demo',
  migrationOnly: false,
};

const DRY_RUN_URL = '/api/operations/check%3Ademo/dry-run';
const RUN_URL = '/api/operations/check%3Ademo/run';
const SNAPSHOT_URL = '/api/operations/runs/run-9';

function jsonResponse(body, status = 200) {
  return { ok: status < 300, status, json: async () => body };
}

class FakeEventSource {
  constructor(url) {
    this.url = url;
    this.listeners = {};
    this.close = vi.fn();
    this.onerror = null;
    FakeEventSource.instances.push(this);
  }
  addEventListener(type, cb) {
    this.listeners[type] = cb;
  }
  removeEventListener(type, cb) {
    if (this.listeners[type] === cb) delete this.listeners[type];
  }
  emit(type, data) {
    this.listeners[type]?.({ data: JSON.stringify(data) });
  }
}

afterEach(() => {
  vi.useRealTimers();
});

async function dryRunAndConfirmPrompt(user, fetchMock) {
  vi.stubGlobal('fetch', fetchMock);
  const rendered = render(<ExecutableOperationCard op={op} />);
  await user.click(screen.getByRole('button', { name: 'dry-run' }));
  await screen.findByRole('button', { name: /confirm & run/i });
  return rendered;
}

describe('ExecutableOperationCard', () => {
  test('dry-run posts the operation id with no body and renders the confirm step', async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn((url) => {
      if (url === DRY_RUN_URL) {
        return Promise.resolve(
          jsonResponse({ confirmToken: 'tok-1', command: 'npm run check:demo', cwd: '/repo' })
        );
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    const { container } = render(<ExecutableOperationCard op={op} />);
    vi.stubGlobal('fetch', fetchMock);

    await user.click(screen.getByRole('button', { name: 'dry-run' }));
    await screen.findByRole('button', { name: /confirm & run/i });

    expect(fetchMock).toHaveBeenCalledWith(DRY_RUN_URL, {
      method: 'POST',
      headers: {},
      body: undefined,
      signal: expect.any(AbortSignal),
    });
    const confirmText = container.querySelector('.exec-confirm-text');
    expect(confirmText).toHaveTextContent('npm run check:demo');
    expect(confirmText).toHaveTextContent('/repo');
  });

  test('cancel discards the dry-run without starting anything', async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn((url) => {
      if (url === DRY_RUN_URL) {
        return Promise.resolve(
          jsonResponse({ confirmToken: 'tok-1', command: 'npm run check:demo', cwd: '/repo' })
        );
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    await dryRunAndConfirmPrompt(user, fetchMock);

    await user.click(screen.getByRole('button', { name: 'cancel' }));

    expect(screen.queryByText(/dry-run only/i)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'dry-run' })).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('confirm posts the dry-run token, then aggregates SSE output into a done snapshot', async () => {
    const user = userEvent.setup();
    FakeEventSource.instances = [];
    vi.stubGlobal('EventSource', FakeEventSource);

    const fetchMock = vi.fn((url) => {
      if (url === DRY_RUN_URL) {
        return Promise.resolve(
          jsonResponse({ confirmToken: 'tok-1', command: 'npm run check:demo', cwd: '/repo' })
        );
      }
      if (url === RUN_URL) {
        return Promise.resolve(jsonResponse({ runId: 'run-123' }, 202));
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    const { container } = await dryRunAndConfirmPrompt(user, fetchMock);

    await user.click(screen.getByRole('button', { name: /confirm & run/i }));

    expect(await screen.findByText(/streaming · run run-123/)).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(RUN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: true, confirmToken: 'tok-1' }),
      signal: expect.any(AbortSignal),
    });

    expect(FakeEventSource.instances).toHaveLength(1);
    const source = FakeEventSource.instances[0];
    expect(source.url).toBe('/api/operations/runs/run-123/events');

    const stream = container.querySelector('.exec-stream');
    Object.defineProperty(stream, 'scrollHeight', { configurable: true, value: 42 });
    Element.prototype.scrollTo.mockClear();

    act(() => {
      source.emit('output', { chunk: 'foo ' });
      source.emit('output', { chunk: 'bar' });
    });
    expect(screen.getByText('foo bar')).toBeInTheDocument();
    expect(Element.prototype.scrollTo).toHaveBeenLastCalledWith(0, 42);

    act(() => {
      source.emit('done', {
        status: 'ok',
        exitCode: 0,
        durationMs: 1234,
        gitAvailable: true,
        changedFiles: ['a.txt'],
        stdout: 'all good',
        stderr: '',
        gitDiff: '+ added line',
      });
    });

    expect(source.close).toHaveBeenCalled();
    expect(screen.queryByText(/streaming/)).not.toBeInTheDocument();
    expect(screen.getByText('ok')).toBeInTheDocument();
    expect(screen.getByText(/exit 0/)).toBeInTheDocument();
    expect(screen.getByText(/1\.2s/)).toBeInTheDocument();
    expect(screen.getByText(/1 file\(s\) changed/)).toBeInTheDocument();
    expect(screen.getByText('all good')).toBeInTheDocument();
    expect(screen.getByText('a.txt')).toBeInTheDocument();
    expect(screen.getByText('+ added line')).toBeInTheDocument();
  });

  test('closes the EventSource on unmount while a run is still streaming', async () => {
    const user = userEvent.setup();
    FakeEventSource.instances = [];
    vi.stubGlobal('EventSource', FakeEventSource);

    const fetchMock = vi.fn((url) => {
      if (url === DRY_RUN_URL) {
        return Promise.resolve(
          jsonResponse({ confirmToken: 'tok-1', command: 'npm run check:demo', cwd: '/repo' })
        );
      }
      if (url === RUN_URL) {
        return Promise.resolve(jsonResponse({ runId: 'run-77' }, 202));
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    const { unmount } = await dryRunAndConfirmPrompt(user, fetchMock);
    await user.click(screen.getByRole('button', { name: /confirm & run/i }));
    await screen.findByText(/streaming · run run-77/);

    const source = FakeEventSource.instances[0];
    const lateOutput = source.listeners.output;
    const lateDone = source.listeners.done;
    const lateError = source.onerror;
    expect(source.close).not.toHaveBeenCalled();

    unmount();

    expect(source.close).toHaveBeenCalledTimes(1);
    expect(source.listeners).toEqual({});
    expect(source.onerror).toBeNull();
    expect(() => lateOutput({ data: 'malformed late output' })).not.toThrow();
    expect(() => lateDone({ data: 'malformed late done' })).not.toThrow();

    vi.useFakeTimers();
    act(() => lateError());
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(fetchMock.mock.calls.some(([url]) => url.includes('/api/operations/runs/'))).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  });

  test('does not create an EventSource when unmounted before the run POST resolves', async () => {
    const user = userEvent.setup();
    FakeEventSource.instances = [];
    vi.stubGlobal('EventSource', FakeEventSource);
    let resolveRun;
    const deferredRun = new Promise((resolve) => { resolveRun = resolve; });
    const fetchMock = vi.fn((url) => {
      if (url === DRY_RUN_URL) {
        return Promise.resolve(
          jsonResponse({ confirmToken: 'tok-1', command: 'npm run check:demo', cwd: '/repo' })
        );
      }
      if (url === RUN_URL) return deferredRun;
      throw new Error(`Unexpected fetch: ${url}`);
    });
    const { unmount } = await dryRunAndConfirmPrompt(user, fetchMock);
    const confirm = user.click(screen.getByRole('button', { name: /confirm & run/i }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(RUN_URL, expect.anything()));

    unmount();
    const runOptions = fetchMock.mock.calls.find(([url]) => url === RUN_URL)[1];
    expect(runOptions.signal.aborted).toBe(true);
    await act(async () => {
      resolveRun(jsonResponse({ runId: 'run-late' }, 202));
      await confirm;
    });

    expect(FakeEventSource.instances).toHaveLength(0);
  });

  test('aborts an in-flight dry-run request on unmount', async () => {
    const user = userEvent.setup();
    let resolveDry;
    const deferredDry = new Promise((resolve) => { resolveDry = resolve; });
    const fetchMock = vi.fn((url) => {
      if (url === DRY_RUN_URL) return deferredDry;
      throw new Error(`Unexpected fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const { unmount } = render(<ExecutableOperationCard op={op} />);
    const click = user.click(screen.getByRole('button', { name: 'dry-run' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());

    const signal = fetchMock.mock.calls[0][1].signal;
    unmount();
    expect(signal.aborted).toBe(true);
    await act(async () => {
      resolveDry(jsonResponse({ confirmToken: 'late' }));
      await click;
    });
  });

  test('falls back to snapshot polling on an SSE error, and resolves on terminal status', async () => {
    const user = userEvent.setup();
    FakeEventSource.instances = [];
    vi.stubGlobal('EventSource', FakeEventSource);

    const fetchMock = vi.fn((url) => {
      if (url === DRY_RUN_URL) {
        return Promise.resolve(
          jsonResponse({ confirmToken: 'tok-1', command: 'npm run check:demo', cwd: '/repo' })
        );
      }
      if (url === RUN_URL) return Promise.resolve(jsonResponse({ runId: 'run-9' }, 202));
      if (url === SNAPSHOT_URL) {
        return Promise.resolve(
          jsonResponse({
            status: 'ok',
            exitCode: 0,
            durationMs: 500,
            gitAvailable: false,
            changedFiles: [],
            stdout: 'polled result',
            stderr: '',
          })
        );
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    await dryRunAndConfirmPrompt(user, fetchMock);
    await user.click(screen.getByRole('button', { name: /confirm & run/i }));
    await screen.findByText(/streaming · run run-9/);

    const source = FakeEventSource.instances[0];
    vi.useFakeTimers();
    act(() => {
      source.onerror();
    });
    // The polling fallback waits one fixed interval before its first
    // snapshot fetch; the mocked terminal status ends the loop after that
    // single tick, so advancing once cannot spin forever.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    vi.useRealTimers();

    expect(source.close).toHaveBeenCalled();
    expect(await screen.findByText('polled result')).toBeInTheDocument();
    expect(screen.getByText('ok')).toBeInTheDocument();
    expect(screen.queryByText(/streaming/)).not.toBeInTheDocument();
  });

  test('surfaces a lost-run error when the polling fallback cannot find the run', async () => {
    const user = userEvent.setup();
    FakeEventSource.instances = [];
    vi.stubGlobal('EventSource', FakeEventSource);

    const fetchMock = vi.fn((url) => {
      if (url === DRY_RUN_URL) {
        return Promise.resolve(
          jsonResponse({ confirmToken: 'tok-1', command: 'npm run check:demo', cwd: '/repo' })
        );
      }
      if (url === RUN_URL) return Promise.resolve(jsonResponse({ runId: 'run-9' }, 202));
      if (url === SNAPSHOT_URL) return Promise.resolve(jsonResponse({}, 404));
      throw new Error(`Unexpected fetch: ${url}`);
    });
    await dryRunAndConfirmPrompt(user, fetchMock);
    await user.click(screen.getByRole('button', { name: /confirm & run/i }));
    await screen.findByText(/streaming · run run-9/);

    const source = FakeEventSource.instances[0];
    vi.useFakeTimers();
    act(() => {
      source.onerror();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    vi.useRealTimers();

    expect(await screen.findByText(/run lost \(HTTP 404\)/i)).toBeInTheDocument();
    expect(screen.queryByText(/streaming/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'dry-run' })).toBeInTheDocument();
  });

  test('cancels the polling fallback on unmount before it fetches a snapshot', async () => {
    const user = userEvent.setup();
    FakeEventSource.instances = [];
    vi.stubGlobal('EventSource', FakeEventSource);
    const fetchMock = vi.fn((url) => {
      if (url === DRY_RUN_URL) {
        return Promise.resolve(
          jsonResponse({ confirmToken: 'tok-1', command: 'npm run check:demo', cwd: '/repo' })
        );
      }
      if (url === RUN_URL) return Promise.resolve(jsonResponse({ runId: 'run-9' }, 202));
      if (url === SNAPSHOT_URL) throw new Error('polling must stop after unmount');
      throw new Error(`Unexpected fetch: ${url}`);
    });
    const { unmount } = await dryRunAndConfirmPrompt(user, fetchMock);
    await user.click(screen.getByRole('button', { name: /confirm & run/i }));
    await screen.findByText(/streaming · run run-9/);

    vi.useFakeTimers();
    act(() => {
      FakeEventSource.instances[0].onerror();
    });
    unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();

    expect(fetchMock.mock.calls.some(([url]) => url === SNAPSHOT_URL)).toBe(false);
  });

  test('aborts an in-flight snapshot and does not schedule another poll after unmount', async () => {
    const user = userEvent.setup();
    FakeEventSource.instances = [];
    vi.stubGlobal('EventSource', FakeEventSource);
    let resolveSnapshot;
    const deferredSnapshot = new Promise((resolve) => { resolveSnapshot = resolve; });
    const fetchMock = vi.fn((url) => {
      if (url === DRY_RUN_URL) {
        return Promise.resolve(jsonResponse({ confirmToken: 'tok-1', command: 'cmd', cwd: '/repo' }));
      }
      if (url === RUN_URL) return Promise.resolve(jsonResponse({ runId: 'run-9' }, 202));
      if (url === SNAPSHOT_URL) return deferredSnapshot;
      throw new Error(`Unexpected fetch: ${url}`);
    });
    const { unmount } = await dryRunAndConfirmPrompt(user, fetchMock);
    await user.click(screen.getByRole('button', { name: /confirm & run/i }));
    await screen.findByText(/streaming · run run-9/);

    vi.useFakeTimers();
    act(() => { FakeEventSource.instances[0].onerror(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    const snapshotCalls = () => fetchMock.mock.calls.filter(([url]) => url === SNAPSHOT_URL);
    expect(snapshotCalls()).toHaveLength(1);
    const signal = snapshotCalls()[0][1].signal;

    unmount();
    expect(signal.aborted).toBe(true);
    await act(async () => { resolveSnapshot(jsonResponse({ status: 'running' })); });
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    vi.useRealTimers();
    expect(snapshotCalls()).toHaveLength(1);
  });
});
