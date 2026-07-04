import HealthPanel from '../components/HealthPanel.jsx';
import RepoHealth from '../components/RepoHealth.jsx';

/** Memory Health section: lint cadence + the console self-check card. */
export default function MemoryHealthView({ metrics, metricsError }) {
  if (!metrics) {
    return (
      <div className="panel">
        <div className="label">Memory health</div>
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
    </div>
  );
}
