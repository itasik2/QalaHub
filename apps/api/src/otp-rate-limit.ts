import { HttpException, ServiceUnavailableException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { Redis } from 'ioredis';

let redis: Redis | null = null;

function client() {
  const url = process.env.REDIS_URL;
  if (!url) throw new ServiceUnavailableException('OTP rate limiting is unavailable');

  if (!redis) {
    redis = new Redis(url, {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      enableReadyCheck: true,
    });
    redis.on('error', (error: Error) => {
      console.error('[otp-rate-limit] Redis error', error.message);
    });
  }

  return redis;
}

function boundedInt(value: string | undefined, fallback: number, min: number, max: number) {
  const parsed = Number(value);
  return Number.isInteger(parsed) ? Math.max(min, Math.min(parsed, max)) : fallback;
}

export async function assertOtpSendAllowed(phone: string) {
  const globalLimit = boundedInt(process.env.OTP_GLOBAL_SENDS_PER_MINUTE, 60, 1, 1000);
  const phoneLimit = boundedInt(process.env.OTP_PHONE_SENDS_PER_HOUR, 5, 1, 100);
  const phoneKey = createHash('sha256').update(phone).digest('hex').slice(0, 24);
  const redisClient = client();

  try {
    if (redisClient.status === 'wait') await redisClient.connect();

    const result = await redisClient.eval(
      `
        local globalCount = redis.call('INCR', KEYS[1])
        if globalCount == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
        local phoneCount = redis.call('INCR', KEYS[2])
        if phoneCount == 1 then redis.call('EXPIRE', KEYS[2], ARGV[2]) end
        return {globalCount, phoneCount}
      `,
      2,
      'qalahub:otp:global:minute',
      `qalahub:otp:phone:${phoneKey}:hour`,
      60,
      3600,
    ) as [number, number];

    const [globalCount, phoneCount] = result.map(Number);
    if (globalCount > globalLimit) {
      throw new HttpException(
        { message: 'SMS verification is temporarily busy; retry later', retryAfterSeconds: 60 },
        429,
      );
    }
    if (phoneCount > phoneLimit) {
      throw new HttpException(
        { message: 'too many verification codes requested for this phone', retryAfterSeconds: 3600 },
        429,
      );
    }
  } catch (error) {
    if (error instanceof HttpException) throw error;
    throw new ServiceUnavailableException('OTP rate limiting is unavailable');
  }
}
