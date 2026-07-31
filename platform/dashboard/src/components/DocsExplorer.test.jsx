import { useState } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, test } from 'vitest';
import DocsExplorer from './DocsExplorer.jsx';

const tree = {
  roots: [
    {
      type: 'dir',
      name: 'wiki',
      path: 'wiki',
      source: 'wiki',
      children: [
        {
          type: 'dir',
          name: 'guides',
          path: 'wiki/guides',
          source: 'wiki',
          children: [
            {
              type: 'dir',
              name: 'workflows',
              path: 'wiki/guides/workflows',
              source: 'wiki',
              children: [
                {
                  type: 'file',
                  name: 'manual-operations.md',
                  path: 'wiki/guides/workflows/manual-operations.md',
                  source: 'wiki',
                },
              ],
            },
          ],
        },
      ],
    },
  ],
};

function SelectableExplorer() {
  const [selected, setSelected] = useState(null);
  return <DocsExplorer tree={tree} selected={selected} onSelect={setSelected} />;
}

describe('DocsExplorer', () => {
  test('expands a nested folder and exposes the selected document to the DOM', async () => {
    const user = userEvent.setup();
    render(<SelectableExplorer />);

    const folder = screen.getByRole('button', { name: 'workflows' });
    expect(folder).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('button', { name: 'manual-operations.md' })).not.toBeInTheDocument();

    await user.click(folder);
    expect(folder).toHaveAttribute('aria-expanded', 'true');

    const file = screen.getByRole('button', { name: 'manual-operations.md' });
    await user.click(file);
    expect(file).toHaveAttribute('aria-current', 'page');
  });
});
