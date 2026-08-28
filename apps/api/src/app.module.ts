import { Controller, Get, Module } from '@nestjs/common';
import { MatchingController } from './matching.controller.js';
import { MatchingQueueService } from './matching-queue.service.js';
import { OfferSelectionController } from './offer-selection.controller.js';
import { ProviderActionsController } from './provider-actions.controller.js';
import { ProviderAvailabilityController } from './provider-availability.controller.js';
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
    ProviderAvailabilityController,
    OfferSelectionController,
  ],
  providers: [MatchingQueueService],
})
export class AppModule {}
