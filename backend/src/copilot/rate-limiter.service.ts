import { Injectable, Logger, Inject } from '@nestjs/common';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import type { Cache } from 'cache-manager';

@Injectable()
export class RateLimiterService {
  private readonly logger = new Logger(RateLimiterService.name);
  private readonly LIMIT = 50; // 50 queries per day
  private readonly inMemoryCounts = new Map<string, { count: number; resetAt: number }>();

  constructor(@Inject(CACHE_MANAGER) private readonly cacheManager: Cache) {}

  async checkLimit(userId: string): Promise<boolean> {
    const key = `ratelimit:copilot:${userId}`;
    const now = Date.now();
    const dayMs = 24 * 60 * 60 * 1000;

    try {
      const cached = await this.cacheManager.get<number>(key);
      const current = typeof cached === 'number' ? cached : 0;

      if (current >= this.LIMIT) {
        this.logger.warn(`Rate limit reached for user ${userId} (${current}/${this.LIMIT})`);
        return false;
      }

      await this.cacheManager.set(key, current + 1, dayMs);
      return true;
    } catch (error: any) {
      this.logger.warn(`Cache rate limit check failed: ${error.message}. Using in-memory fallback.`);

      const entry = this.inMemoryCounts.get(key);
      if (!entry || entry.resetAt <= now) {
        this.inMemoryCounts.set(key, { count: 1, resetAt: now + dayMs });
        return true;
      }

      if (entry.count >= this.LIMIT) {
        return false;
      }

      entry.count += 1;
      return true;
    }
  }
}
