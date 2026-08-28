import { BadRequestException, Controller, Get, Headers, Param } from '@nestjs/common';
import { OrderStatus, prisma } from '@qalahub/db';
import { syncProviderReadiness } from './provider-readiness.js';
import { requireProviderSession } from './provider-session.js';

@Controller('providers')
export class ProviderDashboardController {
  @Get(':providerId/dashboard')
  async dashboard(
    @Param('providerId') providerId: string,
    @Headers('authorization') authorization?: string,
  ) {
    requireProviderSession(authorization, providerId);

    const readiness = await syncProviderReadiness(providerId);
    if (!readiness) throw new BadRequestException('provider not found');

    const now = new Date();
    const [provider, pendingDispatches, activeOrders] = await Promise.all([
      prisma.provider.findUnique({
        where: { id: providerId },
        include: {
          user: true,
          city: true,
          services: {
            where: { active: true },
            include: { service: { include: { category: true } } },
          },
        },
      }),
      prisma.dispatchAttempt.findMany({
        where: {
          providerId,
          response: null,
          expiresAt: { gt: now },
        },
        orderBy: { expiresAt: 'asc' },
        select: {
          id: true,
          expiresAt: true,
          sentAt: true,
          request: {
            select: {
              id: true,
              title: true,
              description: true,
              urgency: true,
              category: { select: { slug: true, name: true } },
              service: { select: { slug: true, name: true } },
            },
          },
        },
      }),
      prisma.order.findMany({
        where: {
          providerId,
          status: { in: [OrderStatus.CONFIRMED, OrderStatus.IN_PROGRESS] },
        },
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          status: true,
          createdAt: true,
          updatedAt: true,
          request: {
            select: {
              id: true,
              title: true,
              description: true,
              urgency: true,
            },
          },
          offer: {
            select: {
              id: true,
              amountKzt: true,
              etaMinutes: true,
              comment: true,
            },
          },
        },
      }),
    ]);

    if (!provider) throw new BadRequestException('provider not found');

    return {
      ok: true,
      provider,
      readiness: readiness.readiness,
      pendingDispatches: pendingDispatches.map((attempt) => ({
        id: attempt.id,
        expiresAt: attempt.expiresAt,
        sentAt: attempt.sentAt,
        request: {
          id: attempt.request.id,
          title: attempt.request.title,
          description: attempt.request.description,
          urgency: attempt.request.urgency,
          category: attempt.request.category,
          service: attempt.request.service,
        },
      })),
      activeOrders,
      generatedAt: now,
    };
  }
}
