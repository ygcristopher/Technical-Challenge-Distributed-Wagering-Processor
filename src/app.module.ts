import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { HealthController } from './health.controller.js';
import { HealthService } from './health.service.js';
import { NoopAuthGuard } from './auth/noop-auth.guard.js';

@Module({
  controllers: [HealthController],
  providers: [
    HealthService,
    { provide: APP_GUARD, useClass: NoopAuthGuard },
  ],
})
export class AppModule {}
