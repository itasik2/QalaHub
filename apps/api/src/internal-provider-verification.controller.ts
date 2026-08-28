import {
  BadRequestException,
  Controller,
  Headers,
  Param,
  Post,
  UnauthorizedException,
} from '@nestjs/common';
import { prisma } from '@qalahub/db';
import { syncProviderReadiness } from './provider-readiness.js';

@Controller('internal/providers')
export class InternalProviderVerificationController {
  @Post(':providerId/phone-verified')
  async markPhoneVerified(
    @Param('providerId') providerId: string,
    @Headers('x-qalahub-internal-token') token?: string,
  ) {
    const expected = process.env.INTERNAL_API_TOKEN;
    if (!expected || !token || token !== expected) {
      throw new UnauthorizedException('invalid internal token');
    }

    const provider = await prisma.provider.findUnique({
      where: { id: providerId },
      include: { user: true },
    });
    if (!provider) throw new BadRequestException('provider not found');
    if (!provider.user.phone) throw new BadRequestException('provider phone is missing');

    await prisma.user.update({
      where: { id: provider.userId },
      data: { phoneVerifiedAt: provider.user.phoneVerifiedAt ?? new Date() },
    });

    const state = await syncProviderReadiness(providerId);
    if (!state) throw new BadRequestException('provider not found after verification');

    return {
      ok: true,
      providerId,
      phoneVerified: true,
      readiness: state.readiness,
    };
  }
}
