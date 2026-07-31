import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, test, vi } from 'vitest';
import DocsView from './DocsView.jsx';

const tree = {
  roots: [
    {
      type: 'dir',
      name: 'wiki',
      path: 'wiki',
      source: 'wiki',
      children: [
        { type: 'file', name: 'source.md', path: 'wiki/source.md', source: 'wiki' },
        { type: 'file', name: 'target.md', path: 'wiki/target.md', source: 'wiki' },
      ],
    },
  ],
};

const sourceDoc = {
  path: 'wiki/source.md',
  absolutePath: '/repo/wiki/source.md',
  source: 'wiki',
  frontmatter: {},
  markdown: '# Source\n\n[Read target](target.md#Target%20heading)\n',
};

const targetDoc = {
  path: 'wiki/target.md',
  absolutePath: '/repo/wiki/target.md',
  source: 'wiki',
  frontmatter: {},
  markdown: '# Target heading\n',
};

function jsonResponse(body) {
  return {
    ok: true,
    status: 200,
    json: async () => body,
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('DocsView cross-document navigation', () => {
  test('waits for the target document to render before scrolling its fragment', async () => {
    const user = userEvent.setup();
    const targetResponse = deferred();
    const fetchMock = vi.fn((url) => {
      if (url === '/api/docs/tree') return Promise.resolve(jsonResponse(tree));
      if (url.startsWith('/api/docs/backlinks?')) {
        return Promise.resolve(jsonResponse({ backlinks: [] }));
      }
      if (url === '/api/docs/file?path=wiki%2Fsource.md') {
        return Promise.resolve(jsonResponse(sourceDoc));
      }
      if (url === '/api/docs/file?path=wiki%2Ftarget.md') {
        return targetResponse.promise;
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<DocsView openRequest={{ path: 'wiki/source.md' }} />);
    await user.click(await screen.findByRole('link', { name: 'Read target' }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/api/docs/file?path=wiki%2Ftarget.md');
    });
    expect(Element.prototype.scrollIntoView).not.toHaveBeenCalled();

    targetResponse.resolve(jsonResponse(targetDoc));
    expect(
      await screen.findByRole('heading', { name: 'Target heading' })
    ).toHaveAttribute('id', 'doc-h-target-heading');
    await waitFor(() => {
      expect(Element.prototype.scrollIntoView.mock.instances.at(-1)).toHaveAttribute(
        'id',
        'doc-h-target-heading'
      );
    });
  });
});
