export type ProviderAvailability = 'AVAILABLE' | 'BUSY' | 'OFFLINE' | 'PAUSED';

export type ProviderCandidate = {
  providerId: string;
  availability: ProviderAvailability;
  distanceKm: number;
  serviceMatch: number;
  responseRate: number;
  completionRate: number;
  rating: number;
  activeJobs: number;
};

export type MatchingConfig = {
  firstWaveSize: number;
  nextWaveSize: number;
  maxWaves: number;
  maxOffers: number;
};

const clamp01 = (value: number) => Math.max(0, Math.min(1, value));

export function scoreProvider(candidate: ProviderCandidate): number {
  if (candidate.availability !== 'AVAILABLE') return Number.NEGATIVE_INFINITY;

  const service = clamp01(candidate.serviceMatch) * 40;
  const response = clamp01(candidate.responseRate) * 20;
  const completion = clamp01(candidate.completionRate) * 20;
  const rating = clamp01(candidate.rating / 5) * 10;
  const distance = Math.max(0, 10 - Math.min(candidate.distanceKm, 10));
  const loadPenalty = Math.min(candidate.activeJobs, 5) * 2;

  return service + response + completion + rating + distance - loadPenalty;
}

export function rankProviders(candidates: ProviderCandidate[]): ProviderCandidate[] {
  return candidates
    .filter((candidate) => candidate.availability === 'AVAILABLE')
    .map((candidate) => ({ candidate, score: scoreProvider(candidate) }))
    .filter(({ score }) => Number.isFinite(score))
    .sort((a, b) => b.score - a.score)
    .map(({ candidate }) => candidate);
}

export function buildDispatchWaves(
  candidates: ProviderCandidate[],
  config: MatchingConfig,
): ProviderCandidate[][] {
  const ranked = rankProviders(candidates);
  const waves: ProviderCandidate[][] = [];
  let offset = 0;

  for (let wave = 0; wave < config.maxWaves && offset < ranked.length; wave += 1) {
    const size = wave === 0 ? config.firstWaveSize : config.nextWaveSize;
    const slice = ranked.slice(offset, offset + size);
    if (slice.length === 0) break;
    waves.push(slice);
    offset += slice.length;
  }

  return waves;
}

export type AutoEscalationDecision =
  | { action: 'STOP'; reason: 'ENOUGH_OFFERS' | 'NO_MORE_CANDIDATES' }
  | { action: 'NEXT_WAVE' }
  | { action: 'EXPAND_SEARCH' }
  | { action: 'EXCEPTION'; reason: 'AUTOMATION_EXHAUSTED' };

export function decideNextMatchingAction(input: {
  acceptedOffers: number;
  maxOffers: number;
  currentWave: number;
  totalWaves: number;
  expansionAttempted: boolean;
}): AutoEscalationDecision {
  if (input.acceptedOffers >= input.maxOffers) {
    return { action: 'STOP', reason: 'ENOUGH_OFFERS' };
  }

  if (input.currentWave + 1 < input.totalWaves) {
    return { action: 'NEXT_WAVE' };
  }

  if (!input.expansionAttempted) {
    return { action: 'EXPAND_SEARCH' };
  }

  return { action: 'EXCEPTION', reason: 'AUTOMATION_EXHAUSTED' };
}
