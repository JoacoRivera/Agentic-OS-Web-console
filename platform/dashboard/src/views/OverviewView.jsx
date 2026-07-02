import Hero from '../components/Hero.jsx';
import StatCards from '../components/StatCards.jsx';
import GrowthChart from '../components/GrowthChart.jsx';
import HealthPanel from '../components/HealthPanel.jsx';
import WeekBars from '../components/WeekBars.jsx';
import RecentActivity from '../components/RecentActivity.jsx';
import RepoHealth from '../components/RepoHealth.jsx';

/**
 * Overview: the headline dashboard, live from /api/metrics. Raw and wiki
 * are shown as independent stores — no raw→wiki funnel (ADR-0003).
 */
export default function OverviewView({ status, metrics, metricsError }) {
  return (
    <>
      <Hero status={status} metrics={metrics} />
      {metrics ? (
        <>
          <StatCards metrics={metrics} />
          <GrowthChart metrics={metrics} />
          <div className="grid-2">
            <HealthPanel metrics={metrics} />
            <WeekBars metrics={metrics} />
          </div>
          <div className="grid-2">
            <RecentActivity metrics={metrics} />
            <RepoHealth metrics={metrics} />
          </div>
        </>
      ) : (
        <div className="panel">
          <div className="label">Metrics</div>
          <div className="placeholder-body">
            {metricsError ? `Metrics unavailable — ${metricsError}` : 'Loading live metrics…'}
          </div>
        </div>
      )}
    </>
  );
}
