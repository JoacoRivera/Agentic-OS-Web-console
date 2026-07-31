import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import GuidedOperationCard from './GuidedOperationCard.jsx';

// jsdom has no layout engine, so these tests characterize DOM/state behavior
// only — not visual layout, paint, or scroll position.

const op = {
  id: 'guided-test-op',
  type: 'guided',
  title: 'Session start',
  description: 'Kick off a working session.',
  skill: 'aos-query-memory',
  workflow: 'wiki/workflows/manual-operations.md',
  checklist: [
    'Read AGENTS.md at the start of the session.',
    'Recall relevant memory before working.',
    'Check wiki/log.md for the last lint entry.',
  ],
  commandPreview: '/aos-query-memory <topic> <mode>',
  params: [
    { name: 'topic', label: 'Topic', hint: 'what you are about to work on' },
    { name: 'mode', label: 'Mode', options: ['fast', 'thorough'] },
  ],
};

const PROGRESS_KEY = 'aos-console:op-progress:guided-test-op';

beforeEach(() => {
  localStorage.clear();
});

describe('GuidedOperationCard', () => {
  test('tracks checklist progress, persists it in localStorage, and resets cleanly', async () => {
    const user = userEvent.setup();
    const { unmount } = render(<GuidedOperationCard op={op} onOpenDoc={vi.fn()} />);

    expect(screen.getByText('0/3')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /reset/i })).not.toBeInTheDocument();

    const steps = screen.getAllByRole('checkbox');
    expect(steps).toHaveLength(3);

    await user.click(steps[0]);
    await user.click(steps[1]);

    expect(screen.getByText('2/3')).toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem(PROGRESS_KEY))).toEqual([true, true, false]);

    // Persistence: a fresh mount of the same operation id restores progress
    // from localStorage rather than starting blank.
    unmount();
    render(<GuidedOperationCard op={op} onOpenDoc={vi.fn()} />);
    const restored = screen.getAllByRole('checkbox');
    expect(restored[0]).toBeChecked();
    expect(restored[1]).toBeChecked();
    expect(restored[2]).not.toBeChecked();
    expect(screen.getByText('2/3')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /reset/i }));
    expect(screen.getByText('0/3')).toBeInTheDocument();
    expect(localStorage.getItem(PROGRESS_KEY)).toBeNull();
    expect(screen.queryByRole('button', { name: /reset/i })).not.toBeInTheDocument();
    for (const box of screen.getAllByRole('checkbox')) expect(box).not.toBeChecked();
  });

  test('substitutes typed and selected param values into the copyable command preview', async () => {
    const user = userEvent.setup();
    render(<GuidedOperationCard op={op} onOpenDoc={vi.fn()} />);

    expect(screen.getByText('/aos-query-memory <topic> <mode>')).toBeInTheDocument();

    await user.type(screen.getByPlaceholderText('what you are about to work on'), 'auth-flow');
    expect(screen.getByText('/aos-query-memory auth-flow <mode>')).toBeInTheDocument();

    await user.selectOptions(screen.getByRole('combobox'), 'thorough');
    expect(screen.getByText('/aos-query-memory auth-flow thorough')).toBeInTheDocument();

    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { ...window.navigator, clipboard: { writeText } });
    await user.click(screen.getByRole('button', { name: 'copy' }));
    expect(writeText).toHaveBeenCalledOnce();
    expect(writeText).toHaveBeenCalledWith('/aos-query-memory auth-flow thorough');
  });

  test('opens the linked workflow doc via callback, and never touches the network', async () => {
    const user = userEvent.setup();
    const onOpenDoc = vi.fn();
    const fetchMock = vi.fn(() => {
      throw new Error('GuidedOperationCard must never call fetch — it only fills a preview');
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<GuidedOperationCard op={op} onOpenDoc={onOpenDoc} />);

    const steps = screen.getAllByRole('checkbox');
    await user.click(steps[0]);
    await user.click(screen.getByRole('button', { name: /reset/i }));
    await user.type(screen.getByPlaceholderText('what you are about to work on'), 'x');
    await user.selectOptions(screen.getByRole('combobox'), 'fast');

    await user.click(screen.getByRole('button', { name: op.workflow }));

    expect(onOpenDoc).toHaveBeenCalledWith(op.workflow);
    expect(onOpenDoc).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
