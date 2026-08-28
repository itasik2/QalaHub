import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  HttpException,
  Param,
  Post,
} from '@nestjs/common';
import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';
import { ProviderStatus, prisma } from '@qalahub/db';
import { assertOtpSendAllowed } from './otp-rate-limit.js';
import { syncProviderReadiness } from './provider-readiness.js';
import { createProviderSession } from './provider-session.js';
import { sendSms } from './sms.service.js';
import { reconcileSupplyNeedsByCityId } from './supply-health.service.js';

class VerifyPhoneDto {
  code!: string;
}

const ttlMs = 10 * 60 * 1000;
const resendMs = 60 * 1000;
const maxAttempts = 5;

function verificationSecret() {
  const secret = process.env.PHONE_VERIFICATION_SECRET ?? process.env.INTERNAL_API_TOKEN;
  if (!secret) throw new Error('PHONE_VERIFICATION_SECRET is required');
  return secret;
}

function hashCode(phone: string, code: string) {
  return createHmac('sha256', verificationSecret())
    .update(`${phone}:${code}`)
    .digest('hex');
}

function equalHash(left: string, right: string) {
  const a = Buffer.from(left, 'hex');
  const b = Buffer.from(right, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

@Controller('providers')
export class ProviderPhoneVerificationController {
  @Post(':providerId/phone-verification/request')
  async requestCode(@Param('providerId') providerId: string) {
    const provider = await prisma.provider.findUnique({
      where: { id: providerId },
      include: { user: true },
    });
    if (!provider) throw new BadRequestException('provider not found');
    if (provider.status === ProviderStatus.BLOCKED) {
      throw new BadRequestException('blocked provider cannot verify phone');
    }
    if (!provider.user.phone) throw new BadRequestException('provider phone is missing');

    const now = new Date();
    const existing = await prisma.phoneVerificationChallenge.findUnique({
      where: { phone: provider.user.phone },
    });
    if (existing && now.getTime() - existing.sentAt.getTime() < resendMs) {
      const retryAfterSeconds = Math.ceil(
        (resendMs - (now.getTime() - existing.sentAt.getTime())) / 1000,
      );
      throw new HttpException(
        { message: 'verification code was sent recently', retryAfterSeconds },
        429,
      );
    }

    await assertOtpSendAllowed(provider.user.phone);

    const code = String(randomInt(100000, 1000000));
    const codeHash = hashCode(provider.user.phone, code);
    const expiresAt = new Date(now.getTime() + ttlMs);

    await prisma.phoneVerificationChallenge.upsert({
      where: { phone: provider.user.phone },
      update: {
        codeHash,
        attempts: 0,
        expiresAt,
        sentAt: now,
      },
      create: {
        phone: provider.user.phone,
        codeHash,
        attempts: 0,
        expiresAt,
        sentAt: now,
      },
    });

    let delivery: { provider: string; messageId?: string };
    try {
      delivery = await sendSms(
        provider.user.phone,
        `QalaHub: код подтверждения ${code}. Никому не сообщайте этот код.`,
      );
    } catch (error) {
      await prisma.phoneVerificationChallenge.deleteMany({
        where: { phone: provider.user.phone, codeHash },
      });
      throw new BadRequestException(
        error instanceof Error ? error.message : 'failed to send verification code',
      );
    }

    const exposeDevCode =
      process.env.NODE_ENV !== 'production' &&
      process.env.PHONE_VERIFICATION_EXPOSE_CODE === 'true';

    return {
      ok: true,
      phoneVerified: Boolean(provider.user.phoneVerifiedAt),
      loginVerification: Boolean(provider.user.phoneVerifiedAt),
      expiresInSeconds: Math.round(ttlMs / 1000),
      retryAfterSeconds: Math.round(resendMs / 1000),
      delivery,
      ...(exposeDevCode ? { devCode: code } : {}),
    };
  }

  @Post(':providerId/phone-verification/verify')
  async verifyCode(
    @Param('providerId') providerId: string,
    @Body() body: VerifyPhoneDto,
  ) {
    const code = body.code?.trim();
    if (!code || !/^\d{6}$/.test(code)) {
      throw new BadRequestException('code must contain 6 digits');
    }

    const provider = await prisma.provider.findUnique({
      where: { id: providerId },
      include: { user: true },
    });
    if (!provider) throw new BadRequestException('provider not found');
    if (provider.status === ProviderStatus.BLOCKED) {
      throw new BadRequestException('blocked provider cannot verify phone');
    }
    if (!provider.user.phone) throw new BadRequestException('provider phone is missing');

    const challenge = await prisma.phoneVerificationChallenge.findUnique({
      where: { phone: provider.user.phone },
    });
    if (!challenge) throw new BadRequestException('verification code was not requested');

    const now = new Date();
    if (challenge.expiresAt.getTime() <= now.getTime()) {
      await prisma.phoneVerificationChallenge.delete({ where: { id: challenge.id } });
      throw new BadRequestException('verification code expired');
    }
    if (challenge.attempts >= maxAttempts) {
      throw new ConflictException('too many verification attempts; request a new code');
    }

    const candidateHash = hashCode(provider.user.phone, code);
    if (!equalHash(challenge.codeHash, candidateHash)) {
      await prisma.phoneVerificationChallenge.update({
        where: { id: challenge.id },
        data: { attempts: { increment: 1 } },
      });
      throw new BadRequestException('invalid verification code');
    }

    await prisma.$transaction([
      prisma.user.update({
        where: { id: provider.userId },
        data: { phoneVerifiedAt: provider.user.phoneVerifiedAt ?? now },
      }),
      prisma.phoneVerificationChallenge.delete({ where: { id: challenge.id } }),
    ]);

    const state = await syncProviderReadiness(providerId);
    await reconcileSupplyNeedsByCityId(provider.cityId);
    const session = createProviderSession(providerId);

    return {
      ok: true,
      phoneVerified: true,
      readiness: state?.readiness ?? null,
      sessionToken: session.token,
      sessionExpiresInSeconds: session.expiresInSeconds,
    };
  }
}
