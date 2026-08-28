import { createHmac } from 'node:crypto';

const apiBase = process.env.SMOKE_API_URL ?? 'http://127.0.0.1:4000/api/v1';
const internalToken = process.env.INTERNAL_API_TOKEN ?? 'ci-internal-token';
const providerSessionSecret =
  process.env.PROVIDER_SESSION_SECRET ??
  process.env.PHONE_VERIFICATION_SECRET ??
  internalToken;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function providerAuthHeaders(providerId) {
  const payload = {
    providerId,
    exp: Math.floor(Date.now() / 1000) + 60 * 60,
  };
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = createHmac('sha256', providerSessionSecret)
    .update(encodedPayload)
    .digest('base64url');
  return { authorization: `Bearer ${encodedPayload}.${signature}` };
}

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

if (!created?.requestId || !created?.accessToken) {
  throw new Error(`Request/access token was not created: ${JSON.stringify(created)}`);
}
const requestAccessHeaders = { 'x-qalahub-request-token': created.accessToken };

let unauthenticatedRequestRejected = false;
try {
  await jsonFetch(`${apiBase}/requests/${created.requestId}`);
} catch (error) {
  unauthenticatedRequestRejected = /401|request access token is required/i.test(String(error));
}
if (!unauthenticatedRequestRejected) {
  throw new Error('Request state did not require customer access token');
}

const dispatched = await waitFor('first dispatch wave', async () => {
  const request = await jsonFetch(`${apiBase}/requests/${created.requestId}`, {
    headers: requestAccessHeaders,
  });
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
  headers: providerAuthHeaders(firstAttempt.provider.id),
  body: JSON.stringify({
    response: 'ACCEPTED',
    amountKzt: 10000,
    etaMinutes: 30,
    comment: 'Буду через 30 минут',
  }),
});

const matched = await waitFor('accepted offer and redundant dispatch cancellation', async () => {
  const request = await jsonFetch(`${apiBase}/requests/${created.requestId}`, {
    headers: requestAccessHeaders,
  });
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

await sleep(6000);
const afterTimeout = await jsonFetch(`${apiBase}/requests/${created.requestId}`, {
  headers: requestAccessHeaders,
});
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
  headers: providerAuthHeaders(providerId),
  body: JSON.stringify({ status: 'OFFLINE' }),
});
if (offline.provider.availability !== 'OFFLINE' || offline.provider.availableUntil !== null) {
  throw new Error('Provider OFFLINE self-service update failed');
}

