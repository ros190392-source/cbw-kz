import { BackupInfo, HealthReport } from '../../src/types';

/**
 * Telegram formatters for the runtime commands (EPIC 011): /health_runtime,
 * /backup, /runtime_status. Pure, read-only string builders.
 */

const esc = (s: string) =>
  (s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const statusIcon = (s: string) => (s === 'green' ? '🟢' : s === 'amber' ? '🟡' : '🔴');
const checkIcon = (ok: boolean, level: string) => (ok ? '✅' : level === 'critical' ? '❌' : '⚠️');

export function formatHealthReport(r: HealthReport): string {
  const lines = [
    `${statusIcon(r.status)} <b>Runtime health: ${esc(r.status.toUpperCase())}</b>`,
    `${r.generatedAt.slice(0, 19).replace('T', ' ')} UTC`,
    '',
  ];
  for (const c of r.checks) {
    lines.push(`${checkIcon(c.ok, c.level)} <b>${esc(c.name)}</b> — ${esc(c.detail)}`);
  }
  return lines.join('\n');
}

export interface RuntimeStatusView {
  nodeEnv: string;
  logLevel: string;
  uptimeSec: number;
  pid: number;
  nodeVersion: string;
  alertsEnabled: boolean;
  healthcheckPort: number;
  lastPipelineRun: string | null;
  lastError: string | null;
  backups: BackupInfo[];
}

export function formatRuntimeStatus(v: RuntimeStatusView): string {
  const up = `${Math.floor(v.uptimeSec / 3600)}h ${Math.floor((v.uptimeSec % 3600) / 60)}m`;
  const lines = [
    '🖥 <b>Runtime status</b>',
    `env: <code>${esc(v.nodeEnv)}</code> · log: <code>${esc(v.logLevel)}</code> · node ${esc(v.nodeVersion)}`,
    `pid ${v.pid} · uptime ${up}`,
    `alerts: ${v.alertsEnabled ? 'on' : 'off'} · health port: ${v.healthcheckPort || '(disabled)'}`,
    `last pipeline run: ${v.lastPipelineRun ? esc(v.lastPipelineRun) : 'none this process'}`,
    `last error: ${v.lastError ? esc(v.lastError) : 'none'}`,
    `backups: ${v.backups.length}${v.backups.length ? ` (latest ${esc(v.backups[0].name)})` : ''}`,
    '',
    '<i>Manual draft-only mode — no auto/scheduled publishing.</i>',
  ];
  return lines.join('\n');
}

export function formatBackupResult(result: { ok: boolean; backup?: BackupInfo; error?: string }, pruned: string[]): string {
  if (!result.ok) return `❌ Backup failed: ${esc(result.error ?? 'unknown error')}`;
  const b = result.backup!;
  const lines = [
    '💾 <b>Backup complete</b>',
    `name: <code>${esc(b.name)}</code>`,
    `files: ${b.files} · ${esc(b.createdAt.slice(0, 19).replace('T', ' '))} UTC`,
  ];
  if (pruned.length) lines.push(`pruned ${pruned.length} old backup(s) (retention policy)`);
  return lines.join('\n');
}
