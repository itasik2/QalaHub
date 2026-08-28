const mode = process.argv[2];

if (!['api', 'worker'].includes(mode)) {
  throw new Error('Usage: node scripts/validate-production-env.mjs <api|worker>');
}

const required = ['DATABASE_URL', 'REDIS_URL'];
if (mode === 'api') {
  required.push(
    'WEB_ORIGINS',
    'INTERNAL_API_TOKEN',
    'PHONE_VERIFICATION_SECRET',
    'PROVIDER_SESSION_SECRET',
    'MOBIZON_API_KEY',
  );
}

const missing = required.filter((name) => !process.env[name]?.trim());
if (missing.length > 0) {
  throw new Error(`Missing ${mode} production environment variables: ${missing.join(', ')}`);
}

function assertUrl(name, protocols) {
  const value = process.env[name];
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${name} must be a valid URL`);
  }
  if (!protocols.includes(parsed.protocol)) {
    throw new Error(`${name} must use ${protocols.join(' or ')}`);
  }
}

assertUrl('DATABASE_URL', ['postgresql:', 'postgres:']);
assertUrl('REDIS_URL', ['redis:', 'rediss:']);

if (mode === 'api') {
  const origins = process.env.WEB_ORIGINS
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  if (origins.length === 0) throw new Error('WEB_ORIGINS must contain at least one origin');
  for (const origin of origins) {
    assertUrlValue('WEB_ORIGINS', origin, ['https:', 'http:']);
  }

  if ((process.env.SMS_PROVIDER ?? '').toLowerCase() !== 'mobizon') {
    throw new Error('SMS_PROVIDER must be mobizon for production API');
  }

  const secretNames = [
    'INTERNAL_API_TOKEN',
    'PHONE_VERIFICATION_SECRET',
    'PROVIDER_SESSION_SECRET',
  ];
  const secrets = secretNames.map((name) => process.env[name].trim());
  secretNames.forEach((name, index) => {
    if (secrets[index].length < 32) {
      throw new Error(`${name} must contain at least 32 characters`);
    }
  });
  if (new Set(secrets).size !== secrets.length) {
    throw new Error('API secrets must use different values');
  }
}

function assertUrlValue(name, value, protocols) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${name} contains an invalid URL: ${value}`);
  }
  if (!protocols.includes(parsed.protocol)) {
    throw new Error(`${name} contains unsupported protocol: ${parsed.protocol}`);
  }
}

console.log(`PRODUCTION_ENV_OK ${mode}`);
