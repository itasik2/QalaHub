import { Controller, Get, Module } from '@nestjs/common';
import { MatchingController } from './matching.controller.js';
import { MatchingQueueService } from './matching-queue.service.js';
import { ProviderActionsController } from './provider-actions.controller.js';
import { RequestsController } from './requests.controller.js';

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
