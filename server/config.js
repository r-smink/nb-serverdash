import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
try { process.loadEnvFile(path.join(root, '.env')); } catch { /* geen .env: alleen echte env vars */ }

const int = (v, d) => (v !== undefined && v !== '' && !Number.isNaN(+v) ? Math.floor(+v) : d);

export const config = {
  root,
  port: int(process.env.PORT, 8080),
  host: process.env.HOST || '0.0.0.0',
  dataDir: path.resolve(root, process.env.DATA_DIR || 'data'),
  adminUser: process.env.ADMIN_USER || 'admin',
  adminPassword: process.env.ADMIN_PASSWORD || '',
  sessionSecret: process.env.SESSION_SECRET || '',
  // Publieke URL van het dashboard, gebruikt in het installatiecommando voor de agent.
  publicUrl: (process.env.PUBLIC_URL || '').replace(/\/+$/, ''),
  trustProxy: process.env.TRUST_PROXY === '1',
  secureCookie: process.env.SECURE_COOKIE === '1',
  retentionDays: int(process.env.RETENTION_DAYS, 30),
  procSnapshotInterval: int(process.env.PROC_SNAPSHOT_INTERVAL, 60),
  procRetentionHours: int(process.env.PROC_RETENTION_HOURS, 72),
};
