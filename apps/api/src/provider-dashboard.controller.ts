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
        include: {
          request: {
            include: {
              category: true,
              service: true,
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
        include: {
          request: true,
          offer: true,
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
          category: {
            slug: attempt.request.category.slug,
            name: attempt.request.category.name,
          },
          service: attempt.request.service
            ? {
                slug: attempt.request.service.slug,
                name: attempt.request.service.name,
              }
            : null,
        },
      })),
      activeOrders,
      generatedAt: now,
    };
  }
}
