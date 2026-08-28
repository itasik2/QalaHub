import { Controller, Get, Module } from '@nestjs/common';
import { MatchingController } from './matching.controller';
import { MatchingQueueService } from './matching-queue.service';
import { ProviderActionsController } from './provider-actions.controller';
import { RequestsController } from './requests.controller';

@Controller('health')
class HealthController {
  @Get()
  health() {
    return {
      ok: true,
      service: 'qalahub-api',
      automationFirst: true,
    };
  }
}

@Module({
  controllers: [
    HealthController,
    MatchingController,
    RequestsController,
    ProviderActionsController,
  ],
  providers: [MatchingQueueService],
})
export class AppModule {}
