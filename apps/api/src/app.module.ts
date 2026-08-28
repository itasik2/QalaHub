import { Controller, Get, Module } from '@nestjs/common';
import { InternalProviderVerificationController } from './internal-provider-verification.controller.js';
import { MatchingController } from './matching.controller.js';
import { MatchingQueueService } from './matching-queue.service.js';
import { OfferSelectionController } from './offer-selection.controller.js';
import { OrderLifecycleController } from './order-lifecycle.controller.js';
import { ProviderActionsController } from './provider-actions.controller.js';
import { ProviderAvailabilityController } from './provider-availability.controller.js';
import { ProviderOnboardingController } from './provider-onboarding.controller.js';
import { RequestCancellationController } from './request-cancellation.controller.js';
import { RequestsController } from './requests.controller.js';
import { SupplyHealthController } from './supply-health.controller.js';

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
    RequestCancellationController,
    ProviderActionsController,
    ProviderAvailabilityController,
    ProviderOnboardingController,
    InternalProviderVerificationController,
    OfferSelectionController,
    OrderLifecycleController,
    SupplyHealthController,
  ],
  providers: [MatchingQueueService],
})
export class AppModule {}
