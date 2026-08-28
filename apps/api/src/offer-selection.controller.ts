import { BadRequestException, ConflictException, Controller, Param, Post } from '@nestjs/common';
import {
  CandidateStatus,
  DispatchResponse,
  OfferStatus,
  OrderStatus,
  RequestStatus,
  prisma,
} from '@qalahub/db';

@Controller('requests')
export class OfferSelectionController {
  @Post(':requestId/offers/:offerId/select')
  async select(@Param('requestId') requestId: string, @Param('offerId') offerId: string) {
    const request = await prisma.request.findUnique({
      where: { id: requestId },
      include: { order: true },
    });
    if (!request) throw new BadRequestException('request not found');
    if (request.order) throw new ConflictException('provider already selected for this request');

    const offer = await prisma.offer.findUnique({ where: { id: offerId } });
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
        data: { activeJobs: { increment: 1 } },
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
          },
        },
      });

      return createdOrder;
    });

    return {
      ok: true,
      requestId,
      offerId,
      order,
      status: RequestStatus.CONFIRMED,
    };
  }
}
