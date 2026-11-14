import HealthPanel from '../components/HealthPanel.jsx';
import RepoHealth from '../components/RepoHealth.jsx';
import SincePassCaptures from '../components/SincePassCaptures.jsx';

/** Maintenance section: the maintenance-pass cadence + the console self-check card. */
export default function MemoryHealthView({ metrics, metricsError }) {
  if (!metrics) {
    return (
      <div className="panel">
        <div className="label">Maintenance pass</div>
        <div className="placeholder-body">
          {metricsError ? `Metrics unavailable — ${metricsError}` : 'Loading live metrics…'}
        </div>
      </div>
    );
  }
  return (
    <div className="grid-2">
      <HealthPanel metrics={metrics} />
      <RepoHealth metrics={metrics} />
      <SincePassCaptures metrics={metrics} />
    </div>
  );
}
