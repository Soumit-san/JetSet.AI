import { Module } from '@nestjs/common';
import { RagService } from './rag.service';
import { DbModule } from '../db/db.module';

@Module({
  imports: [DbModule],
  providers: [RagService],
  exports: [RagService],
})
export class RagModule {}
