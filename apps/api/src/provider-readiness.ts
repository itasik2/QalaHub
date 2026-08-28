import {
  AvailabilityStatus,
  ProviderStatus,
  prisma,
} from '@qalahub/db';

export type ProviderReadinessCode =
  | 'PHONE_UNVERIFIED'
  | 'NAME_REQUIRED'
  | 'CITY_INACTIVE'
  | 'LOCATION_REQUIRED'
  | 'SERVICE_RADIUS_INVALID'
  | 'SERVICE_REQUIRED'
  | 'SERVICE_PRICE_REQUIRED';

export async function syncProviderReadiness(providerId: string) {
  const provider = await prisma.provider.findUnique({
    where: { id: providerId },
    include: {
      user: true,
      city: true,
      services: {
        where: { active: true },
        include: { service: { include: { category: true } } },
      },
    },
  });

  if (!provider) return null;

  const missing: ProviderReadinessCode[] = [];

  if (!provider.user.phone || !provider.user.phoneVerifiedAt) missing.push('PHONE_UNVERIFIED');
  if (!provider.user.name?.trim() || provider.user.name.trim().length < 2) missing.push('NAME_REQUIRED');
  if (!provider.city.active) missing.push('CITY_INACTIVE');
  if (provider.latitude == null || provider.longitude == null) missing.push('LOCATION_REQUIRED');
  if (!Number.isFinite(provider.serviceRadiusKm) || provider.serviceRadiusKm < 1 || provider.serviceRadiusKm > 50) {
    missing.push('SERVICE_RADIUS_INVALID');
  }
  if (provider.services.length === 0) missing.push('SERVICE_REQUIRED');
  if (
    provider.services.some(
      (item) =>
        item.minPrice == null ||
        item.maxPrice == null ||
        item.minPrice < 0 ||
        item.maxPrice < item.minPrice,
    )
  ) {
    missing.push('SERVICE_PRICE_REQUIRED');
  }

  const ready = missing.length === 0;
  const managedStatuses = new Set<ProviderStatus>([
    ProviderStatus.ONBOARDING,
    ProviderStatus.VERIFIED,
    ProviderStatus.ACTIVE,
  ]);

  let desiredStatus = provider.status;
  if (managedStatuses.has(provider.status)) {
    desiredStatus = ready
      ? ProviderStatus.ACTIVE
      : provider.user.phoneVerifiedAt
        ? ProviderStatus.VERIFIED
        : ProviderStatus.ONBOARDING;
  }

  const now = new Date();
  const shouldUpdate =
    desiredStatus !== provider.status ||
    (ready && !provider.onboardingCompletedAt) ||
    (desiredStatus !== ProviderStatus.ACTIVE && provider.availability !== AvailabilityStatus.OFFLINE);

  const updated = shouldUpdate
    ? await prisma.provider.update({
        where: { id: provider.id },
        data: {
          status: desiredStatus,
          ...(ready && !provider.onboardingCompletedAt ? { onboardingCompletedAt: now } : {}),
          ...(desiredStatus !== ProviderStatus.ACTIVE
            ? {
                availability: AvailabilityStatus.OFFLINE,
                availableUntil: null,
                lastAvailabilityChange: now,
              }
            : {}),
        },
        include: {
          user: true,
          city: true,
          services: {
            where: { active: true },
            include: { service: { include: { category: true } } },
          },
        },
      })
    : provider;

  return {
    provider: updated,
    readiness: {
      ready,
      status: updated.status,
      missing,
      nextAction: ready
        ? 'SET_AVAILABILITY'
        : missing[0] ?? null,
    },
  };
}
