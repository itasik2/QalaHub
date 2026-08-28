import 'dotenv/config';
import { Job, Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import {
  AvailabilityStatus,
  CandidateStatus,
  DispatchResponse,
  ExceptionStatus,
  OfferStatus,
  ProviderStatus,
  RequestStatus,
  prisma,
} from '@qalahub/db';
import { scoreProvider, type MatchingConfig, type ProviderCandidate } from '@qalahub/shared';

const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379';
const connection = new Redis(redisUrl, { maxRetriesPerRequest: null });
const queue = new Queue('matching', { connection });

const config: MatchingConfig = {
  firstWaveSize: Number(process.env.MATCHING_FIRST_WAVE_SIZE ?? 2),
  nextWaveSize: Number(process.env.MATCHING_NEXT_WAVE_SIZE ?? 2),
  maxWaves: Number(process.env.MATCHING_MAX_WAVES ?? 4),
  maxOffers: Number(process.env.MATCHING_MAX_OFFERS ?? 3),
};

const waveTimeoutMs = Number(process.env.MATCHING_WAVE_TIMEOUT_SECONDS ?? 90) * 1000;
const pauseAfterMisses = Number(process.env.PROVIDER_PAUSE_AFTER_MISSES ?? 3);
const maxSearchDistanceKm = Number(process.env.MATCHING_MAX_DISTANCE_KM ?? 30);

const terminalStatuses = new Set<RequestStatus>([
  RequestStatus.PROVIDER_SELECTED,
  RequestStatus.CONFIRMED,
  RequestStatus.IN_PROGRESS,
  RequestStatus.COMPLETED,
  RequestStatus.CANCELLED,
  RequestStatus.EXPIRED,
  RequestStatus.FAILED_TO_MATCH,
]);

const dispatchJobId = (requestId: string, round: number, wave: number) =>
  `${requestId}-r${round}-w${wave}`;

function distanceKm(lat1?: number | null, lon1?: number | null, lat2?: number | null, lon2?: number | null) {
  if (lat1 == null || lon1 == null || lat2 == null || lon2 == null) return 0;
  const toRad = (value: number) => (value * Math.PI) / 180;
  const earthRadiusKm = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return earthRadiusKm * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

async function refreshCandidates(requestId: string) {
  const request = await prisma.request.findUnique({ where: { id: requestId } });
  if (!request) throw new Error(`Request ${requestId} not found`);

  const now = new Date();
  const providers = await prisma.provider.findMany({
    where: {
      cityId: request.cityId,
      status: ProviderStatus.ACTIVE,
      availability: AvailabilityStatus.AVAILABLE,
      OR: [{ availableUntil: null }, { availableUntil: { gt: now } }],
      services: {
        some: request.serviceId
          ? { active: true, serviceId: request.serviceId }
          : { active: true, service: { categoryId: request.categoryId, active: true } },
      },
    },
  });

  const existing = await prisma.matchCandidate.findMany({
    where: { requestId },
    select: { providerId: true },
  });
  const existingIds = new Set(existing.map((item) => item.providerId));

  const ranked = providers
    .map((provider) => {
      const distance = distanceKm(
        request.latitude,
        request.longitude,
        provider.latitude,
        provider.longitude,
      );
      const candidate: ProviderCandidate = {
        providerId: provider.id,
        availability: provider.availability,
        distanceKm: distance,
        serviceMatch: 1,
        responseRate: provider.responseRate,
        completionRate: provider.completionRate,
        rating: provider.rating,
        activeJobs: provider.activeJobs,
      };
      return { provider, candidate, score: scoreProvider(candidate), distance };
    })
    .filter(({ provider, score, distance }) =>
      Number.isFinite(score) &&
      distance <= request.maxDistanceKm &&
      distance <= provider.serviceRadiusKm,
    )
    .sort((a, b) => b.score - a.score);

  for (let index = 0; index < ranked.length; index += 1) {
    const item = ranked[index];
    await prisma.matchCandidate.upsert({
      where: {
        requestId_providerId: {
          requestId,
          providerId: item.provider.id,
        },
      },
      update: { score: item.score, rank: index + 1 },
      create: {
        requestId,
        providerId: item.provider.id,
        score: item.score,
        rank: index + 1,
        status: CandidateStatus.ELIGIBLE,
      },
    });
  }

  return {
    total: ranked.length,
    added: ranked.filter(({ provider }) => !existingIds.has(provider.id)).length,
  };
}

async function markExpiredAttempts(requestId: string) {
  const now = new Date();
  const expired = await prisma.dispatchAttempt.findMany({
    where: { requestId, response: null, expiresAt: { lte: now } },
    include: { provider: true },
  });

  for (const attempt of expired) {
    const nextMisses = attempt.provider.consecutiveMisses + 1;
    const shouldPause =
      nextMisses >= pauseAfterMisses && attempt.provider.availability === AvailabilityStatus.AVAILABLE;

    await prisma.$transaction(async (tx) => {
      await tx.dispatchAttempt.update({
        where: { id: attempt.id },
        data: { response: DispatchResponse.TIMED_OUT, respondedAt: now },
      });
      await tx.matchCandidate.updateMany({
        where: { requestId, providerId: attempt.providerId },
        data: { status: CandidateStatus.TIMED_OUT },
      });
      await tx.provider.update({
        where: { id: attempt.providerId },
        data: {
          consecutiveMisses: nextMisses,
          ...(shouldPause
            ? { availability: AvailabilityStatus.PAUSED, lastAvailabilityChange: now }
            : {}),
        },
      });
      await tx.requestEvent.create({
        data: {
          requestId,
          type: shouldPause ? 'provider.timeout.auto_paused' : 'provider.timeout',
          payload: {
            providerId: attempt.providerId,
            attemptId: attempt.id,
            consecutiveMisses: nextMisses,
          },
        },
      });
    });
  }

  return expired.length;
}

async function finalizeRequest(requestId: string) {
  const offers = await prisma.offer.count({
    where: { requestId, status: OfferStatus.PENDING },
  });

  if (offers > 0) {
    await prisma.request.update({
      where: { id: requestId },
      data: { status: RequestStatus.OFFERS_RECEIVED, matchedAt: new Date() },
    });
    await prisma.requestEvent.create({
      data: {
        requestId,
        type: 'matching.completed',
        payload: { offers, humanInterventionRequired: false },
      },
    });
    return { state: 'OFFERS_RECEIVED', offers };
  }

  const existingException = await prisma.automationException.findFirst({
    where: {
      requestId,
      code: 'AUTOMATION_EXHAUSTED',
      status: ExceptionStatus.OPEN,
    },
  });

  await prisma.request.update({
    where: { id: requestId },
    data: { status: RequestStatus.FAILED_TO_MATCH },
  });
  await prisma.requestEvent.create({
    data: {
      requestId,
      type: 'matching.failed',
      payload: { reason: 'AUTOMATION_EXHAUSTED', humanInterventionRequired: true },
    },
  });

  if (!existingException) {
    await prisma.automationException.create({
      data: {
        requestId,
        code: 'AUTOMATION_EXHAUSTED',
        details: { reason: 'No provider accepted after automatic search expansion' },
      },
    });
  }

  return { state: 'FAILED_TO_MATCH', offers: 0 };
}

async function scheduleDispatch(requestId: string, round: number, wave: number, delay = 0) {
  return queue.add(
    'dispatch-wave',
    { requestId, round, wave },
    {
      delay,
      jobId: dispatchJobId(requestId, round, wave),
      removeOnComplete: 1000,
      removeOnFail: 5000,
    },
  );
}

async function expandSearch(requestId: string) {
  const request = await prisma.request.findUnique({ where: { id: requestId } });
  if (!request) throw new Error(`Request ${requestId} not found`);
  if (request.searchExpansionAttempted) return finalizeRequest(requestId);

  const expandedDistance = Math.min(
    maxSearchDistanceKm,
    Math.max(request.maxDistanceKm + 5, request.maxDistanceKm * 2),
  );

  if (expandedDistance <= request.maxDistanceKm) return finalizeRequest(requestId);

  const nextRound = request.matchingRound + 1;
  await prisma.request.update({
    where: { id: requestId },
    data: {
      searchExpansionAttempted: true,
      maxDistanceKm: expandedDistance,
      matchingRound: nextRound,
      matchingWave: 0,
      status: RequestStatus.MATCHING,
    },
  });
  await prisma.requestEvent.create({
    data: {
      requestId,
      type: 'matching.search_expanded',
      payload: { round: nextRound, maxDistanceKm: expandedDistance },
    },
  });

  await refreshCandidates(requestId);
  const eligible = await prisma.matchCandidate.count({
    where: { requestId, status: CandidateStatus.ELIGIBLE },
  });

  if (eligible === 0) return finalizeRequest(requestId);
  await scheduleDispatch(requestId, nextRound, 0);
  return { state: 'SEARCH_EXPANDED', round: nextRound, eligible };
}

async function startMatching(job: Job<{ requestId: string }>) {
  const { requestId } = job.data;
  const request = await prisma.request.findUnique({ where: { id: requestId } });
  if (!request) throw new Error(`Request ${requestId} not found`);
  if (terminalStatuses.has(request.status)) return { state: 'TERMINAL', status: request.status };

  await prisma.request.update({
    where: { id: requestId },
    data: {
      status: RequestStatus.MATCHING,
      matchingRound: 0,
      matchingWave: 0,
      searchExpansionAttempted: false,
    },
  });
  await prisma.requestEvent.create({
    data: { requestId, type: 'matching.started', payload: { automation: true } },
  });

  const candidates = await refreshCandidates(requestId);
  if (candidates.total === 0) return expandSearch(requestId);

  await scheduleDispatch(requestId, 0, 0);
  return { state: 'MATCHING', candidates: candidates.total };
}

async function dispatchWave(job: Job<{ requestId: string; round: number; wave: number }>) {
  const { requestId, round, wave } = job.data;
  await markExpiredAttempts(requestId);

  const request = await prisma.request.findUnique({ where: { id: requestId } });
  if (!request) throw new Error(`Request ${requestId} not found`);
  if (terminalStatuses.has(request.status)) return { state: 'TERMINAL', status: request.status };
  if (round !== request.matchingRound) return { state: 'STALE_ROUND' };

  const offers = await prisma.offer.count({
    where: { requestId, status: OfferStatus.PENDING },
  });
  if (offers >= config.maxOffers) {
    await prisma.request.update({
      where: { id: requestId },
      data: { status: RequestStatus.OFFERS_RECEIVED, matchedAt: new Date() },
    });
    return { state: 'ENOUGH_OFFERS', offers };
  }

  if (wave >= config.maxWaves) return expandSearch(requestId);

  const size = wave === 0 ? config.firstWaveSize : config.nextWaveSize;
  const candidates = await prisma.matchCandidate.findMany({
    where: { requestId, status: CandidateStatus.ELIGIBLE },
    orderBy: { rank: 'asc' },
    take: size,
  });

  if (candidates.length === 0) return expandSearch(requestId);

  const now = new Date();
  const expiresAt = new Date(now.getTime() + waveTimeoutMs);
  const attemptIds: string[] = [];

  await prisma.$transaction(async (tx) => {
    for (const candidate of candidates) {
      const attempt = await tx.dispatchAttempt.create({
        data: {
          requestId,
          providerId: candidate.providerId,
          round,
          wave,
          expiresAt,
        },
      });
      attemptIds.push(attempt.id);
      await tx.matchCandidate.update({
        where: { id: candidate.id },
        data: { status: CandidateStatus.DISPATCHED },
      });
    }

    await tx.request.update({
      where: { id: requestId },
      data: {
        status: RequestStatus.WAITING_RESPONSES,
        matchingRound: round,
        matchingWave: wave,
      },
    });
    await tx.requestEvent.create({
      data: {
        requestId,
        type: 'dispatch.wave.sent',
        payload: {
          round,
          wave,
          providerIds: candidates.map((item) => item.providerId),
          attemptIds,
          timeoutSeconds: Math.round(waveTimeoutMs / 1000),
        },
      },
    });
  });

  await scheduleDispatch(requestId, round, wave + 1, waveTimeoutMs);

  console.info('[matching] dispatch wave', {
    requestId,
    round,
    wave,
    providerIds: candidates.map((item) => item.providerId),
  });

  return { state: 'WAITING_RESPONSES', round, wave, attempts: attemptIds };
}

async function reconcile(job: Job<{ requestId: string }>) {
  const { requestId } = job.data;
  await markExpiredAttempts(requestId);

  const request = await prisma.request.findUnique({ where: { id: requestId } });
  if (!request) throw new Error(`Request ${requestId} not found`);
  if (terminalStatuses.has(request.status)) return { state: 'TERMINAL', status: request.status };

  const offers = await prisma.offer.count({
    where: { requestId, status: OfferStatus.PENDING },
  });
  if (offers >= config.maxOffers) {
    await prisma.request.update({
      where: { id: requestId },
      data: { status: RequestStatus.OFFERS_RECEIVED, matchedAt: new Date() },
    });
    return { state: 'ENOUGH_OFFERS', offers };
  }

  const pending = await prisma.dispatchAttempt.count({
    where: {
      requestId,
      round: request.matchingRound,
      wave: request.matchingWave,
      response: null,
      expiresAt: { gt: new Date() },
    },
  });

  if (pending > 0) return { state: 'WAITING_RESPONSES', pending, offers };

  const nextWave = request.matchingWave + 1;
  const nextJob = await queue.getJob(dispatchJobId(requestId, request.matchingRound, nextWave));
  if (nextJob) {
    const state = await nextJob.getState();
    if (state === 'delayed') await nextJob.promote();
  } else {
    await scheduleDispatch(requestId, request.matchingRound, nextWave);
  }

  return { state: 'ADVANCED_EARLY', nextWave, offers };
}

const worker = new Worker(
  'matching',
  async (job) => {
    if (job.name === 'start') return startMatching(job as Job<{ requestId: string }>);
    if (job.name === 'dispatch-wave') {
      return dispatchWave(job as Job<{ requestId: string; round: number; wave: number }>);
    }
    if (job.name === 'reconcile') return reconcile(job as Job<{ requestId: string }>);
    throw new Error(`Unknown matching job: ${job.name}`);
  },
  { connection, concurrency: 10 },
);

worker.on('completed', (job) => {
  console.info('[matching] completed', { jobId: job.id, name: job.name });
});

worker.on('failed', (job, error) => {
  console.error('[matching] failed', { jobId: job?.id, name: job?.name, error: error.message });
});

async function shutdown(signal: string) {
  console.info('[worker] shutdown', { signal });
  await worker.close();
  await queue.close();
  await connection.quit();
  await prisma.$disconnect();
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

console.info('[worker] QalaHub autonomous matching worker started');
