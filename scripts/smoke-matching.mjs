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
if (firstAttempt.round !== 0 || firstAttempt.wave !== 0) {
  throw new Error(`Unexpected first dispatch: round=${firstAttempt.round}, wave=${firstAttempt.wave}`);
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

const matched = await waitFor('accepted offer', async () => {
  const request = await jsonFetch(`${apiBase}/requests/${created.requestId}`);
  return request.status === 'OFFERS_RECEIVED' && request.offers?.length === 1 ? request : null;
});

if (matched.exceptions?.length !== 0) {
  throw new Error(`Human exception created during successful match: ${JSON.stringify(matched.exceptions)}`);
}

const eventTypes = new Set((matched.events ?? []).map((event) => event.type));
for (const required of ['request.created', 'matching.started', 'dispatch.wave.sent', 'provider.accepted']) {
  if (!eventTypes.has(required)) throw new Error(`Missing event: ${required}`);
}

console.log('SMOKE_MATCHING_OK', {
  requestId: matched.id,
  status: matched.status,
  offers: matched.offers.length,
  dispatchAttempts: matched.dispatchAttempts.length,
  exceptions: matched.exceptions.length,
  selectedProvider: matched.offers[0].provider.user.name,
  amountKzt: matched.offers[0].amountKzt,
  etaMinutes: matched.offers[0].etaMinutes,
});
