import { Controller, Get, Module } from '@nestjs/common';
import { MatchingController } from './matching.controller';

@Controller('health')
class HealthController {
  @Get()
  health() {
    return {
      ok: true,
      service: 'qalahub-api',
      automationFirst: true,
    };
  }
}

@Module({
  controllers: [HealthController, MatchingController],
})
export class AppModule {}
