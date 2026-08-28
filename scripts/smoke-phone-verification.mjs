const apiBase = process.env.SMOKE_API_URL ?? 'http://127.0.0.1:4000/api/v1';

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

const onboarding = await jsonFetch(`${apiBase}/providers/onboarding/start`, {
  method: 'POST',
  body: JSON.stringify({
    phone: '+77000007777',
    name: 'OTP исполнитель CI',
    citySlug: 'pavlodar',
  }),
});

if (!onboarding.providerId) throw new Error('OTP provider was not created');
if (!onboarding.readiness.missing.includes('PHONE_UNVERIFIED')) {
  throw new Error(`OTP provider did not require phone verification: ${JSON.stringify(onboarding.readiness)}`);
}

const requested = await jsonFetch(
  `${apiBase}/providers/${onboarding.providerId}/phone-verification/request`,
  { method: 'POST', body: '{}' },
);

if (!requested.devCode || !/^\d{6}$/.test(requested.devCode)) {
  throw new Error(`CI verification code was not exposed: ${JSON.stringify(requested)}`);
}
if (requested.delivery?.provider !== 'console') {
  throw new Error(`Expected console SMS driver in CI, got ${JSON.stringify(requested.delivery)}`);
}

let invalidRejected = false;
try {
  await jsonFetch(
    `${apiBase}/providers/${onboarding.providerId}/phone-verification/verify`,
    { method: 'POST', body: JSON.stringify({ code: '000000' }) },
  );
} catch (error) {
  invalidRejected = String(error).includes('invalid verification code');
}
if (!invalidRejected) throw new Error('Invalid OTP was not rejected');

const verified = await jsonFetch(
  `${apiBase}/providers/${onboarding.providerId}/phone-verification/verify`,
  { method: 'POST', body: JSON.stringify({ code: requested.devCode }) },
);

if (!verified.phoneVerified) {
  throw new Error(`Phone was not verified: ${JSON.stringify(verified)}`);
}
if (verified.readiness?.status !== 'VERIFIED' || verified.readiness?.ready) {
  throw new Error(`Unexpected readiness immediately after OTP: ${JSON.stringify(verified.readiness)}`);
}

const profiled = await jsonFetch(
  `${apiBase}/providers/${onboarding.providerId}/onboarding/profile`,
  {
    method: 'PUT',
    body: JSON.stringify({
      citySlug: 'pavlodar',
      latitude: 52.287,
      longitude: 76.967,
      serviceRadiusKm: 10,
      services: [
        {
          categorySlug: 'electrical',
          serviceSlug: 'electrician-callout',
          minPrice: 7000,
          maxPrice: 22000,
        },
      ],
    }),
  },
);

if (!profiled.readiness.ready || profiled.readiness.status !== 'ACTIVE') {
  throw new Error(`OTP provider did not auto-activate after complete profile: ${JSON.stringify(profiled.readiness)}`);
}

const dashboard = await jsonFetch(`${apiBase}/providers/${onboarding.providerId}/dashboard`);
if (!dashboard.provider.user.phoneVerifiedAt) {
  throw new Error('Dashboard does not reflect phone verification');
}
if (dashboard.provider.status !== 'ACTIVE') {
  throw new Error(`Dashboard provider status is ${dashboard.provider.status}, expected ACTIVE`);
}

console.log('SMOKE_PHONE_VERIFICATION_OK', {
  providerId: onboarding.providerId,
  delivery: requested.delivery.provider,
  invalidCodeRejected: invalidRejected,
  status: dashboard.provider.status,
  phoneVerified: Boolean(dashboard.provider.user.phoneVerifiedAt),
});
