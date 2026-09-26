import { Module, forwardRef } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { CopilotController } from './copilot.controller';
import { CopilotService } from './copilot.service';
import { LlmService } from './llm.service';
import { RateLimiterService } from './rate-limiter.service';
import { RagModule } from '../rag/rag.module';
import { TripsModule } from '../trips/trips.module';
import { AiModule } from '../ai/ai.module';

@Module({
  imports: [
    ConfigModule,
    RagModule,
    forwardRef(() => TripsModule),
    forwardRef(() => AiModule),
  ],
  controllers: [CopilotController],
  providers: [CopilotService, LlmService, RateLimiterService],
  exports: [CopilotService],
})
export class CopilotModule {}
