import { render, screen } from '@testing-library/react';
import { describe, expect, test } from 'vitest';
import MemoryFlow from './MemoryFlow.jsx';

// Synthetic /api/metrics.flow (ADR-0003 amendment 2026-11-14).
const none = { n: 0, min: null, median: null, p90: null, max: null };
function flow(overrides = {}) {
  return {
    today: '2026-11-14',
    captures: { total: 12, unlineaged: 3 },
    months: [
      { month: '2026-10', captures: 4, ingestEntries: 6 },
      { month: '2026-11', captures: 5, ingestEntries: 2 },
    ],
    latency: {
      n: 7, min: 0, median: 1.5, p90: 9, max: 12,
      buckets: [
        { label: 'same day', count: 3 },
        { label: '1-3d', count: 2 },
        { label: '4-7d', count: 0 },
        { label: '8-30d', count: 2 },
        { label: '>30d', count: 0 },
      ],
      noDatedIngestEntry: 2,
      ingestBeforeIntake: 0,
    },
    passes: {
      days: 3,
      newest: '2026-11-13',
      openGapDays: 1,
      gaps: { n: 2, min: 5, median: 7, p90: 9, max: 9 },
      gapsOverCadence: 1,
      cadenceDays: 7,
      longestGap: { from: '2026-10-30', to: '2026-11-08', days: 9 },
    },
    queue: {
      draft: { count: 2, unlineaged: 0, ages: { n: 2, min: 1, median: 2, p90: 3, max: 3 } },
      onHold: { count: 0, unlineaged: 0, ages: none },
    },
    ...overrides,
  };
}

describe('MemoryFlow (Maintenance section)', () => {
  test('renders the four groups from flow', () => {
    render(<MemoryFlow metrics={{ flow: flow() }} />);
    expect(screen.getByText('Capture → ingest latency')).toBeInTheDocument();
    expect(screen.getByText('1.5d · 9d · 12d')).toBeInTheDocument();
    expect(screen.getByText('Maintenance-pass gaps')).toBeInTheDocument();
    expect(screen.getByText('9d')).toBeInTheDocument(); // longest gap
    expect(screen.getByText('Ingest queue age')).toBeInTheDocument();
    expect(screen.getByText('oldest 3d · median 2d')).toBeInTheDocument();
    expect(screen.getByText('By month')).toBeInTheDocument();
    const rows = screen.getAllByRole('row').slice(1).map((r) => r.textContent);
    expect(rows).toEqual(['2026-1152', '2026-1046']); // newest first
    expect(screen.getByText(/2 Ingested with no dated ingest log entry/)).toBeInTheDocument();
    expect(screen.queryByText(/backlog/i)).not.toBeInTheDocument();
  });

  test('a non-zero gapsOverCadence shows the warn chip', () => {
    const { container } = render(<MemoryFlow metrics={{ flow: flow() }} />);
    expect(container.querySelector('.chip.warn')).toHaveTextContent('1 over 7d');
  });

  test('empty states render their reason, never 0d', () => {
    const { container } = render(
      <MemoryFlow
        metrics={{
          flow: flow({
            captures: { total: 2, unlineaged: 0 },
            months: [],
            latency: { ...none, buckets: [], noDatedIngestEntry: 0, ingestBeforeIntake: 0 },
            passes: { days: 0, newest: null, openGapDays: null, gaps: none, gapsOverCadence: 0, cadenceDays: 7, longestGap: null },
            queue: {
              draft: { count: 2, unlineaged: 2, ages: none },
              onHold: { count: 0, unlineaged: 0, ages: none },
            },
          }),
        }}
      />
    );
    expect(screen.getByText('No latency data')).toBeInTheDocument();
    expect(screen.getByText('No maintenance pass on record')).toBeInTheDocument();
    expect(screen.getByText('no intake date — age unknown')).toBeInTheDocument();
    expect(screen.getByText('empty')).toBeInTheDocument();
    expect(screen.getByText('No dated captures or ingest entries')).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/\b0d\b|nulld|NaN/);
    expect(container.querySelector('.chip')).toBeNull();
  });

  test('no latency with dated ingest entries present does not claim there are none', () => {
    render(
      <MemoryFlow
        metrics={{
          flow: flow({
            // Ingest entries exist (By month), but the only Ingested capture was
            // ingested before its intake date.
            latency: {
              ...none,
              buckets: [],
              noDatedIngestEntry: 0,
              ingestBeforeIntake: 1,
            },
          }),
        }}
      />
    );
    expect(screen.getByText('No latency data')).toBeInTheDocument();
    expect(screen.queryByText(/no dated ingest entries/i)).not.toBeInTheDocument();
    expect(screen.getByText(/1 with an ingest entry dated before the knowledge intake/)).toBeInTheDocument();
    expect(screen.getAllByRole('row').length).toBeGreaterThan(1); // By month lists the entries
  });

  test('one pass on record has no gap yet', () => {
    render(
      <MemoryFlow
        metrics={{
          flow: flow({
            passes: { days: 1, newest: '2026-11-10', openGapDays: 4, gaps: none, gapsOverCadence: 0, cadenceDays: 7, longestGap: null },
          }),
        }}
      />
    );
    expect(screen.getByText('One pass on record — no gap yet')).toBeInTheDocument();
    expect(screen.getByText('4d')).toBeInTheDocument();
  });

  test('the unlineaged note appears only when there are unlineaged captures', () => {
    const { rerender } = render(<MemoryFlow metrics={{ flow: flow() }} />);
    expect(screen.getByText(/3 captures have no valid lineage/)).toBeInTheDocument();
    rerender(<MemoryFlow metrics={{ flow: flow({ captures: { total: 12, unlineaged: 0 } }) }} />);
    expect(screen.queryByText(/have no valid lineage/)).not.toBeInTheDocument();
  });

  test('renders nothing when the server sends no flow block', () => {
    const { container } = render(<MemoryFlow metrics={{}} />);
    expect(container).toBeEmptyDOMElement();
  });
});
