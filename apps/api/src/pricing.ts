import { ProviderStatus, prisma } from '@qalahub/db';

export type RecommendedPriceRange = {
  minKzt: number | null;
  maxKzt: number | null;
  sampleSize: number;
  basis: 'PROVIDER_RANGES' | 'INSUFFICIENT_DATA';
};

function roundedMedian(values: number[]) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const raw =
    sorted.length % 2 === 1
      ? sorted[middle]
      : (sorted[middle - 1] + sorted[middle]) / 2;
  return Math.max(500, Math.round(raw / 500) * 500);
}

export async function getRecommendedPriceRange(input: {
  cityId: string;
  categoryId: string;
  serviceId?: string | null;
}): Promise<RecommendedPriceRange> {
  const rows = await prisma.providerService.findMany({
    where: {
      active: true,
      provider: {
        cityId: input.cityId,
        status: ProviderStatus.ACTIVE,
      },
      service: input.serviceId
        ? { id: input.serviceId, active: true }
        : { categoryId: input.categoryId, active: true },
    },
    select: {
      minPrice: true,
      maxPrice: true,
    },
  });

  const minValues = rows
    .map((row) => row.minPrice)
    .filter((value): value is number => value != null && value > 0);
  const maxValues = rows
    .map((row) => row.maxPrice)
    .filter((value): value is number => value != null && value > 0);
  const sampleSize = rows.filter(
    (row) => (row.minPrice ?? 0) > 0 || (row.maxPrice ?? 0) > 0,
  ).length;

  let minKzt = roundedMedian(minValues);
  let maxKzt = roundedMedian(maxValues);
  if (minKzt != null && maxKzt != null && minKzt > maxKzt) {
    [minKzt, maxKzt] = [maxKzt, minKzt];
  }

  return {
    minKzt,
    maxKzt,
    sampleSize,
    basis: sampleSize > 0 ? 'PROVIDER_RANGES' : 'INSUFFICIENT_DATA',
  };
}
