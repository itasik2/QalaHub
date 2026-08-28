# QalaHub

QalaHub is a city service-dispatch platform focused on one measurable result: connect a customer with a provider who is actually ready to take the job.

The core product is not a directory. It is an automated pipeline:

`request -> matching -> availability -> cascade dispatch -> accepted offer -> order`

## Product principle

Human operators are an exception path, not part of the normal order flow. Matching, provider availability, dispatch waves, timeouts, retries, reliability scoring and escalation are designed to run automatically.

## Architecture

- `apps/web` — Next.js customer/provider/admin UI
- `apps/api` — NestJS HTTP API
- `apps/worker` — BullMQ background matching/dispatch worker
- `packages/db` — Prisma/PostgreSQL schema and client
- `packages/shared` — shared domain types and matching rules
- PostgreSQL — source of truth
- Redis — queues, OTP rate limiting and transient automation state

## First milestone

A test request for a plumber should automatically:

1. find eligible providers;
2. filter by availability;
3. rank them;
4. dispatch to the first wave;
5. wait for the SLA timeout;
6. dispatch the next wave if nobody responds;
7. stop dispatching after enough accepted offers are received.

No dispatcher should be required for the normal path.

## Production

The pilot deployment uses Vercel for `apps/web` and Railway for the NestJS API, BullMQ worker, PostgreSQL and Redis.

See [`docs/production-deployment.md`](docs/production-deployment.md) for the required deployment order, service commands, environment variables, health check, database migration policy, Mobizon setup and production smoke checklist.
