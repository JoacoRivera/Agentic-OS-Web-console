import { render, screen } from '@testing-library/react';
import { describe, expect, test } from 'vitest';
import GrowthChart from './GrowthChart.jsx';

// jsdom reports clientWidth 0, so the chart falls back to its nominal width.
const MEASURED_W = 1000;
const PLOT_W = MEASURED_W - 12;

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
      const x = (index / (series.length - 1)) * PLOT_W;
      const y = 14 + (1 - v / 28) * 156;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    });
    expect(container.querySelector('polyline').getAttribute('points')).toBe(
      expectedPoints.join(' ')
    );

    const markers = [...container.querySelectorAll('circle')];
    expect(markers).toHaveLength(2);
    for (const marker of markers) {
      expect(Number(marker.getAttribute('cx'))).toBe(PLOT_W);
      expect(Number(marker.getAttribute('cy'))).toBe(14);
    }
  });

  test('draws in a 1:1 user space so the endpoint marker stays a circle', () => {
    const { container } = render(<GrowthChart metrics={metrics()} />);
    const chart = container.querySelector('svg.growth');

    // A stretched viewBox (preserveAspectRatio="none") scales x and y by
    // different factors, which renders the endpoint marker as an ellipse.
    expect(chart).not.toHaveAttribute('preserveAspectRatio');
    expect(chart.getAttribute('viewBox')).toBe(`0 0 ${MEASURED_W} 180`);
  });

  test('places date ticks on their sample position, not evenly spaced', () => {
    const { container } = render(<GrowthChart metrics={metrics()} />);

    const ticks = [...container.querySelectorAll('.axis span')];
    const tickX = ticks.map((t) => Number.parseFloat(t.style.left));
    expect(ticks).toHaveLength(5);
    expect(tickX).toEqual([0, 7, 14, 21, 29].map((i) => Number(((i / 29) * PLOT_W).toFixed(1))));

    // Every interior tick sits on a vertical grid rule.
    const rules = [...container.querySelectorAll('line')].filter(
      (line) => line.getAttribute('x1') === line.getAttribute('x2')
    );
    expect(rules.map((line) => Number(line.getAttribute('x1')))).toEqual(tickX.slice(1, -1));
  });
});
