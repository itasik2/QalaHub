import { UnauthorizedException } from '@nestjs/common';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export function createRequestAccessToken() {
  const token = randomBytes(32).toString('base64url');
  return {
    token,
    hash: hashRequestAccessToken(token),
  };
}

export function hashRequestAccessToken(token: string) {
  return createHash('sha256').update(token).digest('hex');
}

export function requireRequestAccess(storedHash: string | null | undefined, token?: string) {
  if (!storedHash || !token) {
    throw new UnauthorizedException('request access token is required');
  }

  const candidate = hashRequestAccessToken(token.trim());
  const left = Buffer.from(storedHash, 'hex');
  const right = Buffer.from(candidate, 'hex');
  if (left.length !== right.length || !timingSafeEqual(left, right)) {
    throw new UnauthorizedException('invalid request access token');
  }
}
