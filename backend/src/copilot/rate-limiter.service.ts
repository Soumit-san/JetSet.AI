import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Redis } from '@upstash/redis';

@Injectable()
export class RateLimiterService {
  private redis: Redis;
  private readonly logger = new Logger(RateLimiterService.name);
  private readonly LIMIT = 50; // 50 queries per day

  constructor(private configService: ConfigService) {
    this.redis = new Redis({
      url: this.configService.get<string>('UPSTASH_REDIS_REST_URL')!,
      token: this.configService.get<string>('UPSTASH_REDIS_REST_TOKEN')!,
    });
  }

  async checkLimit(userId: string): Promise<boolean> {
    const key = `ratelimit:copilot:${userId}`;
    try {
      const current = await this.redis.get<number>(key) || 0;
      if (current >= this.LIMIT) {
        return false;
      }
      
      // Increment and set expiry to 24 hours if it's the first request
      const pipe = this.redis.pipeline();
      pipe.incr(key);
      if (current === 0) {
        pipe.expire(key, 86400); // 24 hours
      }
      await pipe.exec();
      return true;
    } catch (error) {
      this.logger.error('Error checking rate limit in Upstash', error);
      // Fail open or closed? Failing open for now to not block users if redis fails.
      return true;
    }
  }
}
