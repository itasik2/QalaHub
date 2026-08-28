import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';

function webOrigins() {
  const configured = (process.env.WEB_ORIGINS ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

  if (configured.length > 0) return configured;
  if (process.env.NODE_ENV === 'production') {
    throw new Error('WEB_ORIGINS must be configured in production');
  }

  return ['http://localhost:3000', 'http://127.0.0.1:3000'];
}

function assertProductionConfig() {
  if (process.env.NODE_ENV !== 'production') return;

  const required = [
    'DATABASE_URL',
    'REDIS_URL',
    'WEB_ORIGINS',
    'INTERNAL_API_TOKEN',
    'PHONE_VERIFICATION_SECRET',
    'PROVIDER_SESSION_SECRET',
    'MOBIZON_API_KEY',
  ] as const;

  const missing = required.filter((name) => !process.env[name]?.trim());
  if (missing.length > 0) {
    throw new Error(`Missing production environment variables: ${missing.join(', ')}`);
  }

  if ((process.env.SMS_PROVIDER ?? '').toLowerCase() !== 'mobizon') {
    throw new Error('SMS_PROVIDER must be mobizon in production');
  }

  const secretNames = [
    'INTERNAL_API_TOKEN',
    'PHONE_VERIFICATION_SECRET',
    'PROVIDER_SESSION_SECRET',
  ] as const;
  const secrets = secretNames.map((name) => process.env[name]!.trim());

  for (let index = 0; index < secrets.length; index += 1) {
    if (secrets[index].length < 32) {
      throw new Error(`${secretNames[index]} must contain at least 32 characters in production`);
    }
  }

  if (new Set(secrets).size !== secrets.length) {
    throw new Error('Production API secrets must use different values');
  }
}

async function bootstrap() {
  assertProductionConfig();

  const app = await NestFactory.create(AppModule);
  app.setGlobalPrefix('api/v1');
  app.enableCors({
    origin: webOrigins(),
    methods: ['GET', 'POST', 'PUT', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-QalaHub-Request-Token'],
    maxAge: 600,
  });

  const port = Number(process.env.PORT ?? process.env.API_PORT ?? 4000);
  await app.listen(port, '0.0.0.0');
}

void bootstrap();
