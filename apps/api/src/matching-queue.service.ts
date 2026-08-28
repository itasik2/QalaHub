import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';

@Injectable()
export class MatchingQueueService implements OnModuleDestroy {
  private readonly connection = new Redis(
    process.env.REDIS_URL ?? 'redis://localhost:6379',
    { maxRetriesPerRequest: null },
  );

  readonly queue = new Queue('matching', { connection: this.connection });

  async ping() {
    return this.connection.ping();
  }

  async start(requestId: string) {
    return this.queue.add(
      'start',
      { requestId },
      {
        jobId: `${requestId}-start`,
        removeOnComplete: 1000,
        removeOnFail: 5000,
      },
    );
  }

  async reconcile(requestId: string) {
    return this.queue.add(
      'reconcile',
      { requestId },
      {
        jobId: `${requestId}-reconcile-${Date.now()}`,
        removeOnComplete: 1000,
        removeOnFail: 5000,
      },
    );
  }

  async onModuleDestroy() {
    await this.queue.close();
    await this.connection.quit();
  }
}
