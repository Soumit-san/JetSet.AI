import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { CacheModule } from '@nestjs/cache-manager';
import Keyv from 'keyv';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { DbModule } from './db/db.module';
import { DestinationsModule } from './destinations/destinations.module';
import { FlightsModule } from './flights/flights.module';
import { HotelsModule } from './hotels/hotels.module';
import { TripsModule } from './trips/trips.module';
import { RagModule } from './rag/rag.module';
import { OpenRouterModule } from './openrouter/openrouter.module';
import { AiModule } from './ai/ai.module';
import { CopilotModule } from './copilot/copilot.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
    }),
    OpenRouterModule,
    DbModule,
    CacheModule.registerAsync({
      isGlobal: true,
      imports: [ConfigModule],
      inject: ['DATABASE_POOL'],
      useFactory: async (pool: any) => {
        // Self-initialize Supabase cache table
        pool.query(`
          CREATE TABLE IF NOT EXISTS cache_entries (
            id SERIAL PRIMARY KEY,
            cache_key VARCHAR(255) UNIQUE NOT NULL,
            response_json JSONB NOT NULL,
            created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
            expires_at TIMESTAMP WITH TIME ZONE NOT NULL
          );
          CREATE INDEX IF NOT EXISTS idx_cache_entries_key ON cache_entries(cache_key);
        `).then(() => {
          console.log('Successfully initialized Supabase cache table: cache_entries');
        }).catch((err: any) => {
          console.error('Failed to initialize Supabase cache table:', err.message);
        });

        const customStore = {
          get: async (key: string) => {
            try {
              // Lazy delete expired keys
              await pool.query(
                'DELETE FROM cache_entries WHERE cache_key = $1 AND expires_at <= NOW()',
                [key]
              );
              const res = await pool.query(
                'SELECT response_json FROM cache_entries WHERE cache_key = $1 AND expires_at > NOW()',
                [key]
              );
              if (res.rows.length > 0) {
                return res.rows[0].response_json;
              }
            } catch (err: any) {
              console.error(`Supabase cache get error for key ${key}:`, err.message);
            }
            return undefined;
          },
          set: async (key: string, value: any, ttl?: number) => {
            try {
              // If no TTL is provided, default to 24 hours
              const ms = ttl && ttl > 0 ? ttl : 24 * 60 * 60 * 1000;
              const expiresAt = new Date(Date.now() + ms);

              await pool.query(
                `INSERT INTO cache_entries (cache_key, response_json, expires_at)
                 VALUES ($1, $2, $3)
                 ON CONFLICT (cache_key) DO UPDATE
                 SET response_json = EXCLUDED.response_json,
                     expires_at = EXCLUDED.expires_at,
                     created_at = CURRENT_TIMESTAMP`,
                [key, JSON.stringify(value), expiresAt]
              );

              // Lazy cleanup of other expired keys on set call
              pool.query('DELETE FROM cache_entries WHERE expires_at < NOW()').catch(() => {});
            } catch (err: any) {
              console.error(`Supabase cache set error for key ${key}:`, err.message);
            }
          },
          delete: async (key: string) => {
            try {
              await pool.query('DELETE FROM cache_entries WHERE cache_key = $1', [key]);
            } catch (err: any) {
              console.error(`Supabase cache delete error for key ${key}:`, err.message);
            }
          },
          clear: async () => {
            try {
              await pool.query('TRUNCATE TABLE cache_entries');
            } catch (err: any) {
              console.error('Supabase cache clear error:', err.message);
            }
          },
          on: () => { },
          opts: {}
        };

        return {
          stores: [new Keyv({ store: customStore })],
        }
      },
    }),
    DestinationsModule,
    FlightsModule,
    HotelsModule,
    TripsModule,
    RagModule,
    AiModule,
    CopilotModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule { }



