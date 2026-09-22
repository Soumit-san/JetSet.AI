import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { CopilotController } from './copilot.controller';
import { CopilotService } from './copilot.service';
import { LlmService } from './llm.service';
import { RateLimiterService } from './rate-limiter.service';

@Module({
  imports: [ConfigModule],
  controllers: [CopilotController],
  providers: [CopilotService, LlmService, RateLimiterService],
  exports: [CopilotService],
})
export class CopilotModule {}
