import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Headers,
  Param,
  Post,
} from '@nestjs/common';
import {
  AvailabilityStatus,
  CandidateStatus,
  DispatchResponse,
  OfferStatus,
  OrderStatus,
  ProviderStatus,
  RequestStatus,
  prisma,
} from '@qalahub/db';
import { requireRequestAccess } from './request-access.js';
import { reconcileSupplyNeedsByCityId } from './supply-health.service.js';

class CancelRequestDto {
  reason?: string;
}

@Controller('requests')
export class RequestCancellationController {
  @Post(':requestId/cancel')
  async cancel(
    @Param('requestId') requestId: string,
    @Headers('x-qalahub-request-token') accessToken: string | undefined,
    @Body() body: CancelRequestDto,
  ) {
    const request = await prisma.request.findUnique({
      where: { id: requestId },
      include: {
        order: { include: { provider: true } },
      },
    });
    if (!request) throw new BadRequestException('request not found');
    requireRequestAccess(request.accessTokenHash, accessToken);

    if (request.status === RequestStatus.CANCELLED) {
      return {
        ok: true,
        requestId,
        status: RequestStatus.CANCELLED,
        alreadyCancelled: true,
      };
    }
    if (request.status === RequestStatus.COMPLETED) {
      throw new ConflictException('completed request cannot be cancelled');
    }
    if (request.status === RequestStatus.IN_PROGRESS || request.order?.status === OrderStatus.IN_PROGRESS) {
      throw new ConflictException('in-progress work requires the exception/dispute path');
    }

    const now = new Date();
    const reason = body.reason?.trim().slice(0, 500) || null;

    const result = await prisma.$transaction(async (tx) => {
      const outstanding = await tx.dispatchAttempt.findMany({
        where: { requestId, response: null },
        select: { id: true, providerId: true },
      });
      const attemptIds = outstanding.map((item) => item.id);
      const providerIds = outstanding.map((item) => item.providerId);

      if (attemptIds.length > 0) {
        await tx.dispatchAttempt.updateMany({
          where: { id: { in: attemptIds }, response: null },
          data: { response: DispatchResponse.CANCELLED, respondedAt: now },
        });
        await tx.matchCandidate.updateMany({
          where: {
            requestId,
            providerId: { in: providerIds },
            status: CandidateStatus.DISPATCHED,
          },
          data: { status: CandidateStatus.SKIPPED },
        });
      }

      await tx.offer.updateMany({
        where: { requestId, status: OfferStatus.PENDING },
        data: { status: OfferStatus.REJECTED },
      });

      let providerAvailability: AvailabilityStatus | null = null;
      let orderStatus: OrderStatus | null = null;

      if (request.order) {
        if (request.order.status !== OrderStatus.CONFIRMED) {
          throw new ConflictException(`order is ${request.order.status.toLowerCase()}`);
        }

        const resumeAvailable =
          request.order.provider.status === ProviderStatus.ACTIVE &&
          request.order.provider.availableUntil != null &&
          request.order.provider.availableUntil.getTime() > now.getTime();
        providerAvailability = resumeAvailable
          ? AvailabilityStatus.AVAILABLE
          : AvailabilityStatus.OFFLINE;

        await tx.order.update({
          where: { id: request.order.id },
          data: { status: OrderStatus.CANCELLED },
        });
        orderStatus = OrderStatus.CANCELLED;

        await tx.provider.update({
          where: { id: request.order.providerId },
          data: {
            activeJobs: Math.max(0, request.order.provider.activeJobs - 1),
            availability: providerAvailability,
            ...(resumeAvailable ? {} : { availableUntil: null }),
            lastAvailabilityChange: now,
          },
        });
      }

      await tx.request.update({
        where: { id: requestId },
        data: { status: RequestStatus.CANCELLED },
      });

      await tx.requestEvent.create({
        data: {
          requestId,
          type: request.order ? 'order.cancelled' : 'request.cancelled',
          payload: {
            reason,
            cancelledDispatches: attemptIds.length,
            orderId: request.order?.id ?? null,
            providerId: request.order?.providerId ?? null,
            providerAvailability,
            humanInterventionRequired: false,
          },
        },
      });

      return {
        cancelledDispatches: attemptIds.length,
        orderStatus,
        providerAvailability,
      };
    });

    await reconcileSupplyNeedsByCityId(request.cityId);

    return {
      ok: true,
      requestId,
      status: RequestStatus.CANCELLED,
      ...result,
    };
  }
}
