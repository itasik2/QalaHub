import { BadRequestException, Body, Controller, Post } from '@nestjs/common';
import { prisma } from '@qalahub/db';
import { MatchingQueueService } from './matching-queue.service';

class StartMatchingDto {
  requestId!: string;
}

@Controller('matching')
export class MatchingController {
  constructor(private readonly matchingQueue: MatchingQueueService) {}

  @Post('start')
  async start(@Body() body: StartMatchingDto) {
    if (!body.requestId) {
      throw new BadRequestException('requestId is required');
    }

    const request = await prisma.request.findUnique({ where: { id: body.requestId } });
    if (!request) {
      throw new BadRequestException('request not found');
    }

    await this.matchingQueue.start(request.id);

    return {
      ok: true,
      requestId: request.id,
      state: 'MATCHING_QUEUED',
      automation: true,
    };
  }
}
