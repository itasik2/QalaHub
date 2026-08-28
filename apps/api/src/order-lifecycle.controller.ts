import {
  BadRequestException,
  ConflictException,
  Controller,
  Param,
  Post,
} from '@nestjs/common';
import {
  AvailabilityStatus,
  OrderStatus,
  ProviderStatus,
  RequestStatus,
  prisma,
} from '@qalahub/db';
import { reconcileSupplyNeedsByCityId } from './supply-health.service.js';

@Controller('providers')
export class OrderLifecycleController {
  @Post(':providerId/orders/:orderId/start')
  async start(
    @Param('providerId') providerId: string,
    @Param('orderId') orderId: string,
  ) {
    const order = await prisma.order.findUnique({ where: { id: orderId } });
    if (!order) throw new BadRequestException('order not found');
    if (order.providerId !== providerId) {
      throw new BadRequestException('order does not belong to provider');
    }
    if (order.status !== OrderStatus.CONFIRMED) {
      throw new ConflictException(`order is ${order.status.toLowerCase()}`);
    }

    const updated = await prisma.$transaction(async (tx) => {
      const nextOrder = await tx.order.update({
        where: { id: orderId },
        data: { status: OrderStatus.IN_PROGRESS },
      });

      await tx.request.update({
        where: { id: order.requestId },
        data: { status: RequestStatus.IN_PROGRESS },
      });

      await tx.requestEvent.create({
        data: {
          requestId: order.requestId,
          type: 'order.started',
          payload: { orderId, providerId },
        },
      });

      return nextOrder;
    });

    return {
      ok: true,
      order: updated,
      status: OrderStatus.IN_PROGRESS,
    };
  }

  @Post(':providerId/orders/:orderId/complete')
  async complete(
    @Param('providerId') providerId: string,
    @Param('orderId') orderId: string,
  ) {
    const order = await prisma.order.findUnique({
      where: { id: orderId },
      include: { provider: true },
    });
    if (!order) throw new BadRequestException('order not found');
    if (order.providerId !== providerId) {
      throw new BadRequestException('order does not belong to provider');
    }
    if (order.status !== OrderStatus.IN_PROGRESS) {
      throw new ConflictException(`order is ${order.status.toLowerCase()}`);
    }

    const now = new Date();
    const resumeAvailable =
      order.provider.status === ProviderStatus.ACTIVE &&
      order.provider.availableUntil != null &&
      order.provider.availableUntil.getTime() > now.getTime();
    const nextAvailability = resumeAvailable
      ? AvailabilityStatus.AVAILABLE
      : AvailabilityStatus.OFFLINE;

    const result = await prisma.$transaction(async (tx) => {
      const nextOrder = await tx.order.update({
        where: { id: orderId },
        data: { status: OrderStatus.COMPLETED },
      });

      await tx.request.update({
        where: { id: order.requestId },
        data: { status: RequestStatus.COMPLETED },
      });

      const nextProvider = await tx.provider.update({
        where: { id: providerId },
        data: {
          activeJobs: Math.max(0, order.provider.activeJobs - 1),
          availability: nextAvailability,
          ...(resumeAvailable ? {} : { availableUntil: null }),
          lastAvailabilityChange: now,
        },
      });

      await tx.requestEvent.create({
        data: {
          requestId: order.requestId,
          type: 'order.completed',
          payload: {
            orderId,
            providerId,
            providerAvailability: nextAvailability,
            humanInterventionRequired: false,
          },
        },
      });

      return { order: nextOrder, provider: nextProvider };
    });

    await reconcileSupplyNeedsByCityId(order.provider.cityId);

    return {
      ok: true,
      ...result,
      status: OrderStatus.COMPLETED,
    };
  }
}
