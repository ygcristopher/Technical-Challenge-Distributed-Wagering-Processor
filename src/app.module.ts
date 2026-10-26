import { Module } from '@nestjs/common';
import { HealthController } from './health.controller.js';
import { HealthService } from './health.service.js';
import { NoopAuthGuard } from './auth/noop-auth.guard.js';

@Module({
  controllers: [HealthController],
  providers: [HealthService, NoopAuthGuard],
})
export class AppModule {}
