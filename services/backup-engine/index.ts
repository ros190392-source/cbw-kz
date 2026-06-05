import fs from 'fs';
import path from 'path';
import { config } from '../../config';
import { BackupInfo, BackupResult } from '../../src/types';
import { logger } from '../../src/logger';

/**
 * Backup engine (EPIC 011 · Phase 5).
 *
 * Creates timestamped backups of data/*.json (and optionally logs/*.log) and
 * enforces a retention policy. Pure filesystem operations — it never touches the
 * moderation/publish logic and takes no autonomous action beyond copying files
 * when explicitly invoked.
 */

function stamp(now: Date): string {
  // backup-YYYYMMDD-HHMMSS (UTC)
  const p = (n: number) => String(n).padStart(2, '0');
  return (
    `backup-${now.getUTCFullYear()}${p(now.getUTCMonth() + 1)}${p(now.getUTCDate())}` +
    `-${p(now.getUTCHours())}${p(now.getUTCMinutes())}${p(now.getUTCSeconds())}`
  );
}

export class BackupEngine {
  constructor(
    private dataDir = config.paths.data,
    private backupDir = config.runtime.backupDir,
    private logsDir = config.paths.logs,
    private retention = config.runtime.backupRetention,
  ) {}

  /** Create a timestamped backup of data JSON (+ optional logs). */
  createBackup(includeLogs = false, now = new Date()): BackupResult {
    try {
      const name = stamp(now);
      const dest = path.join(this.backupDir, name);
      fs.mkdirSync(dest, { recursive: true });

      let files = 0;
      const copyGlob = (srcDir: string, ext: string, sub?: string) => {
        if (!fs.existsSync(srcDir)) return;
        const targetDir = sub ? path.join(dest, sub) : dest;
        for (const f of fs.readdirSync(srcDir)) {
          if (!f.endsWith(ext)) continue;
          if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });
          fs.copyFileSync(path.join(srcDir, f), path.join(targetDir, f));
          files++;
        }
      };

      copyGlob(this.dataDir, '.json');
      if (includeLogs) copyGlob(this.logsDir, '.log', 'logs');

      const backup: BackupInfo = { name, path: dest, createdAt: now.toISOString(), files };
      logger.audit('backup_created', `Backup created`, { name, files, includeLogs });
      return { ok: true, backup };
    } catch (err) {
      logger.error('backup', `Backup failed: ${(err as Error).message}`);
      return { ok: false, error: (err as Error).message };
    }
  }

  /** All backups, newest first. */
  listBackups(): BackupInfo[] {
    if (!fs.existsSync(this.backupDir)) return [];
    return fs
      .readdirSync(this.backupDir)
      .filter((d) => d.startsWith('backup-') && fs.statSync(path.join(this.backupDir, d)).isDirectory())
      .map((name) => {
        const p = path.join(this.backupDir, name);
        const files = fs.readdirSync(p).filter((f) => f.endsWith('.json')).length;
        return { name, path: p, createdAt: fs.statSync(p).mtime.toISOString(), files };
      })
      .sort((a, b) => b.name.localeCompare(a.name));
  }

  /** Delete backups beyond the retention count. Returns removed names. */
  applyRetention(): string[] {
    const all = this.listBackups();
    const toRemove = all.slice(this.retention);
    for (const b of toRemove) {
      try {
        fs.rmSync(b.path, { recursive: true, force: true });
      } catch (err) {
        logger.error('backup', `Failed to prune ${b.name}: ${(err as Error).message}`);
      }
    }
    if (toRemove.length) logger.audit('backup_pruned', `Pruned ${toRemove.length} old backup(s)`, { kept: this.retention });
    return toRemove.map((b) => b.name);
  }
}
