import { BadRequestException, Body, ConflictException, Controller, Headers, Param, Post } from '@nestjs/common';
import {
  AvailabilityStatus,
  CandidateStatus,
  DispatchResponse,
  OfferStatus,
  OrderStatus,
  RequestStatus,
  prisma,
} from '@qalahub/db';
import { MatchingQueueService } from './matching-queue.service.js';
import { expireOfferSelectionIfNeeded } from './offer-selection-window.js';
import { requireRequestAccess } from './request-access.js';
import { reconcileSupplyNeedsByCityId } from './supply-health.service.js';

const rejectionReasons = new Set([
  'TOO_EXPENSIVE',
  'ETA_TOO_LONG',
  'NOT_SUITABLE',
  'NEED_OTHER_SPECIALIST',
  'OTHER',
]);

class RejectOffersDto {
  reason?: string;
}

@Controller('requests')
export class OfferSelectionController {
  constructor(private readonly matchingQueue: MatchingQueueService) {}

  @Post(':requestId/offers/reject-all')
  async rejectAll(
    @Param('requestId') requestId: string,
    @Headers('x-qalahub-request-token') accessToken?: string,
    @Body() body: RejectOffersDto = {},
  ) {
    const request = await prisma.request.findUnique({
      where: { id: requestId },
      include: { order: true },
    });
    if (!request) throw new BadRequestException('request not found');
    requireRequestAccess(request.accessTokenHash, accessToken);
    if (request.order) throw new ConflictException('provider already selected for this request');

    const expiration = await expireOfferSelectionIfNeeded(requestId);
    if (expiration.expired) {
      throw new ConflictException('offer selection window expired; refresh the request');
    }

    const pendingOffers = await prisma.offer.findMany({
      where: { requestId, status: OfferStatus.PENDING },
      select: { id: true, providerId: true },
    });
    if (pendingOffers.length === 0) {
      throw new ConflictException('there are no pending offers to reject');
    }

    const reason = rejectionReasons.has(body.reason ?? '') ? body.reason! : 'OTHER';
    const now = new Date();
    const outstanding = await prisma.dispatchAttempt.findMany({
      where: { requestId, response: null },
      select: { id: true, providerId: true },
    });
    const outstandingIds = outstanding.map((attempt) => attempt.id);
    const outstandingProviderIds = outstanding.map((attempt) => attempt.providerId);

    await prisma.$transaction(async (tx) => {
      await tx.offer.updateMany({
        where: { requestId, status: OfferStatus.PENDING },
        data: { status: OfferStatus.REJECTED },
      });

      if (outstandingIds.length > 0) {
        await tx.dispatchAttempt.updateMany({
          where: { id: { in: outstandingIds }, response: null },
          data: { response: DispatchResponse.CANCELLED, respondedAt: now },
        });
        await tx.matchCandidate.updateMany({
          where: {
            requestId,
            providerId: { in: outstandingProviderIds },
            status: CandidateStatus.DISPATCHED,
          },
          data: { status: CandidateStatus.SKIPPED },
        });
      }

      await tx.request.update({
        where: { id: requestId },
        data: {
          status: RequestStatus.MATCHING,
          searchExpansionAttempted: false,
          firstOfferAt: null,
          matchedAt: null,
        },
      });

      await tx.requestEvent.create({
        data: {
          requestId,
          type: 'customer.offers_rejected',
          source: 'CUSTOMER',
          payload: {
            reason,
            rejectedOfferIds: pendingOffers.map((offer) => offer.id),
            rejectedProviderIds: pendingOffers.map((offer) => offer.providerId),
            cancelledDispatches: outstandingIds.length,
            matchingResumed: true,
          },
        },
      });
    });

    await this.matchingQueue.reconcile(requestId);

    return {
      ok: true,
      requestId,
      rejectedOffers: pendingOffers.length,
      reason,
      status: RequestStatus.MATCHING,
      matching: 'RESUMED',
    };
  }

