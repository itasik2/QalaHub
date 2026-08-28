import { BadRequestException, Controller, Get, Param } from '@nestjs/common';
import {
  AvailabilityStatus,
  DispatchResponse,
  ProviderStatus,
  prisma,
} from '@qalahub/db';

function median(values: number[]) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? Math.round((sorted[middle - 1] + sorted[middle]) / 2)
    : Math.round(sorted[middle]);
}

@Controller('supply-health')
export class SupplyHealthController {
  @Get(':citySlug')
  async cityHealth(@Param('citySlug') citySlug: string) {
    const city = await prisma.city.findUnique({ where: { slug: citySlug } });
    if (!city?.active) throw new BadRequestException('city not found or inactive');

    const now = new Date();
    const since = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const targetAvailable = Math.max(
      1,
      Math.min(Number(process.env.SUPPLY_HEALTH_TARGET_AVAILABLE ?? 5), 50),
    );

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

    const categoryHealth = categories.map((category) => {
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

      let health: 'HEALTHY' | 'WATCH' | 'NEED_PROVIDERS' | 'CRITICAL' | 'LOW_DEMAND';
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
    const recruitmentPriorities = categoryHealth
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
      ok: true,
      city: { id: city.id, slug: city.slug, name: city.name },
      windowDays: 7,
      generatedAt: now,
      categories: categoryHealth,
      recruitmentPriorities,
      automation: {
        humanDecisionRequired: false,
        rule: 'Recruit first where demand exists and available supply is insufficient.',
      },
    };
  }
}
