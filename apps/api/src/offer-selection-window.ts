import { OfferStatus, RequestStatus, prisma } from '@qalahub/db';

const configuredTimeoutSeconds = Number(process.env.OFFER_SELECTION_TIMEOUT_SECONDS ?? 300);
export const offerSelectionTimeoutSeconds = Number.isFinite(configuredTimeoutSeconds)
  ? Math.max(60, Math.round(configuredTimeoutSeconds))
  : 300;

const offerSelectionTimeoutMs = offerSelectionTimeoutSeconds * 1000;

export function getOfferSelectionDeadline(input: {
  status: RequestStatus;
  matchedAt?: Date | null;
  pendingOffers: number;
}) {
  if (
    input.status !== RequestStatus.OFFERS_RECEIVED ||
    !input.matchedAt ||
    input.pendingOffers <= 0
  ) {
    return null;
  }
  return new Date(input.matchedAt.getTime() + offerSelectionTimeoutMs);
}

export async function expireOfferSelectionIfNeeded(requestId: string) {
  const request = await prisma.request.findUnique({
    where: { id: requestId },
    select: { status: true, matchedAt: true, order: { select: { id: true } } },
  });
  if (!request || request.order) return { expired: false, deadline: null };

  const pendingOffers = await prisma.offer.count({
    where: { requestId, status: OfferStatus.PENDING },
  });
  const deadline = getOfferSelectionDeadline({
    status: request.status,
    matchedAt: request.matchedAt,
    pendingOffers,
  });
  if (!deadline || deadline.getTime() > Date.now()) {
    return { expired: false, deadline };
  }

  const expiredAt = new Date();
  const result = await prisma.$transaction(async (tx) => {
    const updated = await tx.offer.updateMany({
      where: { requestId, status: OfferStatus.PENDING },
      data: { status: OfferStatus.EXPIRED },
    });
    if (updated.count === 0) return 0;

    await tx.request.update({
      where: { id: requestId },
      data: { firstOfferAt: null, matchedAt: null },
    });
    await tx.requestEvent.create({
      data: {
        requestId,
        type: 'offers.selection_expired',
        payload: {
          expiredAt: expiredAt.toISOString(),
          timeoutSeconds: offerSelectionTimeoutSeconds,
          expiredOffers: updated.count,
          matchingPaused: true,
        },
      },
    });
    return updated.count;
  });

  return { expired: result > 0, deadline: null };
}