  @Post(':requestId/offers/resume')
  async resume(
    @Param('requestId') requestId: string,
    @Headers('x-qalahub-request-token') accessToken?: string,
  ) {
    const request = await prisma.request.findUnique({
      where: { id: requestId },
      include: { order: true },
    });
    if (!request) throw new BadRequestException('request not found');
    requireRequestAccess(request.accessTokenHash, accessToken);
    if (request.order) throw new ConflictException('provider already selected for this request');

    await expireOfferSelectionIfNeeded(requestId);

    const freshRequest = await prisma.request.findUnique({ where: { id: requestId } });
    if (!freshRequest) throw new BadRequestException('request not found');
    if (freshRequest.status !== RequestStatus.OFFERS_RECEIVED) {
      throw new ConflictException(`request is ${freshRequest.status.toLowerCase()}`);
    }

    const pendingOffers = await prisma.offer.count({
      where: { requestId, status: OfferStatus.PENDING },
    });
    if (pendingOffers > 0) {
      throw new ConflictException('pending offers must be selected or rejected first');
    }

    await prisma.$transaction([
      prisma.request.update({
        where: { id: requestId },
        data: {
          status: RequestStatus.MATCHING,
          searchExpansionAttempted: false,
          firstOfferAt: null,
          matchedAt: null,
        },
      }),
      prisma.requestEvent.create({
        data: {
          requestId,
          type: 'customer.matching_resumed',
          source: 'CUSTOMER',
          payload: { reason: 'OFFER_SELECTION_EXPIRED' },
        },
      }),
    ]);

    await this.matchingQueue.reconcile(requestId);

    return {
      ok: true,
      requestId,
      status: RequestStatus.MATCHING,
      matching: 'RESUMED',
    };
  }

  @Post(':requestId/offers/:offerId/select')
  async select(
    @Param('requestId') requestId: string,
    @Param('offerId') offerId: string,
    @Headers('x-qalahub-request-token') accessToken?: string,
  ) {
    const request = await prisma.request.findUnique({
      where: { id: requestId },
      include: { order: true },
    });
    if (!request) throw new BadRequestException('request not found');
    requireRequestAccess(request.accessTokenHash, accessToken);
    if (request.order) throw new ConflictException('provider already selected for this request');

    const expiration = await expireOfferSelectionIfNeeded(requestId);
    if (expiration.expired) {
      throw new ConflictException('offer selection window expired; refresh the request');
    }

    const offer = await prisma.offer.findUnique({
      where: { id: offerId },
      include: { provider: { select: { cityId: true } } },
    });
    if (!offer || offer.requestId !== requestId) {
      throw new BadRequestException('offer not found for request');
    }
    if (offer.status !== OfferStatus.PENDING) {
      throw new ConflictException(`offer is ${offer.status.toLowerCase()}`);
    }

    const now = new Date();

    const order = await prisma.$transaction(async (tx) => {
      const outstanding = await tx.dispatchAttempt.findMany({
        where: { requestId, response: null },
        select: { id: true, providerId: true },
      });
      const outstandingIds = outstanding.map((attempt) => attempt.id);
      const outstandingProviderIds = outstanding.map((attempt) => attempt.providerId);

      await tx.offer.updateMany({
        where: {
          requestId,
          id: { not: offerId },
          status: OfferStatus.PENDING,
        },
        data: { status: OfferStatus.REJECTED },
      });
      await tx.offer.update({
        where: { id: offerId },
        data: { status: OfferStatus.SELECTED },
      });

      if (outstandingIds.length > 0) {
        await tx.dispatchAttempt.updateMany({
          where: { id: { in: outstandingIds }, response: null },
          data: { response: DispatchResponse.CANCELLED, respondedAt: now },
        });
        await tx.matchCandidate.updateMany({
          where: {
            requestId,
            providerId: { in: outstandingProviderIds },
            status: CandidateStatus.DISPATCHED,
          },
          data: { status: CandidateStatus.SKIPPED },
        });
      }

      await tx.provider.update({
        where: { id: offer.providerId },
        data: {
          activeJobs: { increment: 1 },
          availability: AvailabilityStatus.BUSY,
          lastAvailabilityChange: now,
        },
      });

      const createdOrder = await tx.order.create({
        data: {
          requestId,
          offerId,
          customerId: request.customerId,
          providerId: offer.providerId,
          status: OrderStatus.CONFIRMED,
        },
      });

      await tx.request.update({
        where: { id: requestId },
        data: {
          status: RequestStatus.CONFIRMED,
          matchedAt: request.matchedAt ?? now,
        },
      });

      await tx.requestEvent.create({
        data: {
          requestId,
          type: 'offer.selected',
          payload: {
            offerId,
            providerId: offer.providerId,
            orderId: createdOrder.id,
            cancelledDispatches: outstandingIds.length,
            providerAvailability: AvailabilityStatus.BUSY,
          },
        },
      });

      return createdOrder;
    });

    await reconcileSupplyNeedsByCityId(offer.provider.cityId);

    return {
      ok: true,
      requestId,
      offerId,
      order,
      status: RequestStatus.CONFIRMED,
    };
  }
}
