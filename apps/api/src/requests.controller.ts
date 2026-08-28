import { BadRequestException, Body, Controller, Get, Param, Post } from '@nestjs/common';
import { prisma, RequestUrgency, UserRole } from '@qalahub/db';
import { MatchingQueueService } from './matching-queue.service.js';
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
}

@Controller('requests')
export class RequestsController {
  constructor(private readonly matchingQueue: MatchingQueueService) {}

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
        events: {
          create: {
            type: 'request.created',
            payload: {
              citySlug: city.slug,
              categorySlug: category.slug,
              serviceSlug: service?.slug ?? null,
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
      status: request.status,
      matching: 'QUEUED',
    };
  }

  @Get(':id')
  async get(@Param('id') id: string) {
    const request = await prisma.request.findUnique({
      where: { id },
      include: {
        offers: {
          orderBy: { createdAt: 'asc' },
          include: { provider: { include: { user: true } } },
        },
        dispatchAttempts: {
          orderBy: [{ round: 'asc' }, { wave: 'asc' }, { sentAt: 'asc' }],
          include: { provider: { include: { user: true } } },
        },
        order: {
          include: {
            offer: true,
            provider: { include: { user: true } },
          },
        },
        events: { orderBy: { createdAt: 'asc' } },
        exceptions: { orderBy: { createdAt: 'asc' } },
      },
    });

    if (!request) throw new BadRequestException('request not found');
    return request;
  }
}
