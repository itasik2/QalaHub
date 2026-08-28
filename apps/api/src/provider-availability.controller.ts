import { BadRequestException, Body, Controller, Headers, Param, Post } from '@nestjs/common';
import { AvailabilityStatus, ProviderStatus, prisma } from '@qalahub/db';
import { requireProviderSession } from './provider-session.js';
import { reconcileSupplyNeedsByCityId } from './supply-health.service.js';

class AvailabilityDto {
  status!: 'AVAILABLE' | 'BUSY' | 'OFFLINE';
  minutes?: number;
}

@Controller('providers')
export class ProviderAvailabilityController {
  @Post(':providerId/availability')
  async setAvailability(
    @Param('providerId') providerId: string,
    @Headers('authorization') authorization: string | undefined,
    @Body() body: AvailabilityDto,
  ) {
    requireProviderSession(authorization, providerId);

    if (!['AVAILABLE', 'BUSY', 'OFFLINE'].includes(body.status)) {
      throw new BadRequestException('status must be AVAILABLE, BUSY or OFFLINE');
    }

    const provider = await prisma.provider.findUnique({ where: { id: providerId } });
    if (!provider) throw new BadRequestException('provider not found');
    if (provider.status !== ProviderStatus.ACTIVE) {
      throw new BadRequestException('provider is not active');
    }

    const now = new Date();
    const status = AvailabilityStatus[body.status];
    let availableUntil: Date | null = null;

    if (status === AvailabilityStatus.AVAILABLE) {
      const minutes = body.minutes ?? 240;
      if (!Number.isInteger(minutes) || minutes < 15 || minutes > 720) {
        throw new BadRequestException('minutes must be an integer from 15 to 720');
      }
      availableUntil = new Date(now.getTime() + minutes * 60 * 1000);
    }

    const updated = await prisma.provider.update({
      where: { id: providerId },
      data: {
        availability: status,
        availableUntil,
        lastAvailabilityChange: now,
        ...(status === AvailabilityStatus.AVAILABLE ? { consecutiveMisses: 0 } : {}),
      },
      include: { user: true },
    });

    await reconcileSupplyNeedsByCityId(updated.cityId);

    return {
      ok: true,
      provider: updated,
      availability: {
        status: updated.availability,
        availableUntil: updated.availableUntil,
      },
    };
  }
}
