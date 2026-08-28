# QalaHub production deployment

Target architecture for the Pavlodar pilot:

- **Vercel**: `apps/web` (Next.js frontend)
- **Railway**: API service (NestJS)
- **Railway**: worker service (BullMQ)
- **Railway PostgreSQL**: application database
- **Railway Redis**: BullMQ queues and OTP rate limiting
- **Mobizon Kazakhstan**: provider OTP SMS delivery

Do not deploy the API as a serverless function. Autonomous matching depends on a continuously running BullMQ worker and Redis.

## 1. Required order

1. Provision PostgreSQL in Railway.
2. Provision Redis in the same Railway project.
3. Create the QalaHub API service from `itasik2/QalaHub`, branch `main`.
4. Configure API variables and commands.
5. Deploy the API and verify `/api/v1/health` returns HTTP 200.
6. Create the QalaHub worker service from the same repository and branch.
7. Configure worker variables and commands.
8. Deploy the worker.
9. Create/import the Vercel project with Root Directory `apps/web`.
10. Set the final Railway API URL in Vercel as `NEXT_PUBLIC_API_BASE_URL` and deploy the web project.
11. Put the final Vercel production origin into Railway `WEB_ORIGINS` and redeploy the API if the origin changed.
12. Run a real OTP/login smoke test with a controlled phone number before inviting providers.

## 2. Railway services

Keep all four Railway services in one project/environment:

- `qalahub-api`
- `qalahub-worker`
- `Postgres`
- `Redis`

The exact database service names can differ. If they do, adjust reference variables accordingly.

### API service

Source:

- Repository: `itasik2/QalaHub`
- Branch: `main`
- Repository root: monorepo root

Build command:

```text
npm run build:api
```

Pre-deploy command:

```text
npm run release:db
```

Start command:

```text
npm run start:api
```

Public networking:

- Enabled
- Generate a Railway public domain for the API

Health check path:

```text
/api/v1/health
```

The application listens on Railway's injected `PORT` variable. `API_PORT=4000` remains a local-development fallback only.

### Worker service

Source:

- Repository: `itasik2/QalaHub`
- Branch: `main`
- Repository root: monorepo root

Build command:

```text
npm run build:worker
```

Start command:

```text
npm run start:worker
```

Public networking:

- Disabled
- The worker does not need a public domain

Do not run database seed as part of API or worker deployment.

For the pilot, keep `npm run release:db` on the API pre-deploy step only. Deploy the API before the worker when a schema migration is included. This avoids making two independently deployed services race to run the same migration step.

## 3. Railway API environment variables

Use Railway reference variables for PostgreSQL and Redis rather than copying credentials.

```text
NODE_ENV=production
DATABASE_URL=${{Postgres.DATABASE_URL}}
REDIS_URL=${{Redis.REDIS_URL}}
WEB_ORIGINS=https://<final-vercel-production-domain>
INTERNAL_API_TOKEN=<unique-random-secret-at-least-32-characters>
PHONE_VERIFICATION_SECRET=<different-random-secret-at-least-32-characters>
PROVIDER_SESSION_SECRET=<different-random-secret-at-least-32-characters>
SMS_PROVIDER=mobizon
MOBIZON_API_KEY=<mobizon-api-key>
MOBIZON_SENDER=QalaHub
PHONE_VERIFICATION_EXPOSE_CODE=false
OTP_GLOBAL_SENDS_PER_MINUTE=60
OTP_PHONE_SENDS_PER_HOUR=5
SUPPLY_HEALTH_TARGET_AVAILABLE=5
```

The three QalaHub secrets must be different values. Production startup intentionally fails if mandatory variables are missing, the three secrets are too short/equal, or SMS delivery is not set to Mobizon.

Seal sensitive variables in Railway after they are configured when practical.

### Matching defaults

These defaults are suitable for the first pilot unless real traffic shows otherwise:

```text
MATCHING_FIRST_WAVE_SIZE=2
MATCHING_NEXT_WAVE_SIZE=2
MATCHING_WAVE_TIMEOUT_SECONDS=90
MATCHING_MAX_OFFERS=3
MATCHING_MAX_WAVES=4
MATCHING_MAX_DISTANCE_KM=30
PROVIDER_PAUSE_AFTER_MISSES=3
```

## 4. Railway worker environment variables

