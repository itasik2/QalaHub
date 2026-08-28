const apiBase = process.env.SMOKE_API_URL ?? 'http://127.0.0.1:4000/api/v1';
const internalToken = process.env.INTERNAL_API_TOKEN ?? 'ci-internal-token';

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

const providerId = secondAttemptAfterTimeout.provider.id;
const offline = await jsonFetch(`${apiBase}/providers/${providerId}/availability`, {
  method: 'POST',
  body: JSON.stringify({ status: 'OFFLINE' }),
});
if (offline.provider.availability !== 'OFFLINE' || offline.provider.availableUntil !== null) {
  throw new Error('Provider OFFLINE self-service update failed');
}

const available = await jsonFetch(`${apiBase}/providers/${providerId}/availability`, {
  method: 'POST',
  body: JSON.stringify({ status: 'AVAILABLE', minutes: 30 }),
});
if (available.provider.availability !== 'AVAILABLE' || !available.provider.availableUntil) {
  throw new Error('Provider AVAILABLE self-service update failed');
}
if (available.provider.consecutiveMisses !== 0) {
  throw new Error('Provider reactivation must clear consecutive misses');
}

const selectedOffer = afterTimeout.offers[0];
const providerJobsBeforeSelection = selectedOffer.provider.activeJobs;
const selection = await jsonFetch(
  `${apiBase}/requests/${created.requestId}/offers/${selectedOffer.id}/select`,
  { method: 'POST', body: '{}' },
);
if (selection.status !== 'CONFIRMED' || selection.order.providerId !== selectedOffer.providerId) {
  throw new Error(`Offer selection failed: ${JSON.stringify(selection)}`);
}

const confirmed = await jsonFetch(`${apiBase}/requests/${created.requestId}`);
if (confirmed.status !== 'CONFIRMED' || !confirmed.order) {
  throw new Error('Confirmed order is missing from request state');
}
if (confirmed.order.offerId !== selectedOffer.id || confirmed.order.providerId !== selectedOffer.providerId) {
  throw new Error('Order does not reference selected offer/provider');
}
const finalSelectedOffer = confirmed.offers.find((offer) => offer.id === selectedOffer.id);
if (finalSelectedOffer?.status !== 'SELECTED') {
  throw new Error(`Selected offer has invalid status: ${finalSelectedOffer?.status}`);
}
if (finalSelectedOffer.provider.activeJobs !== providerJobsBeforeSelection + 1) {
  throw new Error(
    `Provider activeJobs was not incremented: before=${providerJobsBeforeSelection}, after=${finalSelectedOffer.provider.activeJobs}`,
  );
}
if (!confirmed.events.some((event) => event.type === 'offer.selected')) {
  throw new Error('Missing offer.selected event');
}
if (confirmed.exceptions?.length !== 0) {
  throw new Error(`Human exception appeared after order confirmation: ${JSON.stringify(confirmed.exceptions)}`);
}

// Self-service onboarding: profile starts incomplete and must not become ACTIVE merely because
// a client knows the phone number. Phone verification is accepted only through the internal hook.
const onboarding = await jsonFetch(`${apiBase}/providers/onboarding/start`, {
  method: 'POST',
  body: JSON.stringify({
    phone: '+77000008888',
    name: 'Новый сантехник CI',
    citySlug: 'pavlodar',
  }),
});
if (onboarding.readiness.status !== 'ONBOARDING') {
  throw new Error(`New provider activated too early: ${JSON.stringify(onboarding.readiness)}`);
}
if (!onboarding.readiness.missing.includes('PHONE_UNVERIFIED')) {
  throw new Error('Onboarding must require verified phone');
}

const phoneVerified = await jsonFetch(
  `${apiBase}/internal/providers/${onboarding.providerId}/phone-verified`,
  {
    method: 'POST',
    headers: { 'x-qalahub-internal-token': internalToken },
    body: '{}',
  },
);
if (phoneVerified.readiness.status !== 'VERIFIED' || phoneVerified.readiness.ready) {
  throw new Error(`Phone verification readiness is invalid: ${JSON.stringify(phoneVerified.readiness)}`);
}

