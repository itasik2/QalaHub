import {
  AvailabilityStatus,
  DispatchResponse,
  ProviderStatus,
  SupplyNeedStatus,
  prisma,
} from '@qalahub/db';

export type SupplyHealthState = 'HEALTHY' | 'WATCH' | 'NEED_PROVIDERS' | 'CRITICAL' | 'LOW_DEMAND';

function median(values: number[]) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? Math.round((sorted[middle - 1] + sorted[middle]) / 2)
    : Math.round(sorted[middle]);
}

function targetAvailableFromEnv() {
  const parsed = Number(process.env.SUPPLY_HEALTH_TARGET_AVAILABLE ?? 5);
  return Number.isFinite(parsed) ? Math.max(1, Math.min(Math.round(parsed), 50)) : 5;
}

function supplyNeedStatus(health: SupplyHealthState) {
  if (health === 'CRITICAL' || health === 'NEED_PROVIDERS') return SupplyNeedStatus.OPEN;
  if (health === 'WATCH') return SupplyNeedStatus.WATCH;
  return SupplyNeedStatus.RESOLVED;
}

function priorityScore(input: {
  health: SupplyHealthState;
  requests7d: number;
  supplyGap: number;
}) {
  const weight: Record<SupplyHealthState, number> = {
    CRITICAL: 100,
    NEED_PROVIDERS: 70,
    WATCH: 40,
    HEALTHY: 0,
    LOW_DEMAND: 0,
  };
  if (input.health === 'HEALTHY' || input.health === 'LOW_DEMAND') return 0;
  return (
    weight[input.health] +
    Math.min(50, input.requests7d * 5) +
    Math.min(30, input.supplyGap * 10)
  );
}

export async function calculateCitySupplyHealth(citySlug: string) {
  const city = await prisma.city.findUnique({ where: { slug: citySlug } });
  if (!city?.active) return null;

  const now = new Date();
  const since = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const targetAvailable = targetAvailableFromEnv();

  const [categories, providers, recentRequests] = await Promise.all([
    prisma.category.findMany({
      where: { active: true },
      include: { services: { where: { active: true }, select: { id: true } } },
      orderBy: { name: 'asc' },
    }),
    prisma.provider.findMany({
      where: { cityId: city.id },
      include: { services: { where: { active: true }, select: { serviceId: true } } },
    }),
    prisma.request.findMany({
      where: { cityId: city.id, createdAt: { gte: since } },
      select: {
        categoryId: true,
        dispatchAttempts: {
          select: {
            sentAt: true,
            respondedAt: true,
            response: true,
          },
        },
      },
    }),
  ]);

  const categoriesHealth = categories.map((category) => {
    const serviceIds = new Set(category.services.map((service) => service.id));
    const relevantProviders = providers.filter((provider) =>
      provider.services.some((service) => serviceIds.has(service.serviceId)),
    );
    const activeProviders = relevantProviders.filter(
      (provider) => provider.status === ProviderStatus.ACTIVE,
    );
    const availableProviders = activeProviders.filter(
      (provider) =>
        provider.availability === AvailabilityStatus.AVAILABLE &&
        (provider.availableUntil == null || provider.availableUntil > now),
    );

    const categoryRequests = recentRequests.filter(
      (request) => request.categoryId === category.id,
    );
    const attempts = categoryRequests.flatMap((request) => request.dispatchAttempts);
    const accountableAttempts = attempts.filter(
      (attempt) => attempt.response !== DispatchResponse.CANCELLED,
    );
    const answeredAttempts = accountableAttempts.filter(
      (attempt) =>
        attempt.response === DispatchResponse.ACCEPTED ||
        attempt.response === DispatchResponse.DECLINED,
    );
    const responseSeconds = answeredAttempts
      .filter((attempt) => attempt.respondedAt)
      .map((attempt) =>
        Math.max(0, Math.round((attempt.respondedAt!.getTime() - attempt.sentAt.getTime()) / 1000)),
      );

    const responseRate = accountableAttempts.length
      ? answeredAttempts.length / accountableAttempts.length
      : null;
    const medianResponseSeconds = median(responseSeconds);
    const coveragePct = Math.min(
      100,
      Math.round((availableProviders.length / targetAvailable) * 100),
    );
    const supplyGap = Math.max(0, targetAvailable - availableProviders.length);

    let health: SupplyHealthState;
    if (categoryRequests.length === 0) {
      health = 'LOW_DEMAND';
    } else if (activeProviders.length === 0 || availableProviders.length === 0) {
      health = 'CRITICAL';
    } else if (availableProviders.length < Math.min(3, targetAvailable)) {
      health = 'NEED_PROVIDERS';
    } else if (
      coveragePct < 60 ||
      (responseRate != null && responseRate < 0.5) ||
      (medianResponseSeconds != null && medianResponseSeconds > 300)
    ) {
      health = 'WATCH';
    } else {
      health = 'HEALTHY';
    }

    return {
      category: {
        id: category.id,
        slug: category.slug,
        name: category.name,
      },
      health,
      supply: {
        registered: relevantProviders.length,
        active: activeProviders.length,
        availableNow: availableProviders.length,
        targetAvailable,
        supplyGap,
        coveragePct,
      },
      demand: {
        requests7d: categoryRequests.length,
        dispatches7d: attempts.length,
      },
      responsiveness: {
        responseRate: responseRate == null ? null : Number(responseRate.toFixed(3)),
        medianResponseSeconds,
      },
    };
  });

  const priorityRank = { CRITICAL: 0, NEED_PROVIDERS: 1, WATCH: 2 } as const;
  const recruitmentPriorities = categoriesHealth
    .filter((item) => item.health in priorityRank)
    .sort((a, b) => {
      const rankA = priorityRank[a.health as keyof typeof priorityRank];
      const rankB = priorityRank[b.health as keyof typeof priorityRank];
      if (rankA !== rankB) return rankA - rankB;
      if (a.demand.requests7d !== b.demand.requests7d) {
        return b.demand.requests7d - a.demand.requests7d;
      }
      return b.supply.supplyGap - a.supply.supplyGap;
    })
    .map((item) => ({
      categorySlug: item.category.slug,
      categoryName: item.category.name,
      health: item.health,
      availableNow: item.supply.availableNow,
      targetAvailable: item.supply.targetAvailable,
      supplyGap: item.supply.supplyGap,
      requests7d: item.demand.requests7d,
    }));

  return {
    city: { id: city.id, slug: city.slug, name: city.name },
    windowDays: 7,
    generatedAt: now,
    categories: categoriesHealth,
    recruitmentPriorities,
  };
}

