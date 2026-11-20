// One-off: import a participants CSV/TSV into an event database, through the
// same code the console's participants panel uses (dedupe by roll, conflicts,
// test entries). Holds no data itself.
//
//   npx tsx server/src/import-participants.ts --db path/to/afterhours.db --csv path/to/participants.csv
//   node server/dist/import-participants.js --db /data/afterhours.db --csv /data/participants.csv   (in the container)
//
// Back up the database first. Stop nothing: SQLite WAL lets it run beside the server,
// and the console sees the new people on its next refresh. Running it twice adds nobody twice.
import { existsSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import { createContext } from './app';
import { loadConfig } from './config';
import { importParticipants, listParticipants } from './core/auth/participants';
import { features } from './features/registry';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const db = arg('db');
const csv = arg('csv');
if (!db || !csv) {
  console.error('usage: import-participants --db <database file> --csv <participants csv or tsv>');
  process.exit(2);
}
if (!existsSync(db)) {
  console.error(`${db} does not exist. Point --db at the event database (this script never creates one).`);
  process.exit(2);
}
if (!existsSync(csv)) {
  console.error(`${csv} does not exist.`);
  process.exit(2);
}

const config = { ...loadConfig({ NODE_ENV: 'development', DATABASE_PATH: db }), databasePath: db };
const srcRoot = dirname(fileURLToPath(import.meta.url));
const log = Fastify({ logger: { level: 'warn' } }).log;
const ctx = createContext({ config, srcRoot, features, timers: false }, log);

const before = listParticipants(ctx).stats.total;
const r = importParticipants(ctx, readFileSync(csv, 'utf8'));
const after = listParticipants(ctx).stats.total;

console.log(`\n${db}`);
console.log(`  rows read          ${r.rows}`);
console.log(`  added              ${r.added}`);
console.log(`  already on list    ${r.existing}`);
console.log(`  exact duplicates   ${r.duplicates.length}`);
console.log(`  conflicts          ${r.conflicts.length}`);
console.log(`  skipped            ${r.skipped.length}`);
console.log(`  on the list now    ${after} (was ${before})`);
if (r.duplicates.length) {
  console.log('\nduplicates (same roll, same name and phone; dropped):');
  for (const d of r.duplicates) console.log(`  line ${d.line}  ${d.roll}  ${d.name}`);
}
if (r.conflicts.length) {
  console.log('\nconflicts (same roll, different name or phone; first kept, noted for the desk):');
  for (const c of r.conflicts) console.log(`  line ${c.line}  ${c.roll}  kept "${c.keptName}", also "${c.name}" (differs: ${c.differs.join(', ')})${c.existing ? ' [was already on the list]' : ''}`);
}
if (r.flagged.length) {
  console.log('\nworth a look:');
  for (const f of r.flagged) console.log(`  ${f.roll}  "${f.name}": ${f.reason}`);
}
if (r.skipped.length) {
  console.log('\nskipped:');
  for (const k of r.skipped) console.log(`  line ${k.line}: ${k.reason}`);
}
ctx.db.close();
