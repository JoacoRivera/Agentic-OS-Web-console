import GrowthChart from '../components/GrowthChart.jsx';
import WeekBars from '../components/WeekBars.jsx';
import RecentActivity from '../components/RecentActivity.jsx';

/** Activity section: 30-day knowledge intake, 7-day edit bars, most recent files. */
export default function ActivityView({ metrics, metricsError }) {
  if (!metrics) {
    return (
      <div className="panel">
        <div className="label">Activity</div>
        <div className="placeholder-body">
          {metricsError ? `Metrics unavailable — ${metricsError}` : 'Loading live metrics…'}
        </div>
      </div>
    );
  }
  return (
    <>
      <GrowthChart metrics={metrics} />
      <div className="grid-2">
        <WeekBars metrics={metrics} />
        <RecentActivity metrics={metrics} />
      </div>
    </>
  );
}
