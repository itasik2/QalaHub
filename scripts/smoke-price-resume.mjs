import { createHmac } from 'node:crypto';

const apiBase = process.env.SMOKE_API_URL ?? 'http://127.0.0.1:4000/api/v1';
const internalToken = process.env.INTERNAL_API_TOKEN ?? 'ci-internal-token';
const providerSessionSecret =
  process.env.PROVIDER_SESSION_SECRET ??
  process.env.PHONE_VERIFICATION_SECRET ??
  internalToken;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function providerAuthHeaders(providerId) {
  const payload = { providerId, exp: Math.floor(Date.now() / 1000) + 60 * 60 };
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = createHmac('sha256', providerSessionSecret)
    .update(encodedPayload)
    .digest('base64url');
  return { authorization: `Bearer ${encodedPayload}.${signature}` };
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
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}: ${text}`);
  return body;
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

await waitFor('API health', async () => (await fetch(`${apiBase}/health`)).ok);

const catalog = await jsonFetch(`${apiBase}/catalog/pavlodar`);
const plumbing = catalog.categories?.find((category) => category.slug === 'plumbing');
const plumberCallout = plumbing?.services?.find((service) => service.slug === 'plumber-callout');
if (!plumberCallout) throw new Error('plumber-callout missing from Pavlodar catalog');
if (
  plumberCallout.recommendedPrice?.basis !== 'PROVIDER_RANGES' ||
  plumberCallout.recommendedPrice?.minKzt == null ||
  plumberCallout.recommendedPrice?.maxKzt == null
) {
  throw new Error(`Recommended provider price range missing: ${JSON.stringify(plumberCallout)}`);
}

const customerPriceKzt = 7000;
const created = await jsonFetch(`${apiBase}/requests`, {
  method: 'POST',
  body: JSON.stringify({
    customerPhone: '+77000007777',
    citySlug: 'pavlodar',
    categorySlug: 'plumbing',
    serviceSlug: 'plumber-callout',
    title: 'Проверка цены и повторного поиска',
    description: 'Контрольная заявка CI для offer resume',
    urgency: 'NOW',
    latitude: 52.287,
    longitude: 76.967,
    maxDistanceKm: 10,
    customerPriceKzt,
  }),
});

if (!created?.requestId || !created?.accessToken) {
  throw new Error(`Request/access token was not created: ${JSON.stringify(created)}`);
}
if (created.customerPriceKzt !== customerPriceKzt) {
  throw new Error(`Customer price was not stored: ${JSON.stringify(created)}`);
}
if (created.recommendedPrice?.minKzt == null || created.recommendedPrice?.maxKzt == null) {
  throw new Error(`Recommended price snapshot missing: ${JSON.stringify(created)}`);
}

const requestHeaders = { 'x-qalahub-request-token': created.accessToken };
const dispatched = await waitFor('price test first dispatch', async () => {
  const request = await jsonFetch(`${apiBase}/requests/${created.requestId}`, {
    headers: requestHeaders,
  });
  return request.dispatchAttempts?.length > 0 ? request : null;
});

const firstAttempt = dispatched.dispatchAttempts.find((attempt) => attempt.response == null);
if (!firstAttempt) throw new Error('No live dispatch attempt available for price test');

const dashboard = await jsonFetch(`${apiBase}/providers/${firstAttempt.provider.id}/dashboard`, {
  headers: providerAuthHeaders(firstAttempt.provider.id),
});
const dashboardAttempt = dashboard.pendingDispatches?.find((attempt) => attempt.id === firstAttempt.id);
if (!dashboardAttempt) throw new Error('Provider dashboard did not expose pending dispatch');
if (dashboardAttempt.request.customerPriceKzt !== customerPriceKzt) {
  throw new Error(`Provider did not receive customer price: ${JSON.stringify(dashboardAttempt.request)}`);
}
if (!dashboardAttempt.request.description?.includes(`Ориентир заказчика: ${customerPriceKzt} ₸`)) {
  throw new Error(`Provider price context missing: ${dashboardAttempt.request.description}`);
}

await jsonFetch(`${apiBase}/provider-dispatch/${firstAttempt.id}/respond`, {
  method: 'POST',
  headers: providerAuthHeaders(firstAttempt.provider.id),
  body: JSON.stringify({
    response: 'ACCEPTED',
    amountKzt: 12000,
    etaMinutes: 25,
    comment: 'Цена исполнителя выше ориентира заказчика',
  }),
});

const offered = await waitFor('price test offer pause', async () => {
  const request = await jsonFetch(`${apiBase}/requests/${created.requestId}`, {
    headers: requestHeaders,
  });
  const pending = request.offers?.filter((offer) => offer.status === 'PENDING') ?? [];
  return request.status === 'OFFERS_RECEIVED' && pending.length === 1 ? request : null;
});
if (offered.customerPriceKzt !== customerPriceKzt) {
  throw new Error('Customer price disappeared from request state');
}
if (!offered.offerSelectionExpiresAt) {
  throw new Error('Offer selection deadline was not exposed');
}

const attemptsBeforeResume = offered.dispatchAttempts.length;
const rejection = await jsonFetch(`${apiBase}/requests/${created.requestId}/offers/reject-all`, {
  method: 'POST',
  headers: requestHeaders,
  body: JSON.stringify({ reason: 'TOO_EXPENSIVE' }),
});
if (rejection.status !== 'MATCHING' || rejection.matching !== 'RESUMED') {
  throw new Error(`Reject-all did not resume matching: ${JSON.stringify(rejection)}`);
}

const resumed = await waitFor('next dispatch after rejected offers', async () => {
  const request = await jsonFetch(`${apiBase}/requests/${created.requestId}`, {
    headers: requestHeaders,
  });
  return request.dispatchAttempts?.length > attemptsBeforeResume ? request : null;
});

const rejectedOffer = resumed.offers.find((offer) => offer.providerId === firstAttempt.provider.id);
if (rejectedOffer?.status !== 'REJECTED') {
  throw new Error(`Original offer was not rejected: ${JSON.stringify(rejectedOffer)}`);
}
const rejectionEvent = resumed.events?.find((event) => event.type === 'customer.offers_rejected');
if (rejectionEvent?.payload?.reason !== 'TOO_EXPENSIVE') {
  throw new Error(`Rejection reason event missing: ${JSON.stringify(rejectionEvent)}`);
}
const newAttempt = resumed.dispatchAttempts.find(
  (attempt) => attempt.id !== firstAttempt.id && attempt.response == null,
);
if (!newAttempt) {
  throw new Error('Matching resumed without dispatching a new provider');
}

await jsonFetch(`${apiBase}/requests/${created.requestId}/cancel`, {
  method: 'POST',
  headers: requestHeaders,
  body: JSON.stringify({ reason: 'CI cleanup after price/resume smoke' }),
});

console.log(
  JSON.stringify({
    ok: true,
    requestId: created.requestId,
    customerPriceKzt,
    recommendedPrice: created.recommendedPrice,
    rejectedOfferId: rejectedOffer.id,
    newDispatchAttemptId: newAttempt.id,
  }),
);