```text
NODE_ENV=production
DATABASE_URL=${{Postgres.DATABASE_URL}}
REDIS_URL=${{Redis.REDIS_URL}}
MATCHING_FIRST_WAVE_SIZE=2
MATCHING_NEXT_WAVE_SIZE=2
MATCHING_WAVE_TIMEOUT_SECONDS=90
MATCHING_MAX_OFFERS=3
MATCHING_MAX_WAVES=4
MATCHING_MAX_DISTANCE_KM=30
PROVIDER_PAUSE_AFTER_MISSES=3
```

The worker production start command runs environment preflight and refuses to start without valid PostgreSQL and Redis URLs.

## 5. Vercel web project

Create one Vercel project from the same GitHub repository.

Settings:

```text
Root Directory: apps/web
Framework Preset: Next.js
Build Command: default (next build)
Output Directory: default (.next)
```

`apps/web` currently has no workspace dependency on the API, worker, shared package, or database package, so it can be built independently from its Root Directory.

Production environment variable:

```text
NEXT_PUBLIC_API_BASE_URL=https://<railway-api-domain>/api/v1
```

This value is public client configuration, not a secret. Because `NEXT_PUBLIC_*` values are embedded into the Next.js client bundle at build time, redeploy the Vercel project after changing the API URL.

## 6. CORS

`WEB_ORIGINS` contains browser origins only, without a trailing path.

Example:

```text
WEB_ORIGINS=https://qalahub.vercel.app
```

For more than one explicitly trusted origin:

```text
WEB_ORIGINS=https://qalahub.example.kz,https://qalahub.vercel.app
```

Do not use `*` in production. Provider bearer sessions and customer request tokens are intentionally accepted only from configured browser origins at the CORS layer.

## 7. Mobizon production check

Before inviting real providers:

1. Confirm the Mobizon API key is active.
2. Confirm the intended sender name is approved/usable. If `QalaHub` is not approved, set `MOBIZON_SENDER` to the sender value allowed by the account or omit it according to the provider configuration.
3. Request one OTP from `/provider` on the production web app.
4. Verify the SMS arrives.
5. Enter the correct code and confirm the provider dashboard opens.
6. Verify a wrong OTP is rejected.
7. Verify immediate repeated OTP requests return a rate-limit response instead of sending unlimited messages.

Never set `PHONE_VERIFICATION_EXPOSE_CODE=true` in production.

## 8. Production smoke checklist

After every first-time environment setup or infrastructure change, verify:

- `GET https://<api-domain>/api/v1/health` returns 200.
- Customer can create a request.
- Request page opens only in a browser containing its request access token.
- Opening the same request URL in an unrelated browser does not expose the request.
- Provider can obtain and verify OTP.
- Provider dashboard requires bearer session.
- Available provider receives a matching dispatch.
- Provider can accept and submit price/ETA.
- Customer can select the offer.
- Selected provider changes to `BUSY` in the protected provider dashboard.
- Provider can start and complete the order.
- Provider becomes available again when appropriate.
- No customer response exposes provider phone, exact coordinates, internal reliability fields, or request token hashes.

## 9. Database migration policy

Production schema changes use:

```text
npm run release:db
```

which runs Prisma `migrate deploy`.

Rules:

- Never use `prisma migrate dev` in production.
- Never run `npm run db:seed` automatically on production deploys.
- Commit every production migration to the repository before deployment.
- Deploy API/migrations before a worker version that requires the new schema.
- Take a database backup before destructive or high-risk schema migrations once the pilot contains real user data.

## 10. CI gate

`main` CI must stay green before production deployment. It currently covers:

- production dependency audit;
- complete TypeScript/Next/Nest/worker build;
- production environment preflight;
- Prisma migration deployment on a clean PostgreSQL instance;
- Pavlodar pilot seed consistency;
- autonomous matching smoke;
- customer request access-token protection;
- provider availability/order lifecycle;
- provider onboarding;
- OTP verification/provider session smoke;
- supply-health/recruitment logic.

A failed CI run blocks production promotion even if the change appears unrelated to the failing subsystem.

## 11. Initial pilot release rule

For the first public pilot, deploy in this order for every backend release containing a migration:

```text
1. Merge only a green main
2. Deploy qalahub-api (pre-deploy migration runs)
3. Confirm API health is 200
4. Deploy qalahub-worker
5. Deploy Vercel web if frontend or NEXT_PUBLIC_API_BASE_URL changed
6. Execute the production smoke checklist
```

This deliberately favors predictability over clever deployment choreography. The project is not improved by discovering distributed-systems folklore through paying customers.
