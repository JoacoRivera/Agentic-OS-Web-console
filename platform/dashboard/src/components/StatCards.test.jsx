import { render, screen } from '@testing-library/react';
import { describe, expect, test } from 'vitest';
import StatCards from './StatCards.jsx';

function metrics(overrides = {}) {
  return {
    wikiN: 42,
    rawN: 17,
    examples: 3,
    rawProj: 5,
    rawFlow: 2,
    weekTotal: 9,
    activeDays: 4,
    trend: 'ACTIVE',
    ...overrides,
  };
}

describe('StatCards', () => {
  test('renders only real values, with no synthetic slash-cap gauge and no edit wording', () => {
    render(<StatCards metrics={metrics()} />);

    expect(screen.getByText('42')).toBeInTheDocument();
    expect(screen.getByText('17')).toBeInTheDocument();
    expect(screen.getByText('9')).toBeInTheDocument();

    expect(screen.queryByText(/\/\s*\d+/)).not.toBeInTheDocument();
    expect(screen.queryByText(/edits/i)).not.toBeInTheDocument();
    expect(screen.getByText(/changed files/i)).toBeInTheDocument();
  });
});
