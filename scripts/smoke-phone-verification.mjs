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

// Regression: starting provider onboarding with an existing customer's phone must not
// mutate that user's name/role before the phone is actually verified.
const existingCustomerPhone = '+77000006666';
await jsonFetch(`${apiBase}/requests`, {
  method: 'POST',
  body: JSON.stringify({
    customerPhone: existingCustomerPhone,
    citySlug: 'pavlodar',
    categorySlug: 'electrical',
    serviceSlug: 'electrician-callout',
    title: 'Проверка customer identity CI',
    description: 'Создаём существующего заказчика перед provider onboarding',
    urgency: 'FLEXIBLE',
    latitude: 52.287,
    longitude: 76.967,
    maxDistanceKm: 10,
  }),
});

const customerUpgrade = await jsonFetch(`${apiBase}/providers/onboarding/start`, {
  method: 'POST',
  body: JSON.stringify({
    phone: existingCustomerPhone,
    name: 'НЕ ДОЛЖНО ЗАПИСАТЬСЯ ДО OTP',
    citySlug: 'pavlodar',
  }),
});
if (!customerUpgrade.providerId) throw new Error('Customer-to-provider onboarding was not created');
if (!customerUpgrade.readiness.missing.includes('PHONE_UNVERIFIED')) {
  throw new Error(`Customer upgrade did not require OTP: ${JSON.stringify(customerUpgrade.readiness)}`);
}

const customerUpgradeCode = await jsonFetch(
  `${apiBase}/providers/${customerUpgrade.providerId}/phone-verification/request`,
  { method: 'POST', body: '{}' },
);
if (!customerUpgradeCode.devCode) throw new Error('Customer upgrade OTP was not exposed in CI');

const customerUpgradeVerified = await jsonFetch(
  `${apiBase}/providers/${customerUpgrade.providerId}/phone-verification/verify`,
  { method: 'POST', body: JSON.stringify({ code: customerUpgradeCode.devCode }) },
);
if (!customerUpgradeVerified.sessionToken) {
  throw new Error('Customer upgrade OTP did not issue provider session');
}

const customerUpgradeDashboard = await jsonFetch(
  `${apiBase}/providers/${customerUpgrade.providerId}/dashboard`,
  { headers: { authorization: `Bearer ${customerUpgradeVerified.sessionToken}` } },
);
if (customerUpgradeDashboard.provider.user.name === 'НЕ ДОЛЖНО ЗАПИСАТЬСЯ ДО OTP') {
  throw new Error('Unauthenticated onboarding mutated existing customer name before OTP');
}
if (customerUpgradeDashboard.provider.user.role !== 'PROVIDER') {
  throw new Error(
    `Verified customer-to-provider upgrade has role ${customerUpgradeDashboard.provider.user.role}`,
  );
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
if (!verified.sessionToken) {
  throw new Error(`OTP did not issue provider session: ${JSON.stringify(verified)}`);
}
if (verified.readiness?.status !== 'VERIFIED' || verified.readiness?.ready) {
  throw new Error(`Unexpected readiness immediately after OTP: ${JSON.stringify(verified.readiness)}`);
}

const auth = { authorization: `Bearer ${verified.sessionToken}` };

let unauthenticatedDashboardRejected = false;
try {
  await jsonFetch(`${apiBase}/providers/${onboarding.providerId}/dashboard`);
} catch (error) {
  unauthenticatedDashboardRejected = /401|provider session is required/i.test(String(error));
}
if (!unauthenticatedDashboardRejected) {
  throw new Error('Provider dashboard did not require an authenticated session');
}

const profiled = await jsonFetch(
  `${apiBase}/providers/${onboarding.providerId}/onboarding/profile`,
  {
    method: 'PUT',
    headers: auth,
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

const dashboard = await jsonFetch(
  `${apiBase}/providers/${onboarding.providerId}/dashboard`,
  { headers: auth },
);
if (!dashboard.provider.user.phoneVerifiedAt) {
  throw new Error('Dashboard does not reflect phone verification');
}
if (dashboard.provider.user.role !== 'PROVIDER') {
  throw new Error(`Dashboard user role is ${dashboard.provider.user.role}, expected PROVIDER`);
}
if (dashboard.provider.status !== 'ACTIVE') {
  throw new Error(`Dashboard provider status is ${dashboard.provider.status}, expected ACTIVE`);
}

console.log('SMOKE_PHONE_VERIFICATION_OK', {
  providerId: onboarding.providerId,
  delivery: requested.delivery.provider,
  invalidCodeRejected: invalidRejected,
  unauthenticatedDashboardRejected,
  existingCustomerNameProtected: customerUpgradeDashboard.provider.user.name !== 'НЕ ДОЛЖНО ЗАПИСАТЬСЯ ДО OTP',
  customerUpgradeRole: customerUpgradeDashboard.provider.user.role,
  sessionIssued: true,
  status: dashboard.provider.status,
  phoneVerified: Boolean(dashboard.provider.user.phoneVerifiedAt),
});
