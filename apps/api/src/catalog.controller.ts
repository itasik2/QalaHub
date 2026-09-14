import { BadRequestException, Controller, Get, Param } from '@nestjs/common';
import { prisma } from '@qalahub/db';
import { getRecommendedPriceRange } from './pricing.js';

@Controller('catalog')
export class CatalogController {
  @Get(':citySlug')
  async cityCatalog(@Param('citySlug') citySlug: string) {
    const city = await prisma.city.findUnique({ where: { slug: citySlug } });
    if (!city?.active) throw new BadRequestException('city not found or inactive');

    const categories = await prisma.category.findMany({
      where: { active: true },
      orderBy: { name: 'asc' },
      include: {
        services: {
          where: { active: true },
          orderBy: { name: 'asc' },
          select: { id: true, slug: true, name: true },
        },
      },
    });

    const withPricing = await Promise.all(
      categories.map(async (category) => ({
        id: category.id,
        slug: category.slug,
        name: category.name,
        requestMode: category.requestMode,
        services: await Promise.all(
          category.services.map(async (service) => ({
            ...service,
            recommendedPrice: await getRecommendedPriceRange({
              cityId: city.id,
              categoryId: category.id,
              serviceId: service.id,
            }),
          })),
        ),
      })),
    );

    return {
      ok: true,
      city: { id: city.id, slug: city.slug, name: city.name },
      categories: withPricing,
    };
  }
}
