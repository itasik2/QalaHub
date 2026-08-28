import { BadRequestException, Body, ConflictException, Controller, Param, Post } from '@nestjs/common';
import {
  CandidateStatus,
  DispatchResponse,
  OfferStatus,
  RequestStatus,
  prisma,
} from '@qalahub/db';
import { MatchingQueueService } from './matching-queue.service';

class RespondDto {
  response!: 'ACCEPTED' | 'DECLINED';
  amountKzt?: number;
  etaMinutes?: number;
  comment?: string;
}

@Controller('provider-dispatch')
export class ProviderActionsController {
  constructor(private readonly matchingQueue: MatchingQueueService) {}

  @Post(':attemptId/respond')
  async respond(@Param('attemptId') attemptId: string, @Body() body: RespondDto) {
    if (!['ACCEPTED', 'DECLINED'].includes(body.response)) {
      throw new BadRequestException('response must be ACCEPTED or DECLINED');
    }

    const attempt = await prisma.dispatchAttempt.findUnique({
      where: { id: attemptId },
      include: { request: true },
    });

    if (!attempt) throw new BadRequestException('dispatch attempt not found');
    if (attempt.response) throw new ConflictException('dispatch attempt already answered');
    if (attempt.expiresAt.getTime() <= Date.now()) {
      throw new ConflictException('dispatch attempt expired');
    }

    const now = new Date();

    if (body.response === 'ACCEPTED') {
      const result = await prisma.$transaction(async (tx) => {
        await tx.dispatchAttempt.update({
          where: { id: attempt.id },
          data: { response: DispatchResponse.ACCEPTED, respondedAt: now },
        });

        await tx.matchCandidate.updateMany({
          where: { requestId: attempt.requestId, providerId: attempt.providerId },
          data: { status: CandidateStatus.ACCEPTED },
        });

        const offer = await tx.offer.upsert({
          where: {
            requestId_providerId: {
              requestId: attempt.requestId,
              providerId: attempt.providerId,
            },
          },
          update: {
            amountKzt: body.amountKzt,
            etaMinutes: body.etaMinutes,
            comment: body.comment,
            status: OfferStatus.PENDING,
          },
          create: {
            requestId: attempt.requestId,
            providerId: attempt.providerId,
            amountKzt: body.amountKzt,
            etaMinutes: body.etaMinutes,
            comment: body.comment,
            status: OfferStatus.PENDING,
          },
        });

        await tx.provider.update({
          where: { id: attempt.providerId },
          data: { consecutiveMisses: 0 },
        });

        await tx.request.update({
          where: { id: attempt.requestId },
          data: {
            status: RequestStatus.OFFERS_RECEIVED,
            firstOfferAt: attempt.request.firstOfferAt ?? now,
          },
        });

        await tx.requestEvent.create({
          data: {
            requestId: attempt.requestId,
            type: 'provider.accepted',
            payload: {
              providerId: attempt.providerId,
              attemptId: attempt.id,
              offerId: offer.id,
              amountKzt: body.amountKzt ?? null,
              etaMinutes: body.etaMinutes ?? null,
            },
          },
        });

        return offer;
      });

      await this.matchingQueue.reconcile(attempt.requestId);
      return { ok: true, response: body.response, offer: result };
    }

    await prisma.$transaction([
      prisma.dispatchAttempt.update({
        where: { id: attempt.id },
        data: { response: DispatchResponse.DECLINED, respondedAt: now },
      }),
      prisma.matchCandidate.updateMany({
        where: { requestId: attempt.requestId, providerId: attempt.providerId },
        data: { status: CandidateStatus.DECLINED },
      }),
      prisma.requestEvent.create({
        data: {
          requestId: attempt.requestId,
          type: 'provider.declined',
          payload: { providerId: attempt.providerId, attemptId: attempt.id },
        },
      }),
    ]);

    await this.matchingQueue.reconcile(attempt.requestId);
    return { ok: true, response: body.response };
  }
}
