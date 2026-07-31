import { render, screen } from '@testing-library/react';
import { describe, expect, test } from 'vitest';
import GrowthChart from './GrowthChart.jsx';

const series = Array.from({ length: 30 }, (_, index) => ({
  d: `2026-07-${String(index + 1).padStart(2, '0')}`,
  v: index < 28 ? index : 28,
}));

function metrics(overrides = {}) {
  return {
    series,
    knowledgeN: 28,
    last30: 7,
    lineage: {
      eligibleN: 32,
      lineagedN: 30,
      unlineagedN: 1,
      invalidN: 1,
    },
    ...overrides,
  };
}

describe('GrowthChart', () => {
  test('presents incomplete lineage as known coverage rather than a total', () => {
    render(<GrowthChart metrics={metrics()} />);

    expect(screen.getByText(/28 known distinct sources/i)).toBeInTheDocument();
    expect(screen.getByText(/30\/32 files lineaged/i)).toBeInTheDocument();
    expect(screen.getByText(/lineage incomplete · 2 files excluded/i)).toBeInTheDocument();
    expect(screen.queryByText(/total/i)).not.toBeInTheDocument();
  });

  test('renders complete coverage and keeps the full knowledge series endpoint visible', () => {
    const { container } = render(
      <GrowthChart
        metrics={metrics({
          lineage: {
            eligibleN: 30,
            lineagedN: 30,
            unlineagedN: 0,
            invalidN: 0,
          },
        })}
      />
    );

    expect(screen.getByText(/28 distinct sources/i)).toBeInTheDocument();
    expect(screen.getByText(/lineage complete · all eligible files included/i)).toBeInTheDocument();

    const chart = screen.getByRole('img', {
      name: /knowledge intake series.*rising from 0 to 28 distinct sources/i,
    });
    expect(chart).toHaveAttribute('overflow', 'visible');

    const expectedPoints = series.map(({ v }, index) => {
      const x = (index / (series.length - 1)) * 1000;
      const y = 14 + (1 - v / 28) * 196;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    });
    expect(container.querySelector('polyline').getAttribute('points')).toBe(
      expectedPoints.join(' ')
    );

    const markers = [...container.querySelectorAll('circle')];
    expect(markers).toHaveLength(2);
    for (const marker of markers) {
      expect(Number(marker.getAttribute('cx'))).toBe(1000);
      expect(Number(marker.getAttribute('cy'))).toBe(14);
    }
  });
});
