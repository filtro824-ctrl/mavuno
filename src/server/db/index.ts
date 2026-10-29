import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from './schema.js';

const connectionString = process.env.POSTGRES_URL;
if (!connectionString) {
  throw new Error('POSTGRES_URL is required. Configure an external PostgreSQL connection before starting Mavuno.');
}

const pool = new pg.Pool({
  connectionString,
  max: Number(process.env.PG_POOL_SIZE ?? 8),
  connectionTimeoutMillis: 8_000,
  idleTimeoutMillis: 30_000,
});
pool.on('error', (error) => console.error('PostgreSQL pool error:', error.message));

export const db = drizzle(pool, { schema });
export { pool };
