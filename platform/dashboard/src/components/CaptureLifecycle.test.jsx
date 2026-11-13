import { render, screen } from '@testing-library/react';
import { describe, expect, test } from 'vitest';
import HealthPanel from './HealthPanel.jsx';
import ReviewQueue from './ReviewQueue.jsx';

// Memory repo ADR-0002: Draft / Ingested (legacy Approved), holds, and the
// weekly maintenance pass. Synthetic paths only.
function metrics(overrides = {}) {
  return {
    draftN: 1,
    heldN: 1,
    ingestedN: 12,
    drafts: [{ name: 'cap-a', path: 'raw/p/examples/cap-a.md', mtime: '2026-11-12T10:00:00Z' }],
    held: [
      { name: 'cap-h', path: 'raw/p/examples/cap-h.md', mtime: '2026-11-10T10:00:00Z', reason: 'owner decision' },
    ],
    captures: { legacyApprovedN: 4, mismatchN: 0, layoutWarningN: 0, holdWarningN: 0 },
    health: {
      lastPass: '2026-11-01',
      passAge: 12,
      healthStale: true,
      overdue: true,
      ageLabel: '12 DAYS AGO',
      staleDays: 7,
      overdueDays: 10,
      ingestedSincePass: 5,
    },
    ...overrides,
  };
}

describe('ReviewQueue (ingest queue)', () => {
  test('lists Drafts and holds apart, with no approval or triage framing', () => {
    render(<ReviewQueue metrics={metrics()} />);
    expect(screen.getByText('Ingest queue')).toBeInTheDocument();
    expect(screen.getByText(/1 Draft waiting · 1 on hold · 12 ingested/)).toBeInTheDocument();
    expect(screen.getByText('cap-a')).toBeInTheDocument();
    expect(screen.getByText('On hold')).toBeInTheDocument();
    expect(screen.getByText('cap-h')).toBeInTheDocument();
    expect(screen.queryByText(/unapproved|awaiting review|triage queue/i)).not.toBeInTheDocument();
  });

  test('surfaces inventory warnings as counts and points at /aos-reconcile', () => {
    render(
      <ReviewQueue
        metrics={metrics({ captures: { legacyApprovedN: 0, mismatchN: 2, layoutWarningN: 0, holdWarningN: 1 } })}
      />
    );
    expect(screen.getByText(/2 status mismatch\(es\).*1 hold-list warning/)).toBeInTheDocument();
    expect(screen.getByText('/aos-reconcile')).toBeInTheDocument();
  });
});

describe('HealthPanel (maintenance pass)', () => {
  test('an overdue pass names the live skill and the resetting log subject', () => {
    render(<HealthPanel metrics={metrics()} />);
    expect(screen.getByText('OVERDUE')).toBeInTheDocument();
    expect(screen.getByText('/aos-wiki-lint')).toBeInTheDocument();
    expect(screen.getByText('lint | maintenance pass')).toBeInTheDocument();
    expect(screen.getByText('5')).toBeInTheDocument(); // ingested since the last pass
    expect(screen.queryByText(/promote-draft-memory/)).not.toBeInTheDocument();
  });

  test('no pass on record reads as due, without an age', () => {
    const health = { ...metrics().health, lastPass: null, passAge: null, ageLabel: 'NEVER', ingestedSincePass: null };
    render(<HealthPanel metrics={metrics({ health })} />);
    expect(screen.getByText(/No maintenance pass on record/)).toBeInTheDocument();
    expect(screen.queryByText(/Ingested since the last pass/)).not.toBeInTheDocument();
  });
});
