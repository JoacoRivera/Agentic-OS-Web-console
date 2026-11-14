import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, test, vi } from 'vitest';
import MemoryQueryView from './MemoryQueryView.jsx';

const hit = (n, extra = {}) => ({
  path: `wiki/notes/page-${String(n).padStart(2, '0')}.md`,
  title: `Page ${n}`,
  summary: `Summary ${n}.`,
  tags: [`tag-${n}`],
  score: 10 - n * 0.5,
  history: false,
  ...extra,
});

const emptyTags = { tagsInVocabulary: 3, matchedTags: [], results: [], truncated: false };

function response(results, overrides = {}) {
  return {
    query: 'maintenance pass',
    pagesIndexed: 20,
    includeHistory: false,
    pagesMatched: results.length,
    results,
    truncated: false,
    tagRecall: emptyTags,
    generatedAt: '2026-11-14T00:00:00.000Z',
    ...overrides,
  };
}

const json = (body) => Promise.resolve({ ok: true, status: 200, json: async () => body });

describe('MemoryQueryView', () => {
  test('renders BM25F results in server order with one-decimal scores, all tags and a history chip', async () => {
    const user = userEvent.setup();
    const results = [
      hit(1, { title: 'Maintenance Pass', score: 6.1234, tags: ['maintenance', 'cadence'] }),
      hit(2, { path: 'wiki/examples/sample.md', title: 'Worked Example', score: 2.55, history: true }),
    ];
    const fetchMock = vi.fn(() => json(response(results)));
    vi.stubGlobal('fetch', fetchMock);
    const onOpenDoc = vi.fn();
    render(<MemoryQueryView onOpenDoc={onOpenDoc} />);

    await user.type(screen.getByPlaceholderText('Ask memory a question…'), 'maintenance pass');
    const cards = await screen.findAllByTestId('mq-result');
    expect(cards.map((c) => within(c).getByText(/^(Maintenance Pass|Worked Example)$/).textContent)).toEqual([
      'Maintenance Pass',
      'Worked Example',
    ]);
    expect(within(cards[0]).getByText('6.1')).toBeTruthy();
    expect(within(cards[0]).getByText('maintenance')).toBeTruthy();
    expect(within(cards[0]).getByText('cadence')).toBeTruthy();
    expect(within(cards[0]).queryByText('history')).toBeNull();
    expect(within(cards[1]).getByText('history')).toBeTruthy();
    expect(screen.getByText('2 of 20 pages share a word with the question')).toBeTruthy();
    // Tag recall is collapsed while BM25F has results.
    expect(document.querySelector('details.mq-tag-recall').open).toBe(false);

    await user.click(within(cards[0]).getByRole('button', { name: /wiki\/notes\/page-01\.md/ }));
    expect(onOpenDoc).toHaveBeenCalledWith('wiki/notes/page-01.md');
  });

  test('shows the first 8 results and expands to all on request', async () => {
    const user = userEvent.setup();
    const results = Array.from({ length: 12 }, (_, i) => hit(i + 1));
    vi.stubGlobal('fetch', vi.fn(() => json(response(results))));
    render(<MemoryQueryView onOpenDoc={() => {}} />);

    await user.type(screen.getByPlaceholderText('Ask memory a question…'), 'pages');
    expect(await screen.findAllByTestId('mq-result')).toHaveLength(8);
    await user.click(screen.getByRole('button', { name: 'Show all 12' }));
    expect(screen.getAllByTestId('mq-result')).toHaveLength(12);
  });

  test('an empty BM25F result shows the rephrase copy and opens tag recall', async () => {
    const user = userEvent.setup();
    const tagRecall = {
      tagsInVocabulary: 3,
      matchedTags: [{ tag: 'lighthouse-notes', count: 1 }],
      results: [{ path: 'wiki/notes/coast.md', title: 'Coast', summary: 'Shore.', matchedTags: ['lighthouse-notes'] }],
      truncated: false,
    };
    vi.stubGlobal('fetch', vi.fn(() => json(response([], { query: 'lighthouse', tagRecall }))));
    render(<MemoryQueryView onOpenDoc={() => {}} />);

    await user.type(screen.getByPlaceholderText('Ask memory a question…'), 'lighthouse');
    expect(
      await screen.findByText('No page shares a word with the question — rephrase in English, or use the tags below.')
    ).toBeTruthy();
    expect(document.querySelector('details.mq-tag-recall').open).toBe(true);
    expect(screen.getByText('Coast')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'lighthouse-notes · 1' })).toBeTruthy();
  });

  test('the include-history checkbox refetches with includeHistory=1', async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn(() => json(response([hit(1)])));
    vi.stubGlobal('fetch', fetchMock);
    render(<MemoryQueryView onOpenDoc={() => {}} />);

    await user.type(screen.getByPlaceholderText('Ask memory a question…'), 'eval runs');
    await screen.findAllByTestId('mq-result');
    expect(fetchMock.mock.calls.at(-1)[0]).toBe('/api/memory/query?topic=eval%20runs');

    await user.click(screen.getByRole('checkbox', { name: /include history/i }));
    await waitFor(() =>
      expect(fetchMock.mock.calls.at(-1)[0]).toBe('/api/memory/query?topic=eval%20runs&includeHistory=1')
    );
    await screen.findAllByTestId('mq-result');
  });
});
