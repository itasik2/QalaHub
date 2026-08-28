import 'dotenv/config';
import { Job, Queue, Worker } from 'bullmq';
import IORedis from 'ioredis';
import {
  buildDispatchWaves,
  decideNextMatchingAction,
  type MatchingConfig,
  type ProviderCandidate,
} from '@qalahub/shared';

const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379';
const connection = new IORedis(redisUrl, { maxRetriesPerRequest: null });
const queue = new Queue('matching', { connection });

const config: MatchingConfig = {
  firstWaveSize: Number(process.env.MATCHING_FIRST_WAVE_SIZE ?? 2),
  nextWaveSize: Number(process.env.MATCHING_NEXT_WAVE_SIZE ?? 2),
  maxWaves: Number(process.env.MATCHING_MAX_WAVES ?? 4),
  maxOffers: Number(process.env.MATCHING_MAX_OFFERS ?? 3),
};

const waveTimeoutMs = Number(process.env.MATCHING_WAVE_TIMEOUT_SECONDS ?? 90) * 1000;

type StartMatchingData = {
  requestId: string;
  candidates: ProviderCandidate[];
};

type DispatchWaveData = {
  requestId: string;
  waves: ProviderCandidate[][];
  waveIndex: number;
  acceptedOffers: number;
  expansionAttempted: boolean;
};

async function startMatching(job: Job<StartMatchingData>) {
  const waves = buildDispatchWaves(job.data.candidates, config);

  if (waves.length === 0) {
    console.warn('[matching] no eligible providers', { requestId: job.data.requestId });
    return { state: 'EXPAND_SEARCH_REQUIRED' };
  }

  await queue.add(
    'dispatch-wave',
    {
      requestId: job.data.requestId,
      waves,
      waveIndex: 0,
      acceptedOffers: 0,
      expansionAttempted: false,
    } satisfies DispatchWaveData,
    { jobId: `${job.data.requestId}:wave:0` },
  );

  return { state: 'DISPATCHING', waves: waves.length };
}

async function dispatchWave(job: Job<DispatchWaveData>) {
  const { requestId, waves, waveIndex, acceptedOffers, expansionAttempted } = job.data;
  const providers = waves[waveIndex] ?? [];

  console.info('[matching] dispatch wave', {
    requestId,
    waveIndex,
    providerIds: providers.map((provider) => provider.providerId),
  });

  // Notification adapters (Telegram/PWA/SMS) will consume one dispatch event per provider.
  // A provider response will later update acceptedOffers in persistent request state.

  const decision = decideNextMatchingAction({
    acceptedOffers,
    maxOffers: config.maxOffers,
    currentWave: waveIndex,
    totalWaves: waves.length,
    expansionAttempted,
  });

  if (decision.action === 'NEXT_WAVE') {
    await queue.add(
      'dispatch-wave',
      {
        ...job.data,
        waveIndex: waveIndex + 1,
      },
      {
        delay: waveTimeoutMs,
        jobId: `${requestId}:wave:${waveIndex + 1}`,
      },
    );
  } else if (decision.action === 'EXPAND_SEARCH') {
    console.warn('[matching] automatic search expansion required', { requestId });
    // The next implementation step will re-query providers with a larger radius / relaxed soft filters.
  } else if (decision.action === 'EXCEPTION') {
    console.error('[matching] automation exhausted', { requestId });
    // Only this path may create AutomationException for optional human review.
  }

  return decision;
}

const worker = new Worker(
  'matching',
  async (job) => {
    if (job.name === 'start') return startMatching(job as Job<StartMatchingData>);
    if (job.name === 'dispatch-wave') return dispatchWave(job as Job<DispatchWaveData>);
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
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

console.info('[worker] QalaHub matching worker started');