const available = await jsonFetch(`${apiBase}/providers/${providerId}/availability`, {
  method: 'POST',
  headers: providerAuthHeaders(providerId),
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
  {
    method: 'POST',
    headers: requestAccessHeaders,
    body: '{}',
  },
);
if (selection.status !== 'CONFIRMED' || selection.order.providerId !== selectedOffer.providerId) {
  throw new Error(`Offer selection failed: ${JSON.stringify(selection)}`);
}

const confirmed = await jsonFetch(`${apiBase}/requests/${created.requestId}`, {
  headers: requestAccessHeaders,
});
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
if (finalSelectedOffer.provider.availability !== 'BUSY') {
  throw new Error(`Selected provider must become BUSY, got ${finalSelectedOffer.provider.availability}`);
}
if (!confirmed.events.some((event) => event.type === 'offer.selected')) {
  throw new Error('Missing offer.selected event');
}
if (confirmed.exceptions?.length !== 0) {
  throw new Error(`Human exception appeared after order confirmation: ${JSON.stringify(confirmed.exceptions)}`);
}

const started = await jsonFetch(
  `${apiBase}/providers/${selectedOffer.providerId}/orders/${selection.order.id}/start`,
  {
    method: 'POST',
    headers: providerAuthHeaders(selectedOffer.providerId),
    body: '{}',
  },
);
if (started.status !== 'IN_PROGRESS' || started.order.status !== 'IN_PROGRESS') {
  throw new Error(`Order start failed: ${JSON.stringify(started)}`);
}

const inProgress = await jsonFetch(`${apiBase}/requests/${created.requestId}`, {
  headers: requestAccessHeaders,
});
if (inProgress.status !== 'IN_PROGRESS' || inProgress.order?.status !== 'IN_PROGRESS') {
  throw new Error('Request/order did not enter IN_PROGRESS together');
}
if (!inProgress.events.some((event) => event.type === 'order.started')) {
  throw new Error('Missing order.started event');
}

const completedAction = await jsonFetch(
  `${apiBase}/providers/${selectedOffer.providerId}/orders/${selection.order.id}/complete`,
  {
    method: 'POST',
    headers: providerAuthHeaders(selectedOffer.providerId),
    body: '{}',
  },
);
if (completedAction.status !== 'COMPLETED' || completedAction.order.status !== 'COMPLETED') {
  throw new Error(`Order completion failed: ${JSON.stringify(completedAction)}`);
}
if (completedAction.provider.activeJobs !== providerJobsBeforeSelection) {
  throw new Error(
    `Provider activeJobs did not return to baseline: before=${providerJobsBeforeSelection}, after=${completedAction.provider.activeJobs}`,
  );
}
if (completedAction.provider.availability !== 'AVAILABLE') {
  throw new Error(
    `Provider should resume AVAILABLE inside availability window, got ${completedAction.provider.availability}`,
  );
}

const completed = await jsonFetch(`${apiBase}/requests/${created.requestId}`, {
  headers: requestAccessHeaders,
});
if (completed.status !== 'COMPLETED' || completed.order?.status !== 'COMPLETED') {
  throw new Error('Request/order did not enter COMPLETED together');
}
if (!completed.events.some((event) => event.type === 'order.completed')) {
  throw new Error('Missing order.completed event');
}
if (completed.exceptions?.length !== 0) {
  throw new Error(`Human exception appeared after completed order: ${JSON.stringify(completed.exceptions)}`);
}

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
    headers: providerAuthHeaders(onboarding.providerId),
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
    headers: providerAuthHeaders(onboarding.providerId),
    body: JSON.stringify({ status: 'AVAILABLE', minutes: 60 }),
  },
);
if (onboardedAvailable.provider.availability !== 'AVAILABLE') {
  throw new Error('Onboarded provider could not self-activate availability');
}

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
if (!electricalDemand.requestId || !electricalDemand.accessToken) {
  throw new Error('Electrical demand request was not created with access token');
}

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
  throw new Error(`Plumbing supply did not restore completed provider: ${JSON.stringify(plumbingHealth)}`);
}
if (!electricalHealth || !['NEED_PROVIDERS', 'CRITICAL'].includes(electricalHealth.health)) {
  throw new Error(`Thin electrical supply was not detected: ${JSON.stringify(electricalHealth)}`);
}
if (!supplyHealth.recruitmentPriorities.some((item) => item.categorySlug === 'electrical')) {
  throw new Error('Electrical category missing from automatic recruitment priorities');
}

const electricalNeed = supplyHealth.recruitmentNeeds?.find(
  (need) => need.categorySlug === 'electrical',
);
if (!electricalNeed) {
  throw new Error(`Persistent electrical recruitment need missing: ${JSON.stringify(supplyHealth.recruitmentNeeds)}`);
}
if (electricalNeed.status !== 'OPEN') {
  throw new Error(`Electrical recruitment need must be OPEN, got ${electricalNeed.status}`);
}
if (electricalNeed.priorityScore <= 0 || electricalNeed.supplyGap <= 0) {
  throw new Error(`Electrical recruitment need priority is invalid: ${JSON.stringify(electricalNeed)}`);
}

console.log('SMOKE_MATCHING_OK', {
  requestId: completed.id,
  status: completed.status,
  orderId: completed.order.id,
  orderStatus: completed.order.status,
  offers: completed.offers.length,
  dispatchAttempts: completed.dispatchAttempts.length,
  cancelledDispatches: completed.dispatchAttempts.filter((attempt) => attempt.response === 'CANCELLED')
    .length,
  unauthenticatedRequestRejected,
  redundantProviderMisses: secondAttemptAfterTimeout.provider.consecutiveMisses,
  availabilitySelfService: available.provider.availability,
  selectedProviderAvailability: finalSelectedOffer.provider.availability,
  providerAvailabilityAfterCompletion: completedAction.provider.availability,
  exceptions: completed.exceptions.length,
  selectedProvider: completed.order.provider.user.name,
  amountKzt: completed.order.offer.amountKzt,
  etaMinutes: completed.order.offer.etaMinutes,
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
    electricalNeedId: electricalNeed.id,
    electricalNeedStatus: electricalNeed.status,
    electricalNeedPriority: electricalNeed.priorityScore,
  },
});
