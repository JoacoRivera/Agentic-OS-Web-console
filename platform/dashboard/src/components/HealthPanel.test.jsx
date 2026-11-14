import { render, screen } from '@testing-library/react';
import { describe, expect, test } from 'vitest';
import HealthPanel from './HealthPanel.jsx';

const health = (overrides = {}) => ({
  lastPass: '2026-11-12',
  passAge: 2,
  healthStale: false,
  overdue: false,
  ageLabel: '2 DAYS AGO',
  staleDays: 7,
  overdueDays: 10,
  ingestedSincePass: 0,
  ...overrides,
});

describe('HealthPanel', () => {
  test('renders without reviewBy (older payloads)', () => {
    render(<HealthPanel metrics={{ health: health() }} />);
    expect(screen.getByText(/Last pass/)).toBeInTheDocument();
    expect(screen.queryByText(/Review-by dates/)).not.toBeInTheDocument();
  });

  test('nothing due: shows the count and the next due day', () => {
    const reviewBy = { dueN: 0, malformedN: 0, pendingN: 13, nextDue: '2027-05-07', items: [] };
    render(<HealthPanel metrics={{ health: health({ reviewBy }) }} />);
    expect(screen.getByText(/Review-by dates/)).toBeInTheDocument();
    expect(screen.getByText('· 0 due')).toBeInTheDocument();
    expect(screen.getByText('next due 2027-05-07')).toBeInTheDocument();
    expect(screen.queryByText(/malformed/)).not.toBeInTheDocument();
  });

  test('due and malformed dates are listed, and the cadence chip stays ok', () => {
    const reviewBy = {
      dueN: 1,
      malformedN: 1,
      pendingN: 0,
      nextDue: null,
      items: [
        { path: 'wiki/lessons.md', line: 6, date: '2026-01-31', state: 'due' },
        { path: 'wiki/lessons.md', line: 8, date: 'soon', state: 'malformed' },
      ],
    };
    const { container } = render(<HealthPanel metrics={{ health: health({ reviewBy }) }} />);
    expect(screen.getByText('· 1 due')).toBeInTheDocument();
    expect(screen.getByText('· 1 malformed')).toBeInTheDocument();
    expect(screen.getByText('wiki/lessons.md:6')).toBeInTheDocument();
    expect(screen.getByText('wiki/lessons.md:8')).toBeInTheDocument();
    expect(container.querySelectorAll('.review-by-item')).toHaveLength(2);
    expect(container.querySelector('.chip').className).toContain('ok');
  });
});
