import HealthPanel from '../components/HealthPanel.jsx';
import RepoHealth from '../components/RepoHealth.jsx';
import WikiStructurePanel from '../components/WikiStructurePanel.jsx';

/**
 * Maintenance section: the maintenance-pass cadence + the console self-check
 * card, then the last deterministic wiki structure check (rendered whether
 * or not metrics loaded — it reads its own endpoint).
 */
export default function MemoryHealthView({ metrics, metricsError }) {
  return (
    <>
      {metrics ? (
        <div className="grid-2">
          <HealthPanel metrics={metrics} />
          <RepoHealth metrics={metrics} />
        </div>
      ) : (
        <div className="panel">
          <div className="label">Maintenance pass</div>
          <div className="placeholder-body">
            {metricsError ? `Metrics unavailable — ${metricsError}` : 'Loading live metrics…'}
          </div>
        </div>
      )}
      <WikiStructurePanel />
    </>
  );
}
