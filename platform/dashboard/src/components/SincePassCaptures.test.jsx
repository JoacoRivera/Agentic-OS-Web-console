import { render, screen } from '@testing-library/react';
import { describe, expect, test } from 'vitest';
import SincePassCaptures from './SincePassCaptures.jsx';

// health.sincePass by capture origin (memory repo ADR-0003). Synthetic paths only.
const bridgeItem = { name: 'cap-bridge', path: 'raw/p/examples/cap-bridge.md', origin: 'bridge', ingestedOn: '2026-11-11' };
const otherItem = { name: 'cap-other', path: 'raw/p/examples/cap-other.md', origin: 'other', ingestedOn: '2026-11-12' };

function metrics(sincePass) {
  return { health: { lastPass: '2026-11-09', ingestedSincePass: sincePass ? sincePass.items.length : null, sincePass } };
}

describe('SincePassCaptures', () => {
  test('groups bridge and other captures under their origin labels', () => {
    render(
      <SincePassCaptures
        metrics={metrics({ byOrigin: { bridge: 1, other: 1 }, items: [bridgeItem, otherItem], truncated: false })}
      />
    );
    expect(screen.getByText(/Ingested since the last pass · by origin/)).toBeInTheDocument();
    expect(screen.getByText(/Memory Bridge \(1\)/)).toBeInTheDocument();
    expect(screen.getByText(/no user confirmed the result/)).toBeInTheDocument();
    expect(screen.getByText(/Other captures \(1\)/)).toBeInTheDocument();
    expect(screen.getByText('cap-bridge')).toBeInTheDocument();
    expect(screen.getByText('cap-other')).toBeInTheDocument();
    expect(screen.queryByText(/None from the Memory Bridge/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Showing/)).not.toBeInTheDocument();
    expect(screen.queryByText(/unapproved|awaiting review|triage queue|user-approved/i)).not.toBeInTheDocument();
  });

  test('no bridge captures → one dim line and no bridge rows', () => {
    render(
      <SincePassCaptures metrics={metrics({ byOrigin: { bridge: 0, other: 1 }, items: [otherItem], truncated: false })} />
    );
    expect(screen.getByText('None from the Memory Bridge since the last pass')).toBeInTheDocument();
    expect(screen.queryByText('cap-bridge')).not.toBeInTheDocument();
    expect(screen.getByText('cap-other')).toBeInTheDocument();
  });

  test('no other captures → the Other group is omitted', () => {
    render(
      <SincePassCaptures metrics={metrics({ byOrigin: { bridge: 1, other: 0 }, items: [bridgeItem], truncated: false })} />
    );
    expect(screen.queryByText(/Other captures/)).not.toBeInTheDocument();
  });

  test('a truncated list says how many rows it shows', () => {
    render(
      <SincePassCaptures metrics={metrics({ byOrigin: { bridge: 1, other: 3 }, items: [bridgeItem], truncated: true })} />
    );
    expect(screen.getByText('Showing 1 of 4')).toBeInTheDocument();
  });

  test('renders nothing when no pass is on record or the server sends no list', () => {
    const { container: none } = render(<SincePassCaptures metrics={metrics(null)} />);
    expect(none).toBeEmptyDOMElement();
    const { container: older } = render(<SincePassCaptures metrics={{ health: { lastPass: '2026-11-09' } }} />);
    expect(older).toBeEmptyDOMElement();
  });
});
