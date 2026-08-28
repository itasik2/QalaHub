const apiBase = process.env.SMOKE_API_URL ?? 'http://127.0.0.1:4000/api/v1';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(label, fn, { timeoutMs = 15000, intervalMs = 150 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await sleep(intervalMs);
  }
  throw new Error(`${label} timed out${lastError ? `: ${lastError.message}` : ''}`);
}

async function jsonFetch(url, options) {
  const response = await fetch(url, {
    ...options,
    headers: {
      'content-type': 'application/json',
      ...(options?.headers ?? {}),
    },
  });
  const text = await response.text();
  const body = text ? JSON.parse(text) : null;
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}: ${text}`);
  }
  return body;
}

await waitFor('API health', async () => {
  const response = await fetch(`${apiBase}/health`);
  return response.ok;
});

const created = await jsonFetch(`${apiBase}/requests`, {
  method: 'POST',
  body: JSON.stringify({
    customerPhone: '+77000009999',
    citySlug: 'pavlodar',
    categorySlug: 'plumbing',
    serviceSlug: 'plumber-callout',
    title: 'Нужен сантехник',
    description: 'Контрольная заявка CI',
    urgency: 'NOW',
    latitude: 52.287,
    longitude: 76.967,
    maxDistanceKm: 10,
  }),
});

if (!created?.requestId) throw new Error('Request was not created');

const dispatched = await waitFor('first dispatch wave', async () => {
  const request = await jsonFetch(`${apiBase}/requests/${created.requestId}`);
  return request.dispatchAttempts?.length >= 2 ? request : null;
});

const firstAttempt = dispatched.dispatchAttempts[0];
const secondAttemptBeforeMatch = dispatched.dispatchAttempts[1];

if (firstAttempt.round !== 0 || firstAttempt.wave !== 0) {
  throw new Error(`Unexpected first dispatch: round=${firstAttempt.round}, wave=${firstAttempt.wave}`);
}
if (secondAttemptBeforeMatch.provider.consecutiveMisses !== 0) {
  throw new Error('Second provider must start without consecutive misses');
}

await jsonFetch(`${apiBase}/provider-dispatch/${firstAttempt.id}/respond`, {
  method: 'POST',
  body: JSON.stringify({
    response: 'ACCEPTED',
    amountKzt: 10000,
    etaMinutes: 30,
    comment: 'Буду через 30 минут',
  }),
});

const matched = await waitFor('accepted offer and redundant dispatch cancellation', async () => {
  const request = await jsonFetch(`${apiBase}/requests/${created.requestId}`);
  const secondAttempt = request.dispatchAttempts?.find(
    (attempt) => attempt.id === secondAttemptBeforeMatch.id,
  );
  return request.status === 'OFFERS_RECEIVED' &&
    request.offers?.length === 1 &&
    secondAttempt?.response === 'CANCELLED'
    ? request
    : null;
});

if (matched.exceptions?.length !== 0) {
  throw new Error(`Human exception created during successful match: ${JSON.stringify(matched.exceptions)}`);
}

const secondAttemptAfterMatch = matched.dispatchAttempts.find(
  (attempt) => attempt.id === secondAttemptBeforeMatch.id,
);
if (!secondAttemptAfterMatch) throw new Error('Second dispatch attempt disappeared');
if (secondAttemptAfterMatch.response !== 'CANCELLED') {
  throw new Error(`Expected redundant dispatch CANCELLED, got ${secondAttemptAfterMatch.response}`);
}

const eventTypes = new Set((matched.events ?? []).map((event) => event.type));
for (const required of [
  'request.created',
  'matching.started',
  'dispatch.wave.sent',
  'provider.accepted',
  'dispatch.pending.cancelled',
]) {
  if (!eventTypes.has(required)) throw new Error(`Missing event: ${required}`);
}

// The delayed next-wave job is scheduled for 5 seconds in CI. Wait past that point to prove
// the cancelled provider is not later converted to TIMED_OUT or penalized by stale automation.
await sleep(6000);
const afterTimeout = await jsonFetch(`${apiBase}/requests/${created.requestId}`);
const secondAttemptAfterTimeout = afterTimeout.dispatchAttempts.find(
  (attempt) => attempt.id === secondAttemptBeforeMatch.id,
);

if (afterTimeout.dispatchAttempts.length !== 2) {
  throw new Error(`Unexpected extra dispatches after match: ${afterTimeout.dispatchAttempts.length}`);
}
if (secondAttemptAfterTimeout?.response !== 'CANCELLED') {
  throw new Error(`Cancelled dispatch changed after timeout: ${secondAttemptAfterTimeout?.response}`);
}
if (secondAttemptAfterTimeout.provider.consecutiveMisses !== 0) {
  throw new Error(
    `Redundant provider was penalized after match: misses=${secondAttemptAfterTimeout.provider.consecutiveMisses}`,
  );
}
if (afterTimeout.exceptions?.length !== 0) {
  throw new Error(`Human exception appeared after successful match: ${JSON.stringify(afterTimeout.exceptions)}`);
}

console.log('SMOKE_MATCHING_OK', {
  requestId: afterTimeout.id,
  status: afterTimeout.status,
  offers: afterTimeout.offers.length,
  dispatchAttempts: afterTimeout.dispatchAttempts.length,
  cancelledDispatches: afterTimeout.dispatchAttempts.filter((attempt) => attempt.response === 'CANCELLED')
    .length,
  redundantProviderMisses: secondAttemptAfterTimeout.provider.consecutiveMisses,
  exceptions: afterTimeout.exceptions.length,
  selectedProvider: afterTimeout.offers[0].provider.user.name,
  amountKzt: afterTimeout.offers[0].amountKzt,
  etaMinutes: afterTimeout.offers[0].etaMinutes,
});
