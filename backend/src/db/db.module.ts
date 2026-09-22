import { Module, Global, Logger } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import pg from 'pg';

/**
 * Lightweight in-memory store that implements the same query() interface
 * as pg.Pool so the rest of the app works without a real database.
 */
function createInMemoryPool() {
  const logger = new Logger('InMemoryDB');
  const tables: Record<string, any[]> = {};

  logger.warn('No DATABASE_URL configured — using in-memory store. Data will not persist across restarts.');

  return {
    query: async (text: string, params?: any[]) => {
      const sql = text.trim().toUpperCase();

      // CREATE TABLE — just register the table name
      if (sql.startsWith('CREATE TABLE') || sql.startsWith('CREATE INDEX')) {
        const match = text.match(/CREATE TABLE IF NOT EXISTS\s+(\w+)/i);
        if (match && !tables[match[1]]) tables[match[1]] = [];
        return { rows: [], rowCount: 0 };
      }

      // INSERT INTO <table> (...) VALUES ($1, $2, ...)
      if (sql.startsWith('INSERT INTO')) {
        const match = text.match(/INSERT INTO\s+(\w+)\s*\(([^)]+)\)/i);
        if (match && params) {
          const table = match[1];
          const cols = match[2].split(',').map(c => c.trim());
          if (!tables[table]) tables[table] = [];
          const row: Record<string, any> = {};
          cols.forEach((col, i) => { row[col] = params[i]; });
          tables[table].push(row);
          return { rows: [row], rowCount: 1 };
        }
      }

      // SELECT ... FROM <table> WHERE id = $1
      if (sql.startsWith('SELECT')) {
        const match = text.match(/FROM\s+(\w+)/i);
        if (match) {
          const table = match[1];
          const rows = tables[table] || [];
          if (params && params.length > 0 && text.includes('$1')) {
            // Simple WHERE id = $1
            const colMatch = text.match(/WHERE\s+(\w+)\s*=/i);
            const col = colMatch ? colMatch[1] : 'id';
            const filtered = rows.filter(r => r[col] === params[0]);
            return { rows: filtered, rowCount: filtered.length };
          }
          return { rows, rowCount: rows.length };
        }
      }

      // UPDATE <table> SET ... WHERE id = $N
      if (sql.startsWith('UPDATE')) {
        const match = text.match(/UPDATE\s+(\w+)\s+SET\s+([\s\S]+)\s+WHERE\s+(\w+)\s*=\s*\$(\d+)/i);
        if (match && params) {
          const table = match[1];
          const idCol = match[3];
          const idParamIdx = parseInt(match[4], 10) - 1;
          const idVal = params[idParamIdx];
          const rows = tables[table] || [];
          const row = rows.find(r => r[idCol] === idVal);
          if (row) {
            // Parse SET clause columns
            const setCols = match[2].split(',').map(s => {
              const m = s.trim().match(/^(\w+)\s*=\s*\$(\d+)/);
              return m ? { col: m[1], idx: parseInt(m[2], 10) - 1 } : null;
            }).filter(Boolean) as { col: string; idx: number }[];
            setCols.forEach(({ col, idx }) => { row[col] = params[idx]; });
          }
          return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
        }
      }

      // DELETE / TRUNCATE — just clear
      if (sql.startsWith('DELETE') || sql.startsWith('TRUNCATE')) {
        const match = text.match(/(FROM|TABLE)\s+(\w+)/i);
        if (match) {
          const table = match[2];
          if (params && params.length > 0) {
            const colMatch = text.match(/WHERE\s+(\w+)\s*=/i);
            const col = colMatch ? colMatch[1] : 'id';
            if (tables[table]) {
              tables[table] = tables[table].filter(r => r[col] !== params[0]);
            }
          } else {
            tables[table] = [];
          }
        }
        return { rows: [], rowCount: 0 };
      }

      return { rows: [], rowCount: 0 };
    },
    end: async () => {},
  };
}

@Global()
@Module({
  imports: [ConfigModule],
  providers: [
    {
      provide: 'DATABASE_POOL',
      useFactory: async (configService: ConfigService) => {
        const dbUrl = configService.get<string>('DATABASE_URL');

        // If no DATABASE_URL, use in-memory store
        if (!dbUrl || dbUrl.trim() === '') {
          return createInMemoryPool();
        }

        const isLocalhost = dbUrl.includes('localhost') || dbUrl.includes('127.0.0.1');
        const pool = new pg.Pool({
          connectionString: dbUrl,
          ssl: isLocalhost ? false : { rejectUnauthorized: false },
        });

        // Test the connection — fall back to in-memory if it fails
        try {
          const client = await pool.connect();
          client.release();
          new Logger('DbModule').log('Connected to PostgreSQL database');
          return pool;
        } catch (err: any) {
          new Logger('DbModule').warn(`Could not connect to PostgreSQL (${err.message}) — using in-memory store instead.`);
          await pool.end().catch(() => {});
          return createInMemoryPool();
        }
      },
      inject: [ConfigService],
    },
  ],
  exports: ['DATABASE_POOL'],
})
export class DbModule {}

