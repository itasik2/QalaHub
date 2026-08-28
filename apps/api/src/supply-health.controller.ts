import { BadRequestException, Controller, Get, Param } from '@nestjs/common';
import { SupplyNeedStatus } from '@qalahub/db';
import { reconcileSupplyNeeds } from './supply-health.service.js';

@Controller('supply-health')
export class SupplyHealthController {
  @Get(':citySlug')
  async cityHealth(@Param('citySlug') citySlug: string) {
    const result = await reconcileSupplyNeeds(citySlug);
    if (!result) throw new BadRequestException('city not found or inactive');

    return {
      ok: true,
      ...result.health,
      recruitmentNeeds: result.needs
        .filter((need) => need.status !== SupplyNeedStatus.RESOLVED)
        .sort((a, b) => b.priorityScore - a.priorityScore)
        .map((need) => ({
          id: need.id,
          status: need.status,
          health: need.health,
          categorySlug: need.category.slug,
          categoryName: need.category.name,
          targetAvailable: need.targetAvailable,
          availableNow: need.availableNow,
          supplyGap: need.supplyGap,
          requests7d: need.requests7d,
          priorityScore: need.priorityScore,
          lastEvaluatedAt: need.lastEvaluatedAt,
        })),
      automation: {
        humanDecisionRequired: false,
        rule: 'Recruit first where demand exists and available supply is insufficient.',
      },
    };
  }
}
