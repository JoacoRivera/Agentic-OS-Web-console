import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, test, vi } from 'vitest';
import MarkdownViewer from './MarkdownViewer.jsx';

const doc = {
  path: 'wiki/example.md',
  absolutePath: '/repo/wiki/example.md',
  source: 'wiki',
  frontmatter: {},
  markdown: '# Foo\n\n[Jump to duplicate](#foo-1)\n\n## Foo\n\n## Foo-1\n',
};

const docIndex = {
  paths: new Set(['wiki/example.md']),
  byBasename: new Map([['example', 'wiki/example.md']]),
};

function renderViewer(overrides = {}) {
  return render(
    <MarkdownViewer
      doc={doc}
      error={null}
      loading={false}
      docIndex={docIndex}
      backlinks={[]}
      onNavigate={vi.fn()}
      {...overrides}
    />
  );
}

describe('MarkdownViewer document navigation', () => {
  test('stamps deterministic unique IDs on duplicate headings', () => {
    const { container } = renderViewer();

    expect(
      [...container.querySelectorAll('.markdown h1, .markdown h2')].map((heading) => heading.id)
    ).toEqual(['doc-h-foo', 'doc-h-foo-1', 'doc-h-foo-1-1']);
  });

  test('scrolls local anchors and TOC actions to their rendered heading targets', async () => {
    const user = userEvent.setup();
    renderViewer();

    await user.click(screen.getByRole('link', { name: 'Jump to duplicate' }));
    expect(Element.prototype.scrollIntoView).toHaveBeenLastCalledWith({ block: 'start' });
    expect(Element.prototype.scrollIntoView.mock.instances.at(-1)).toHaveAttribute(
      'id',
      'doc-h-foo-1'
    );

    await user.click(screen.getByRole('button', { name: 'Foo-1' }));
    expect(Element.prototype.scrollIntoView.mock.instances.at(-1)).toHaveAttribute(
      'id',
      'doc-h-foo-1-1'
    );
  });
});
