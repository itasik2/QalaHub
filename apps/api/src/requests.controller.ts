import { BadRequestException, Body, Controller, Get, Headers, Param, Post } from '@nestjs/common';
import { OfferStatus, prisma, RequestUrgency, UserRole } from '@qalahub/db';
import { MatchingQueueService } from './matching-queue.service.js';
import {
  expireOfferSelectionIfNeeded,
  getOfferSelectionDeadline,
  offerSelectionTimeoutSeconds,
} from './offer-selection-window.js';
import { getRecommendedPriceRange } from './pricing.js';
import { createRequestAccessToken, requireRequestAccess } from './request-access.js';
import { reconcileSupplyNeedsByCityId } from './supply-health.service.js';

class CreateRequestDto {
  customerPhone!: string;
  citySlug!: string;
  categorySlug!: string;
  serviceSlug?: string;
  title!: string;
  description?: string;
  urgency?: RequestUrgency;
  latitude?: number;
  longitude?: number;
  maxDistanceKm?: number;
  customerPriceKzt?: number;
}

@Controller('requests')
export class RequestsController {
  constructor(private readonly matchingQueue: MatchingQueueService) {}

  private loadRequest(id: string) {
    return prisma.request.findUnique({
      where: { id },
      include: {
        offers: {
          orderBy: { createdAt: 'asc' as const },
          include: {
            provider: {
              select: {
                id: true,
                rating: true,
                activeJobs: true,
                user: { select: { name: true } },
              },
            },
          },
        },
        dispatchAttempts: {
          orderBy: [
            { round: 'asc' as const },
            { wave: 'asc' as const },
            { sentAt: 'asc' as const },
          ],
          include: {
            provider: {
              select: {
                id: true,
                consecutiveMisses: true,
              },
            },
          },
        },
        order: {
          include: {
            offer: true,
            provider: {
              select: {
                id: true,
                user: { select: { name: true } },
              },
            },
          },
        },
        events: { orderBy: { createdAt: 'asc' as const } },
        exceptions: { orderBy: { createdAt: 'asc' as const } },
      },
    });
  }

  @Post()
  async create(@Body() body: CreateRequestDto) {
    const customerPhone = body.customerPhone?.trim();
    const title = body.title?.trim();
    if (!customerPhone || !body.citySlug || !body.categorySlug || !title) {
      throw new BadRequestException('customerPhone, citySlug, categorySlug and title are required');
    }
    if (!/^\+?[0-9]{10,15}$/.test(customerPhone)) {
      throw new BadRequestException('customerPhone must contain 10 to 15 digits');
    }

    const customerPriceKzt = body.customerPriceKzt == null ? null : Number(body.customerPriceKzt);
    if (
      customerPriceKzt != null &&
      (!Number.isInteger(customerPriceKzt) || customerPriceKzt < 500 || customerPriceKzt > 100_000_000)
    ) {
      throw new BadRequestException('customerPriceKzt must be an integer between 500 and 100000000');
    }

    const [customer, city, category] = await Promise.all([
      prisma.user.upsert({
        where: { phone: customerPhone },
        update: {},
        create: { phone: customerPhone, role: UserRole.CUSTOMER },
      }),
      prisma.city.findUnique({ where: { slug: body.citySlug } }),
      prisma.category.findUnique({ where: { slug: body.categorySlug } }),
    ]);

    if (!city?.active) throw new BadRequestException('city not found or inactive');
    if (!category?.active) throw new BadRequestException('category not found or inactive');

    const service = body.serviceSlug
      ? await prisma.service.findUnique({
          where: { categoryId_slug: { categoryId: category.id, slug: body.serviceSlug } },
        })
      : null;

    if (body.serviceSlug && !service?.active) {
      throw new BadRequestException('service not found or inactive');
    }

    const recommendedPrice = await getRecommendedPriceRange({
      cityId: city.id,
      categoryId: category.id,
      serviceId: service?.id,
    });

    const access = createRequestAccessToken();
    const request = await prisma.request.create({
      data: {
        customerId: customer.id,
        cityId: city.id,
        categoryId: category.id,
        serviceId: service?.id,
        title,
        description: body.description?.trim() || null,
        urgency: body.urgency ?? RequestUrgency.TODAY,
        latitude: body.latitude,
        longitude: body.longitude,
        maxDistanceKm: Math.max(1, Math.min(body.maxDistanceKm ?? 10, 50)),
        customerPriceKzt,
        recommendedMinPriceKzt: recommendedPrice.minKzt,
        recommendedMaxPriceKzt: recommendedPrice.maxKzt,
        accessTokenHash: access.hash,
        events: {
          create: {
            type: 'request.created',
            payload: {
              citySlug: city.slug,
              categorySlug: category.slug,
              serviceSlug: service?.slug ?? null,
              customerPriceKzt,
              recommendedPrice,
            },
          },
        },
      },
    });

    await Promise.all([
      this.matchingQueue.start(request.id),
      reconcileSupplyNeedsByCityId(city.id),
    ]);

    return {
      ok: true,
      requestId: request.id,
      accessToken: access.token,
      status: request.status,
      matching: 'QUEUED',
      customerPriceKzt: request.customerPriceKzt,
      recommendedPrice: {
        minKzt: request.recommendedMinPriceKzt,
        maxKzt: request.recommendedMaxPriceKzt,
        sampleSize: recommendedPrice.sampleSize,
        basis: recommendedPrice.basis,
      },
    };
  }

  @Get(':id')
  async get(
    @Param('id') id: string,
    @Headers('x-qalahub-request-token') accessToken?: string,
  ) {
    let request = await this.loadRequest(id);
    if (!request) throw new BadRequestException('request not found');
    requireRequestAccess(request.accessTokenHash, accessToken);

    const expiration = await expireOfferSelectionIfNeeded(id);
    if (expiration.expired) {
      request = await this.loadRequest(id);
      if (!request) throw new BadRequestException('request not found');
    }

    const pendingOffers = request.offers.filter((offer) => offer.status === OfferStatus.PENDING).length;
    const selectionDeadline = getOfferSelectionDeadline({
      status: request.status,
      firstOfferAt: request.firstOfferAt,
      pendingOffers,
    });

    const { accessTokenHash: _accessTokenHash, ...publicRequest } = request;
    return {
      ...publicRequest,
      offerSelectionExpiresAt: selectionDeadline,
      offerSelectionTimeoutSeconds,
    };
  }
}
