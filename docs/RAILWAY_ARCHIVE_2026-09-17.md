# QalaHub Railway deployment archive

Archived: 2026-09-17

This document preserves the Railway production deployment shape so QalaHub can be recreated after its current Railway resources are removed.

## Source

- Repository: `itasik2/QalaHub`
- Branch: `main`
- Node.js: `>=24`
- Package manager: `npm@11.19.1`

## Railway project

- Project name at archive time: `believable-vibrancy`
- Project ID: `228f2881-ec15-449a-a46e-7eff503f4ce0`
- Production environment ID: `2fd76667-dcc1-4cc0-88c5-b3eb02c79a75`

## qalahub-api

- Service ID: `5a99e810-b066-42ea-9ecc-22fd5888a2d3`
- Source: `itasik2/QalaHub`, branch `main`
- Builder: Railpack
- Build command: `npm run build:api`
- Pre-deploy command: `npm run release:db`
- Start command: `npm run start:api`
- Healthcheck: `/api/v1/health`
- Public domain at archive time: `qalahub-api-production.up.railway.app`
- Port: `8080`
- Region at archive time: `sfo`

Environment variable names (values intentionally not stored here):

- `DATABASE_URL`
- `INTERNAL_API_TOKEN`
- `MOBIZON_API_KEY`
- `NODE_ENV`
- `PHONE_VERIFICATION_SECRET`
- `PROVIDER_SESSION_SECRET`
- `REDIS_URL`
- `SMS_PROVIDER`
- `WEB_ORIGINS`

## qalahub-worker

- Service ID: `f2c704a6-785e-45b6-97ca-62c995a4ecf8`
- Source: `itasik2/QalaHub`, branch `main`
- Builder: Railpack
- Build command: `npm run build:worker`
- Start command: `npm run start:worker`
- Region at archive time: `sfo`

Environment variable names (values intentionally not stored here):

- `DATABASE_URL`
- `NODE_ENV`
- `REDIS_URL`

## Redis

- Service ID: `e60671a6-28f3-4c91-aacf-fd72577caff6`
- Image: `redis:8.2`
- Persistent volume mount: `/data`
- Private endpoint: `redis`
- Start command:

```sh
/bin/sh -c "rm -rf $RAILWAY_VOLUME_MOUNT_PATH/lost+found/ && exec docker-entrypoint.sh redis-server --requirepass $REDIS_PASSWORD --save 60 1 --dir $RAILWAY_VOLUME_MOUNT_PATH"
```

Environment variable names (values intentionally not stored here):

- `REDISHOST`
- `REDISPASSWORD`
- `REDISPORT`
- `REDISUSER`
- `REDIS_PASSWORD`
- `REDIS_URL`

## Redis data semantics

QalaHub uses Redis through BullMQ for the `matching` queue. Core business state is persisted in PostgreSQL through Prisma. Redis contains queue/job state, including delayed matching-wave jobs. Removing the Redis service can therefore discard pending/delayed queue jobs, but does not remove the PostgreSQL records for requests, candidates, dispatch attempts, offers, events, providers, and related business entities.

Before decommissioning an actively used deployment, verify that no matching jobs are currently pending or processing. At archive time, recent Railway runtime/HTTP logs since 2026-09-16 showed no activity.

## Restore outline

1. Create a Railway project/environment.
2. Create Redis and attach a persistent volume at `/data`.
3. Recreate the Redis password and obtain its private `REDIS_URL`.
4. Create the API service from `itasik2/QalaHub` / `main`.
5. Configure the API build, pre-deploy, start and healthcheck settings listed above.
6. Restore the API environment variables from the secure secret source.
7. Create the worker service from the same repository/branch.
8. Configure its build/start commands and environment variables.
9. Ensure both API and worker use the same external PostgreSQL `DATABASE_URL` and Redis instance.
10. Run API healthcheck and verify worker startup logs.

## Important

Secret values are deliberately not committed to GitHub. This file is a deployment manifest, not a secrets backup.
