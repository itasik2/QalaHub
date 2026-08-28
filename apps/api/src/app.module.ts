import { Controller, Get, Module, ServiceUnavailableException } from '@nestjs/common';
import { prisma } from '@qalahub/db';
import { CatalogController } from './catalog.controller.js';
import { InternalProviderVerificationController } from './internal-provider-verification.controller.js';
import { MatchingController } from './matching.controller.js';
import { MatchingQueueService } from './matching-queue.service.js';
import { OfferSelectionController } from './offer-selection.controller.js';
import { OrderLifecycleController } from './order-lifecycle.controller.js';
import { ProviderActionsController } from './provider-actions.controller.js';
import { ProviderAvailabilityController } from './provider-availability.controller.js';
import { ProviderDashboardController } from './provider-dashboard.controller.js';
import { ProviderOnboardingController } from './provider-onboarding.controller.js';
import { ProviderPhoneVerificationController } from './provider-phone-verification.controller.js';
import { RequestCancellationController } from './request-cancellation.controller.js';
import { RequestsController } from './requests.controller.js';
import { SupplyHealthController } from './supply-health.controller.js';

@Controller('health')
class HealthController {
  constructor(private readonly matchingQueue: MatchingQueueService) {}

  @Get()
  async health() {
    try {
      const [, redis] = await Promise.all([
        prisma.$queryRaw`SELECT 1`,
        this.matchingQueue.ping(),
      ]);

      if (redis !== 'PONG') throw new Error(`unexpected Redis response: ${redis}`);

      return {
        ok: true,
        service: 'qalahub-api',
        automationFirst: true,
        dependencies: {
          postgres: 'ready',
          redis: 'ready',
        },
      };
    } catch {
      throw new ServiceUnavailableException('qalahub-api dependencies are not ready');
    }
  }
}

@Module({
  controllers: [
    HealthController,
    CatalogController,
    MatchingController,
    RequestsController,
    RequestCancellationController,
    ProviderActionsController,
    ProviderAvailabilityController,
    ProviderDashboardController,
    ProviderOnboardingController,
    ProviderPhoneVerificationController,
    InternalProviderVerificationController,
    OfferSelectionController,
    OrderLifecycleController,
    SupplyHealthController,
  ],
  providers: [MatchingQueueService],
})
export class AppModule {}
