import { Body, Controller, OnModuleDestroy, Post } from '@nestjs/common';
import { Queue } from 'bullmq';
import IORedis from 'ioredis';
import type { ProviderCandidate } from '@qalahub/shared';

class StartMatchingDto {
  requestId!: string;
  candidates!: ProviderCandidate[];
}

@Controller('matching')
export class MatchingController implements OnModuleDestroy {
  private readonly connection = new IORedis(
    process.env.REDIS_URL ?? 'redis://localhost:6379',
    { maxRetriesPerRequest: null },
  );

  private readonly queue = new Queue('matching', {
    connection: this.connection,
  });

  @Post('start')
  async start(@Body() body: StartMatchingDto) {
    if (!body.requestId || !Array.isArray(body.candidates)) {
      return {
        ok: false,
        error: 'requestId and candidates are required',
      };
    }

    await this.queue.add(
      'start',
      {
        requestId: body.requestId,
        candidates: body.candidates,
      },
      {
        jobId: `${body.requestId}:start`,
        removeOnComplete: 1000,
        removeOnFail: 5000,
      },
    );

    return {
      ok: true,
      requestId: body.requestId,
      state: 'MATCHING_QUEUED',
      automation: true,
    };
  }

  async onModuleDestroy() {
    await this.queue.close();
    await this.connection.quit();
  }
}
