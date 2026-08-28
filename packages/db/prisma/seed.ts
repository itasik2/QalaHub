import { prisma, UserRole, ProviderStatus, AvailabilityStatus } from '../src/client.js';

const pilotCategories = [
  { slug: 'plumbing', name: 'Сантехника', serviceSlug: 'plumber-callout', serviceName: 'Выезд сантехника' },
  { slug: 'electrical', name: 'Электрика', serviceSlug: 'electrician-callout', serviceName: 'Выезд электрика' },
  { slug: 'auto-electric', name: 'Автоэлектрика и СТО', serviceSlug: 'auto-electric-diagnostics', serviceName: 'Диагностика автоэлектрики' },
  { slug: 'appliance-repair', name: 'Ремонт бытовой техники', serviceSlug: 'appliance-diagnostics', serviceName: 'Диагностика бытовой техники' },
  { slug: 'cleaning', name: 'Клининг', serviceSlug: 'home-cleaning', serviceName: 'Уборка квартиры' },
] as const;

async function seedProvider(input: {
  index: number;
  cityId: string;
  serviceId: string;
  available: boolean;
  latitude: number;
  longitude: number;
}) {
  const phone = `+7700000${String(input.index).padStart(4, '0')}`;
  const user = await prisma.user.upsert({
    where: { phone },
    update: { name: `Тестовый исполнитель ${input.index}`, role: UserRole.PROVIDER },
    create: { phone, name: `Тестовый исполнитель ${input.index}`, role: UserRole.PROVIDER },
  });

  const provider = await prisma.provider.upsert({
    where: { userId: user.id },
    update: {
      cityId: input.cityId,
      status: ProviderStatus.ACTIVE,
      availability: input.available ? AvailabilityStatus.AVAILABLE : AvailabilityStatus.OFFLINE,
      availableUntil: input.available ? new Date(Date.now() + 8 * 60 * 60 * 1000) : null,
      latitude: input.latitude,
      longitude: input.longitude,
      serviceRadiusKm: 15,
      responseRate: 0.75 + ((input.index % 5) * 0.05),
      completionRate: 0.88 + ((input.index % 3) * 0.03),
      rating: 4.3 + ((input.index % 6) * 0.1),
      reliabilityScore: 0.7 + ((input.index % 4) * 0.06),
      activeJobs: input.index % 3 === 0 ? 1 : 0,
    },
    create: {
      userId: user.id,
      cityId: input.cityId,
      status: ProviderStatus.ACTIVE,
      availability: input.available ? AvailabilityStatus.AVAILABLE : AvailabilityStatus.OFFLINE,
      availableUntil: input.available ? new Date(Date.now() + 8 * 60 * 60 * 1000) : null,
      latitude: input.latitude,
      longitude: input.longitude,
      serviceRadiusKm: 15,
      responseRate: 0.75 + ((input.index % 5) * 0.05),
      completionRate: 0.88 + ((input.index % 3) * 0.03),
      rating: 4.3 + ((input.index % 6) * 0.1),
      reliabilityScore: 0.7 + ((input.index % 4) * 0.06),
      activeJobs: input.index % 3 === 0 ? 1 : 0,
    },
  });

  await prisma.providerService.upsert({
    where: { providerId_serviceId: { providerId: provider.id, serviceId: input.serviceId } },
    update: { active: true, minPrice: 5000, maxPrice: 20000 },
    create: { providerId: provider.id, serviceId: input.serviceId, active: true, minPrice: 5000, maxPrice: 20000 },
  });

  return provider;
}

async function main() {
  const pavlodar = await prisma.city.upsert({
    where: { slug: 'pavlodar' },
    update: { name: 'Павлодар', active: true },
    create: { slug: 'pavlodar', name: 'Павлодар', active: true },
  });

  const customer = await prisma.user.upsert({
    where: { phone: '+77000009999' },
    update: { name: 'Тестовый заказчик', role: UserRole.CUSTOMER },
    create: { phone: '+77000009999', name: 'Тестовый заказчик', role: UserRole.CUSTOMER },
  });

  let providerIndex = 1;
  for (const item of pilotCategories) {
    const category = await prisma.category.upsert({
      where: { slug: item.slug },
      update: { name: item.name, active: true, requestMode: 'DISPATCH' },
      create: { slug: item.slug, name: item.name, active: true, requestMode: 'DISPATCH' },
    });

    const service = await prisma.service.upsert({
      where: { categoryId_slug: { categoryId: category.id, slug: item.serviceSlug } },
      update: { name: item.serviceName, active: true },
      create: { categoryId: category.id, slug: item.serviceSlug, name: item.serviceName, active: true },
    });

    const count = item.slug === 'plumbing' ? 10 : 2;
    for (let offset = 0; offset < count; offset += 1) {
      await seedProvider({
        index: providerIndex,
        cityId: pavlodar.id,
        serviceId: service.id,
        available: item.slug === 'plumbing' ? offset < 4 : offset === 0,
        latitude: 52.287 + (providerIndex % 5) * 0.004,
        longitude: 76.967 + (providerIndex % 4) * 0.005,
      });
      providerIndex += 1;
    }
  }

  console.log('QalaHub seed complete', {
    city: pavlodar.slug,
    customerId: customer.id,
    categories: pilotCategories.length,
    providers: providerIndex - 1,
    plumbingProviders: 10,
    plumbingAvailable: 4,
  });
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
