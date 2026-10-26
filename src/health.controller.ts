import { Controller, Get, HttpException, HttpStatus } from '@nestjs/common';
import { HealthService } from './health.service.js';

@Controller('health')
export class HealthController {
  constructor(private readonly healthService: HealthService) {}

  @Get('live')
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  @Get('ready')
  async ready(): Promise<{ status: 'ok'; dependencies: { postgres: boolean; sqs: boolean } }> {
    const dependencies = await this.healthService.checkDependencies();
    if (!dependencies.postgres || !dependencies.sqs) {
      throw new HttpException(
        { status: 'unavailable', dependencies },
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }

    return { status: 'ok', dependencies };
  }
}
