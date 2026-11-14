import { render, screen } from '@testing-library/react';
import { describe, expect, test } from 'vitest';
import WorkflowRegistry from './WorkflowRegistry.jsx';
import WorkflowDetail, { ageText } from './WorkflowDetail.jsx';

const row = (overrides = {}) => ({
  name: 'sample',
  path: 'wiki/workflows/sample.md',
  title: 'Sample',
  kind: 'policy',
  kindDeclared: 'policy',
  requiresVerification: false,
  requiresRunbookShape: false,
  checksExempt: [],
  updated: '2026-09-20',
  ageDays: 55,
  status: 'ok',
  statusLabel: 'OK',
  failingRequired: 0,
  checks: [],
  ...overrides,
});

describe('WorkflowRegistry', () => {
  test('the Updated column shows the frontmatter updated: day, and a dash when it is null', () => {
    const data = {
      workflows: [
        row(),
        row({ name: 'broken', path: 'wiki/workflows/broken.md', updated: null, ageDays: null, status: 'needs-review', statusLabel: 'Needs review', failingRequired: 1 }),
      ],
      summary: { total: 2, ok: 1, 'needs-review': 1 },
    };
    const { container } = render(<WorkflowRegistry data={data} selected={null} onSelect={() => {}} />);
    const cells = [...container.querySelectorAll('td.wf-updated')].map((td) => td.textContent);
    // Rows sort by status precedence: needs-review before ok.
    expect(cells).toEqual(['—', '2026-09-20']);
  });
});

describe('WorkflowDetail', () => {
  test('shows the updated: day with its age', () => {
    render(<WorkflowDetail workflow={{ ...row(), relatedFiles: [], absolutePath: '/x' }} onBack={() => {}} onOpenDoc={() => {}} />);
    expect(screen.getByText('2026-09-20')).toBeInTheDocument();
    expect(screen.getByText(/55 days ago/)).toBeInTheDocument();
  });

  test('a missing updated: reads as absent, with no age', () => {
    render(
      <WorkflowDetail
        workflow={{ ...row({ updated: null, ageDays: null }), relatedFiles: [], absolutePath: '/x' }}
        onBack={() => {}}
        onOpenDoc={() => {}}
      />
    );
    expect(screen.getByText(/no valid updated: frontmatter/)).toBeInTheDocument();
    expect(screen.queryByText(/days? ago/)).not.toBeInTheDocument();
  });

  test('ageText words whole days', () => {
    expect(ageText(0)).toBe('today');
    expect(ageText(1)).toBe('1 day ago');
    expect(ageText(91)).toBe('91 days ago');
    expect(ageText(-3)).toBe('in the future');
  });
});
