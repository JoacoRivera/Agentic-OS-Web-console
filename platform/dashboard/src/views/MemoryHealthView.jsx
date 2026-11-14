import HealthPanel from '../components/HealthPanel.jsx';
import MemoryFlow from '../components/MemoryFlow.jsx';
import RepoHealth from '../components/RepoHealth.jsx';
import SincePassCaptures from '../components/SincePassCaptures.jsx';
import WikiStructurePanel from '../components/WikiStructurePanel.jsx';

/**
 * Maintenance section: first the last deterministic wiki structure check with
 * its run card — step 1 of the maintenance pass, so it leads the view
 * (rendered whether or not metrics loaded — it reads its own endpoint); then
 * the maintenance-pass cadence, the console self-check card and the captures
 * ingested since that pass, then memory-flow stats.
 */
export default function MemoryHealthView({ metrics, metricsError }) {
  return (
    <>
      <WikiStructurePanel />
      {metrics ? (
        <>
          <div className="grid-2">
            <HealthPanel metrics={metrics} />
            <RepoHealth metrics={metrics} />
            <SincePassCaptures metrics={metrics} />
          </div>
          <MemoryFlow metrics={metrics} />
        </>
      ) : (
        <div className="panel">
          <div className="label">Maintenance pass</div>
          <div className="placeholder-body">
            {metricsError ? `Metrics unavailable — ${metricsError}` : 'Loading live metrics…'}
          </div>
        </div>
      )}
    </>
  );
}
