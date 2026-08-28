import { BadRequestException, Controller, Get, Param } from '@nestjs/common';
import { prisma } from '@qalahub/db';

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

    return {
      ok: true,
      city: { id: city.id, slug: city.slug, name: city.name },
      categories: categories.map((category) => ({
        id: category.id,
        slug: category.slug,
        name: category.name,
        requestMode: category.requestMode,
        services: category.services,
      })),
    };
  }
}
