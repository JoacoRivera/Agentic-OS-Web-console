import ReviewQueue from '../components/ReviewQueue.jsx';

export default function ReviewQueueView({ metrics, metricsError }) {
  if (!metrics) {
    return (
      <div className="panel">
        <div className="label">Review queue</div>
        <div className="placeholder-body">
          {metricsError ? `Metrics unavailable — ${metricsError}` : 'Loading live metrics…'}
        </div>
      </div>
    );
  }
  return <ReviewQueue metrics={metrics} />;
}
