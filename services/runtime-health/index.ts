import fs from 'fs';
import path from 'path';
import { config } from '../../config';
import { HealthCheck, HealthReport, RuntimeHealthStatus } from '../../src/types';

/**
 * Runtime health checks (EPIC 011 · Phase 3).
 *
 * Verifies the bot is configured and the runtime can operate: required config
 * present, data/logs dirs writable, JSON stores readable, recent pipeline
 * activity. Read-only + inspection-only — it changes nothing and never touches
 * the moderation/publish logic. Inputs are injectable for testing.
 */

export interface HealthInputs {
  botToken: string;
  moderationChatId: string;
  channelId: string;
  adminIds: number[];
  dataDir: string;
  logsDir: string;
  lastPipelineRun?: string | null;
  lastError?: string | null;
  now?: Date;
}

/** Build HealthInputs from the live config (the bot adds runtime state). */
export function healthInputsFromConfig(
  extra: Pick<HealthInputs, 'lastPipelineRun' | 'lastError'> = {},
): HealthInputs {
  return {
    botToken: config.telegram.botToken,
    moderationChatId: config.telegram.moderationChatId,
    channelId: config.telegram.channelId,
    adminIds: config.telegram.adminIds,
    dataDir: config.paths.data,
    logsDir: config.paths.logs,
    lastPipelineRun: extra.lastPipelineRun ?? null,
    lastError: extra.lastError ?? null,
  };
}

function dirWritable(dir: string): boolean {
  try {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, `.health-${process.pid}-${Date.now()}.tmp`);
    fs.writeFileSync(probe, 'ok');
    fs.unlinkSync(probe);
    return true;
  } catch {
    return false;
  }
}

function jsonReadable(file: string): { ok: boolean; detail: string } {
  try {
    if (!fs.existsSync(file)) return { ok: true, detail: 'not created yet (ok on first run)' };
    JSON.parse(fs.readFileSync(file, 'utf-8'));
    return { ok: true, detail: 'readable' };
  } catch (err) {
    return { ok: false, detail: `unreadable/corrupt: ${(err as Error).message}` };
  }
}

const HOUR_MS = 60 * 60 * 1000;

export function checkRuntimeHealth(inputs: HealthInputs): HealthReport {
  const now = inputs.now ?? new Date();
  const checks: HealthCheck[] = [];
  const add = (name: string, ok: boolean, level: HealthCheck['level'], detail: string) =>
    checks.push({ name, ok, level, detail });

  add('bot_token', !!inputs.botToken, 'critical', inputs.botToken ? 'set' : 'TELEGRAM_BOT_TOKEN missing');
  add('moderation_chat', !!inputs.moderationChatId, 'critical', inputs.moderationChatId ? 'set' : 'TELEGRAM_MODERATION_CHAT_ID missing');
  add('publish_channel', !!inputs.channelId, 'warning', inputs.channelId ? 'set' : 'TELEGRAM_CHANNEL_ID missing — cannot publish until set');
  add('admin_ids', inputs.adminIds.length > 0, 'warning', inputs.adminIds.length ? `${inputs.adminIds.length} admin(s)` : 'no admins — nobody can approve (safe, but blocks publishing)');

  add('data_dir_writable', dirWritable(inputs.dataDir), 'critical', inputs.dataDir);
  add('logs_dir_writable', dirWritable(inputs.logsDir), 'critical', inputs.logsDir);

  const processed = jsonReadable(path.join(inputs.dataDir, 'processed.json'));
  add('processed_store', processed.ok, 'warning', `processed.json ${processed.detail}`);
  const drafts = jsonReadable(path.join(inputs.dataDir, 'drafts.json'));
  add('drafts_store', drafts.ok, 'warning', `drafts.json ${drafts.detail}`);

  if (inputs.lastPipelineRun) {
    const ageH = (now.getTime() - new Date(inputs.lastPipelineRun).getTime()) / HOUR_MS;
    add('last_pipeline_run', ageH <= 24, ageH <= 24 ? 'info' : 'warning',
      `last run ${inputs.lastPipelineRun} (${ageH.toFixed(1)}h ago)`);
  } else {
    add('last_pipeline_run', true, 'info', 'no run recorded yet this process');
  }

  add('last_error', !inputs.lastError, inputs.lastError ? 'warning' : 'info',
    inputs.lastError ? `recent error: ${inputs.lastError}` : 'none');

  const status: RuntimeHealthStatus = checks.some((c) => !c.ok && c.level === 'critical')
    ? 'red'
    : checks.some((c) => !c.ok && c.level === 'warning')
      ? 'amber'
      : 'green';

  return { status, checks, generatedAt: now.toISOString() };
}
