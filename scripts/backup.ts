/**
 * CLI backup runner (EPIC 011). Creates a timestamped backup of data JSON and
 * applies the retention policy. Pass --logs to also back up log files.
 *
 *   npm run backup            → data only
 *   npm run backup -- --logs  → data + logs
 *
 * Read/copy only — touches no moderation/publish logic.
 */
import { BackupEngine } from '../services/backup-engine';

const includeLogs = process.argv.includes('--logs');
const engine = new BackupEngine();
const result = engine.createBackup(includeLogs);

if (!result.ok) {
  console.error(`Backup failed: ${result.error}`);
  process.exit(1);
}
const pruned = engine.applyRetention();
console.log(`✅ Backup created: ${result.backup!.name} (${result.backup!.files} files)`);
if (pruned.length) console.log(`Pruned ${pruned.length} old backup(s): ${pruned.join(', ')}`);
console.log(`Total backups retained: ${engine.listBackups().length}`);
