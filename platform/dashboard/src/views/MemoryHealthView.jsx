import HealthPanel from '../components/HealthPanel.jsx';
import MemoryFlow from '../components/MemoryFlow.jsx';
import RepoHealth from '../components/RepoHealth.jsx';
import SincePassCaptures from '../components/SincePassCaptures.jsx';

/**
 * Maintenance section: the maintenance-pass cadence, the console self-check
 * card and the captures ingested since that pass, then memory-flow stats.
 */
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
    <>
      <div className="grid-2">
        <HealthPanel metrics={metrics} />
        <RepoHealth metrics={metrics} />
        <SincePassCaptures metrics={metrics} />
      </div>
      <MemoryFlow metrics={metrics} />
    </>
  );
}
