import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'node:crypto';

type ProviderSessionPayload = {
  providerId: string;
  exp: number;
};

const sessionTtlSeconds = 30 * 24 * 60 * 60;

function sessionSecret() {
  const secret =
    process.env.PROVIDER_SESSION_SECRET ??
    process.env.PHONE_VERIFICATION_SECRET ??
    process.env.INTERNAL_API_TOKEN;
  if (!secret) throw new Error('PROVIDER_SESSION_SECRET is required');
  return secret;
}

function sign(encodedPayload: string) {
  return createHmac('sha256', sessionSecret()).update(encodedPayload).digest('base64url');
}

export function createProviderSession(providerId: string) {
  const payload: ProviderSessionPayload = {
    providerId,
    exp: Math.floor(Date.now() / 1000) + sessionTtlSeconds,
  };
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return {
    token: `${encodedPayload}.${sign(encodedPayload)}`,
    expiresInSeconds: sessionTtlSeconds,
  };
}

export function readProviderSession(authorization?: string): ProviderSessionPayload {
  if (!authorization?.startsWith('Bearer ')) {
    throw new UnauthorizedException('provider session is required');
  }

  const token = authorization.slice('Bearer '.length).trim();
  const [encodedPayload, signature, extra] = token.split('.');
  if (!encodedPayload || !signature || extra) {
    throw new UnauthorizedException('invalid provider session');
  }

  const expected = sign(encodedPayload);
  const left = Buffer.from(signature);
  const right = Buffer.from(expected);
  if (left.length !== right.length || !timingSafeEqual(left, right)) {
    throw new UnauthorizedException('invalid provider session');
  }

  let payload: ProviderSessionPayload;
  try {
    payload = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8')) as ProviderSessionPayload;
  } catch {
    throw new UnauthorizedException('invalid provider session');
  }

  if (!payload.providerId || !Number.isInteger(payload.exp)) {
    throw new UnauthorizedException('invalid provider session');
  }
  if (payload.exp <= Math.floor(Date.now() / 1000)) {
    throw new UnauthorizedException('provider session expired');
  }

  return payload;
}

export function requireProviderSession(authorization: string | undefined, providerId: string) {
  const session = readProviderSession(authorization);
  if (session.providerId !== providerId) {
    throw new ForbiddenException('provider session does not match resource');
  }
  return session;
}
