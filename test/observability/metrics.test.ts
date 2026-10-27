import { describe, expect, test } from 'bun:test';
import { MetricsRegistry } from '../../src/observability/metrics.registry.js';

describe('MetricsRegistry', () => {
  test('aggregates labeled counters, gauges and latency observations', () => {
    const metrics = new MetricsRegistry();

    metrics.increment('wager_transactions_total', 1, { status: 'PROCESSED', source: 'http' });
    metrics.increment('wager_transactions_total', 2, { source: 'http', status: 'PROCESSED' });
    metrics.setGauge('outbox_lag_seconds', 1.25);
    metrics.observe('wager_transaction_latency_ms', 10, { source: 'http' });
    metrics.observe('wager_transaction_latency_ms', 20, { source: 'http' });

    expect(metrics.snapshot()).toEqual({
      counters: { 'wager_transactions_total{source="http",status="PROCESSED"}': 3 },
      gauges: { outbox_lag_seconds: 1.25 },
      histograms: {
        'wager_transaction_latency_ms{source="http"}': { count: 2, sum: 30 },
      },
    });
    expect(metrics.renderPrometheus()).toContain('wager_transactions_total{source="http",status="PROCESSED"} 3');
    expect(metrics.renderPrometheus()).toContain('wager_transaction_latency_ms{source="http"}_count 2');
  });
});
