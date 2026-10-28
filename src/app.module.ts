import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { MikroORM } from '@mikro-orm/postgresql';
import { HealthController } from './health.controller.js';
import { HealthService } from './health.service.js';
import { NoopAuthGuard } from './auth/noop-auth.guard.js';
import databaseConfig from './infrastructure/database/mikro-orm.config.js';
import { UnitOfWork } from './infrastructure/database/unit-of-work.js';
import { ProcessWagerTransactionUseCase } from './application/wagering/process-wager-transaction.use-case.js';
import { WalletApplicationService } from './application/wallets/wallet.application-service.js';
import { WalletController } from './interfaces/http/wallet.controller.js';
import { WageringController } from './interfaces/http/wagering.controller.js';
import { OUTBOX_EVENT_PUBLISHER, OutboxPublisher } from './application/messaging/outbox.publisher.js';
import { SqsEventPublisher } from './infrastructure/messaging/sqs-event-publisher.js';
import { SqsTransactionConsumer } from './infrastructure/messaging/sqs-transaction.consumer.js';
import { MetricsRegistry } from './observability/metrics.registry.js';
import { JsonLogger } from './observability/json.logger.js';
import { MetricsController } from './interfaces/http/metrics.controller.js';
import { TransactionQueryController } from './interfaces/http/transaction-query.controller.js';
import { PendingReferenceWorker } from './application/wagering/pending-reference.worker.js';

@Module({
  imports: [MikroOrmModule.forRoot(databaseConfig)],
  controllers: [HealthController, WalletController, WageringController, MetricsController, TransactionQueryController],
  providers: [
    HealthService,
    MetricsRegistry,
    JsonLogger,
    {
      provide: UnitOfWork,
      useFactory: (orm: MikroORM) => new UnitOfWork(orm),
      inject: [MikroORM],
    },
    ProcessWagerTransactionUseCase,
    WalletApplicationService,
    SqsEventPublisher,
    { provide: OUTBOX_EVENT_PUBLISHER, useExisting: SqsEventPublisher },
    OutboxPublisher,
    SqsTransactionConsumer,
    PendingReferenceWorker,
    { provide: APP_GUARD, useClass: NoopAuthGuard },
  ],
})
export class AppModule {}
