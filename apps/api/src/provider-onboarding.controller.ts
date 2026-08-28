import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Post,
  Put,
} from '@nestjs/common';
import {
  AvailabilityStatus,
  ProviderStatus,
  UserRole,
  prisma,
} from '@qalahub/db';
import { syncProviderReadiness } from './provider-readiness.js';

class StartProviderOnboardingDto {
  phone!: string;
  name!: string;
  citySlug!: string;
}

class ProviderServiceDto {
  categorySlug!: string;
  serviceSlug!: string;
  minPrice!: number;
  maxPrice!: number;
}

class UpdateProviderProfileDto {
  name?: string;
  citySlug!: string;
  latitude!: number;
  longitude!: number;
  serviceRadiusKm!: number;
  services!: ProviderServiceDto[];
}

@Controller('providers')
export class ProviderOnboardingController {
  @Post('onboarding/start')
  async start(@Body() body: StartProviderOnboardingDto) {
    const phone = body.phone?.trim();
    const name = body.name?.trim();
    if (!phone || !/^\+?[0-9]{10,15}$/.test(phone)) {
      throw new BadRequestException('valid phone is required');
    }
    if (!name || name.length < 2) throw new BadRequestException('name is required');
    if (!body.citySlug) throw new BadRequestException('citySlug is required');

    const city = await prisma.city.findUnique({ where: { slug: body.citySlug } });
    if (!city?.active) throw new BadRequestException('city not found or inactive');

    const existingUser = await prisma.user.findUnique({
      where: { phone },
      include: { provider: true },
    });

    let providerId: string;

    if (existingUser?.provider) {
      await prisma.$transaction([
        prisma.user.update({
          where: { id: existingUser.id },
          data: {
            name,
            ...(existingUser.role === UserRole.CUSTOMER ? { role: UserRole.PROVIDER } : {}),
          },
        }),
        prisma.provider.update({
          where: { id: existingUser.provider.id },
          data: {
            cityId: city.id,
            ...(existingUser.provider.status === ProviderStatus.DORMANT
              ? { status: ProviderStatus.ONBOARDING }
              : {}),
          },
        }),
      ]);
      providerId = existingUser.provider.id;
    } else {
      const result = await prisma.$transaction(async (tx) => {
        const user = existingUser
          ? await tx.user.update({
              where: { id: existingUser.id },
              data: {
                name,
                ...(existingUser.role === UserRole.CUSTOMER ? { role: UserRole.PROVIDER } : {}),
              },
            })
          : await tx.user.create({
              data: { phone, name, role: UserRole.PROVIDER },
            });

        return tx.provider.create({
          data: {
            userId: user.id,
            cityId: city.id,
            status: ProviderStatus.ONBOARDING,
            availability: AvailabilityStatus.OFFLINE,
          },
        });
      });
      providerId = result.id;
    }

    const state = await syncProviderReadiness(providerId);
    if (!state) throw new BadRequestException('provider could not be created');

    return {
      ok: true,
      providerId,
      readiness: state.readiness,
    };
  }

  @Put(':providerId/onboarding/profile')
  async updateProfile(
    @Param('providerId') providerId: string,
    @Body() body: UpdateProviderProfileDto,
  ) {
    const provider = await prisma.provider.findUnique({ where: { id: providerId } });
    if (!provider) throw new BadRequestException('provider not found');
    if (provider.status === ProviderStatus.BLOCKED) {
      throw new BadRequestException('blocked provider cannot update onboarding profile');
    }

    const city = await prisma.city.findUnique({ where: { slug: body.citySlug } });
    if (!city?.active) throw new BadRequestException('city not found or inactive');

    if (!Number.isFinite(body.latitude) || body.latitude < -90 || body.latitude > 90) {
      throw new BadRequestException('latitude must be from -90 to 90');
    }
    if (!Number.isFinite(body.longitude) || body.longitude < -180 || body.longitude > 180) {
      throw new BadRequestException('longitude must be from -180 to 180');
    }
    if (
      !Number.isFinite(body.serviceRadiusKm) ||
      body.serviceRadiusKm < 1 ||
      body.serviceRadiusKm > 50
    ) {
      throw new BadRequestException('serviceRadiusKm must be from 1 to 50');
    }
    if (!Array.isArray(body.services) || body.services.length === 0) {
      throw new BadRequestException('at least one service is required');
    }

    const resolvedServices: Array<{
      serviceId: string;
      minPrice: number;
      maxPrice: number;
    }> = [];
    const seen = new Set<string>();

    for (const item of body.services) {
      if (
        !Number.isInteger(item.minPrice) ||
        !Number.isInteger(item.maxPrice) ||
        item.minPrice < 0 ||
        item.maxPrice < item.minPrice
      ) {
        throw new BadRequestException('service prices must be valid integer KZT ranges');
      }

      const service = await prisma.service.findFirst({
        where: {
          slug: item.serviceSlug,
          active: true,
          category: { slug: item.categorySlug, active: true },
        },
      });
      if (!service) {
        throw new BadRequestException(
          `service not found or inactive: ${item.categorySlug}/${item.serviceSlug}`,
        );
      }
      if (seen.has(service.id)) continue;
      seen.add(service.id);
      resolvedServices.push({
        serviceId: service.id,
        minPrice: item.minPrice,
        maxPrice: item.maxPrice,
      });
    }

    await prisma.$transaction(async (tx) => {
      if (body.name?.trim()) {
        await tx.user.update({
          where: { id: provider.userId },
          data: { name: body.name.trim() },
        });
      }

      await tx.provider.update({
        where: { id: providerId },
        data: {
          cityId: city.id,
          latitude: body.latitude,
          longitude: body.longitude,
          serviceRadiusKm: body.serviceRadiusKm,
        },
      });

      await tx.providerService.deleteMany({
        where: {
          providerId,
          serviceId: { notIn: resolvedServices.map((item) => item.serviceId) },
        },
      });

      for (const item of resolvedServices) {
        await tx.providerService.upsert({
          where: {
            providerId_serviceId: { providerId, serviceId: item.serviceId },
          },
          update: {
            active: true,
            minPrice: item.minPrice,
            maxPrice: item.maxPrice,
          },
          create: {
            providerId,
            serviceId: item.serviceId,
            active: true,
            minPrice: item.minPrice,
            maxPrice: item.maxPrice,
          },
        });
      }
    });

    const state = await syncProviderReadiness(providerId);
    if (!state) throw new BadRequestException('provider not found after update');

    return {
      ok: true,
      providerId,
      readiness: state.readiness,
      provider: state.provider,
    };
  }

  @Get(':providerId/readiness')
  async readiness(@Param('providerId') providerId: string) {
    const state = await syncProviderReadiness(providerId);
    if (!state) throw new BadRequestException('provider not found');
    return {
      ok: true,
      providerId,
      readiness: state.readiness,
    };
  }
}