export async function reconcileSupplyNeeds(citySlug: string) {
  const health = await calculateCitySupplyHealth(citySlug);
  if (!health) return null;
  const now = new Date();

  for (const item of health.categories) {
    const status = supplyNeedStatus(item.health);
    const score = priorityScore({
      health: item.health,
      requests7d: item.demand.requests7d,
      supplyGap: item.supply.supplyGap,
    });

    await prisma.supplyNeed.upsert({
      where: {
        cityId_categoryId: {
          cityId: health.city.id,
          categoryId: item.category.id,
        },
      },
      update: {
        status,
        health: item.health,
        targetAvailable: item.supply.targetAvailable,
        availableNow: item.supply.availableNow,
        supplyGap: item.supply.supplyGap,
        requests7d: item.demand.requests7d,
        priorityScore: score,
        lastEvaluatedAt: now,
        resolvedAt: status === SupplyNeedStatus.RESOLVED ? now : null,
      },
      create: {
        cityId: health.city.id,
        categoryId: item.category.id,
        status,
        health: item.health,
        targetAvailable: item.supply.targetAvailable,
        availableNow: item.supply.availableNow,
        supplyGap: item.supply.supplyGap,
        requests7d: item.demand.requests7d,
        priorityScore: score,
        lastEvaluatedAt: now,
        resolvedAt: status === SupplyNeedStatus.RESOLVED ? now : null,
      },
    });
  }

  const needs = await prisma.supplyNeed.findMany({
    where: { cityId: health.city.id },
    include: { category: true },
    orderBy: [{ status: 'asc' }, { priorityScore: 'desc' }],
  });

  return { health, needs };
}

export async function reconcileSupplyNeedsByCityId(cityId: string) {
  const city = await prisma.city.findUnique({ where: { id: cityId }, select: { slug: true } });
  return city ? reconcileSupplyNeeds(city.slug) : null;
}
