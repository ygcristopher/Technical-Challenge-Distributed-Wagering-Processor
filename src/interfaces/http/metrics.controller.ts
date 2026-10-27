import { Controller, Get, Header } from '@nestjs/common';
import { MetricsRegistry } from '../../observability/metrics.registry.js';

@Controller()
export class MetricsController {
  constructor(private readonly metrics: MetricsRegistry) {}

  @Get('metrics')
  @Header('Content-Type', 'text/plain; version=0.0.4')
  getMetrics(): string {
    return this.metrics.renderPrometheus();
  }
}