const profiled = await jsonFetch(
  `${apiBase}/providers/${onboarding.providerId}/onboarding/profile`,
  {
    method: 'PUT',
    body: JSON.stringify({
      citySlug: 'pavlodar',
      latitude: 52.287,
      longitude: 76.967,
      serviceRadiusKm: 12,
      services: [
        {
          categorySlug: 'plumbing',
          serviceSlug: 'plumber-callout',
          minPrice: 6000,
          maxPrice: 18000,
        },
      ],
    }),
  },
);
if (!profiled.readiness.ready || profiled.readiness.status !== 'ACTIVE') {
  throw new Error(`Complete provider profile did not auto-activate: ${JSON.stringify(profiled.readiness)}`);
}

const onboardedAvailable = await jsonFetch(
  `${apiBase}/providers/${onboarding.providerId}/availability`,
  {
    method: 'POST',
    body: JSON.stringify({ status: 'AVAILABLE', minutes: 60 }),
  },
);
if (onboardedAvailable.provider.availability !== 'AVAILABLE') {
  throw new Error('Onboarded provider could not self-activate availability');
}

// Create demand in a deliberately thin category. Supply Health should identify it automatically
// as a recruitment priority without an administrator curating a spreadsheet.
const electricalDemand = await jsonFetch(`${apiBase}/requests`, {
  method: 'POST',
  body: JSON.stringify({
    customerPhone: '+77000009999',
    citySlug: 'pavlodar',
    categorySlug: 'electrical',
    serviceSlug: 'electrician-callout',
    title: 'Нужен электрик',
    description: 'Контроль спроса для Supply Health',
    urgency: 'NOW',
    latitude: 52.287,
    longitude: 76.967,
    maxDistanceKm: 10,
  }),
});
if (!electricalDemand.requestId) throw new Error('Electrical demand request was not created');

const supplyHealth = await waitFor('supply health metrics', async () => {
  const health = await jsonFetch(`${apiBase}/supply-health/pavlodar`);
  const plumbing = health.categories.find((item) => item.category.slug === 'plumbing');
  const electrical = health.categories.find((item) => item.category.slug === 'electrical');
  return plumbing?.supply.registered >= 11 && electrical?.demand.requests7d >= 1
    ? health
    : null;
});

const plumbingHealth = supplyHealth.categories.find((item) => item.category.slug === 'plumbing');
const electricalHealth = supplyHealth.categories.find((item) => item.category.slug === 'electrical');
if (!plumbingHealth || plumbingHealth.supply.availableNow < 5) {
  throw new Error(`Plumbing supply did not include onboarded provider: ${JSON.stringify(plumbingHealth)}`);
}
if (!electricalHealth || !['NEED_PROVIDERS', 'CRITICAL'].includes(electricalHealth.health)) {
  throw new Error(`Thin electrical supply was not detected: ${JSON.stringify(electricalHealth)}`);
}
if (!supplyHealth.recruitmentPriorities.some((item) => item.categorySlug === 'electrical')) {
  throw new Error('Electrical category missing from automatic recruitment priorities');
}

console.log('SMOKE_MATCHING_OK', {
  requestId: confirmed.id,
  status: confirmed.status,
  orderId: confirmed.order.id,
  offers: confirmed.offers.length,
  dispatchAttempts: confirmed.dispatchAttempts.length,
  cancelledDispatches: confirmed.dispatchAttempts.filter((attempt) => attempt.response === 'CANCELLED')
    .length,
  redundantProviderMisses: secondAttemptAfterTimeout.provider.consecutiveMisses,
  availabilitySelfService: available.provider.availability,
  exceptions: confirmed.exceptions.length,
  selectedProvider: confirmed.order.provider.user.name,
  amountKzt: confirmed.order.offer.amountKzt,
  etaMinutes: confirmed.order.offer.etaMinutes,
  onboarding: {
    providerId: onboarding.providerId,
    status: profiled.readiness.status,
    ready: profiled.readiness.ready,
    availability: onboardedAvailable.provider.availability,
  },
  supplyHealth: {
    plumbingAvailable: plumbingHealth.supply.availableNow,
    electricalHealth: electricalHealth.health,
    electricalGap: electricalHealth.supply.supplyGap,
  },
});
