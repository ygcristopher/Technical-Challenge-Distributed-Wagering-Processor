import { Injectable } from '@nestjs/common';

export type MetricLabels = Readonly<Record<string, string | number | boolean | undefined>>;

interface MetricValue {
  value: number;
  labels: Record<string, string>;
}

@Injectable()
export class MetricsRegistry {
  private readonly counters = new Map<string, MetricValue>();
  private readonly gauges = new Map<string, MetricValue>();
  private readonly histograms = new Map<string, { count: number; sum: number; labels: Record<string, string> }>();

  increment(name: string, amount = 1, labels: MetricLabels = {}): void {
    const key = this.key(name, labels);
    const current = this.counters.get(key);
    if (current) {
      current.value += amount;
      return;
    }
    this.counters.set(key, { value: amount, labels: this.normalizeLabels(labels) });
  }

  setGauge(name: string, value: number, labels: MetricLabels = {}): void {
    this.gauges.set(this.key(name, labels), { value, labels: this.normalizeLabels(labels) });
  }

  observe(name: string, value: number, labels: MetricLabels = {}): void {
    const key = this.key(name, labels);
    const current = this.histograms.get(key);
    if (current) {
      current.count += 1;
      current.sum += value;
      return;
    }
    this.histograms.set(key, { count: 1, sum: value, labels: this.normalizeLabels(labels) });
  }

  snapshot(): { counters: Record<string, number>; gauges: Record<string, number>; histograms: Record<string, { count: number; sum: number }> } {
    return {
      counters: this.snapshotValues(this.counters),
      gauges: this.snapshotValues(this.gauges),
      histograms: Object.fromEntries([...this.histograms.entries()].map(([key, value]) => [key, {
        count: value.count,
        sum: value.sum,
      }])),
    };
  }

  renderPrometheus(): string {
    const lines: string[] = [];
    for (const [key, metric] of this.counters) {
      lines.push(`${key} ${metric.value}`);
    }
    for (const [key, metric] of this.gauges) {
      lines.push(`${key} ${metric.value}`);
    }
    for (const [key, metric] of this.histograms) {
      lines.push(`${key}_count ${metric.count}`);
      lines.push(`${key}_sum ${metric.sum}`);
    }
    return `${lines.join('\n')}\n`;
  }

  private key(name: string, labels: MetricLabels): string {
    const normalized = this.normalizeLabels(labels);
    const labelText = Object.entries(normalized)
      .map(([key, value]) => `${key}="${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"') }"`)
      .join(',');
    return labelText ? `${name}{${labelText}}` : name;
  }

  private normalizeLabels(labels: MetricLabels): Record<string, string> {
    return Object.fromEntries(
      Object.entries(labels)
        .filter((entry): entry is [string, string | number | boolean] => entry[1] !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, value]) => [key, String(value)]),
    );
  }

  private snapshotValues(values: Map<string, MetricValue>): Record<string, number> {
    return Object.fromEntries([...values.entries()].map(([key, value]) => [key, value.value]));
  }
}
