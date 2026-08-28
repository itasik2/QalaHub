import { Controller, Get, Module } from '@nestjs/common';

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
  controllers: [HealthController],
})
export class AppModule {}
