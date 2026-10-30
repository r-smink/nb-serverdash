// Maakt een consistente kopie van de database (ook terwijl het dashboard draait) en ruimt oude kopieën op.
//   node scripts/backup.js [aantal te bewaren kopieën, standaard 14]
// In Docker:  docker compose exec -T serverdash node scripts/backup.js
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from '../server/config.js';

const keep = Math.max(1, +process.argv[2] || 14);
const dir = path.join(config.dataDir, 'backups');
fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

const stamp = new Date().toISOString().slice(0, 16).replace(/[-:]/g, '').replace('T', '-');
const target = path.join(dir, `serverdash-${stamp}.db`);
const db = new DatabaseSync(path.join(config.dataDir, 'serverdash.db'));
db.exec('PRAGMA busy_timeout = 30000');
db.prepare('VACUUM INTO ?').run(target);
db.close();
fs.chmodSync(target, 0o600);

const old = fs.readdirSync(dir).filter((f) => /^serverdash-\d{8}-\d{4}\.db$/.test(f)).sort().reverse().slice(keep);
for (const f of old) fs.unlinkSync(path.join(dir, f));
console.log(`Back-up gemaakt: ${target} (${(fs.statSync(target).size / 1e6).toFixed(1)} MB), ${old.length} oude verwijderd`);
