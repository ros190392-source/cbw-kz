import path from 'path';
import dotenv from 'dotenv';

dotenv.config();

/**
 * Central, typed configuration loaded from the environment.
 * Every service reads from here — never from process.env directly.
 */
export const config = {
  telegram: {
    botToken: process.env.TELEGRAM_BOT_TOKEN ?? '',
    moderationChatId: process.env.TELEGRAM_MODERATION_CHAT_ID ?? '',
    /** Public channel drafts are published to AFTER manual approval. */
    channelId: process.env.TELEGRAM_CHANNEL_ID ?? '',
    /** Numeric Telegram user ids allowed to approve/reject. Comma-separated. */
    adminIds: (process.env.TELEGRAM_ADMIN_IDS ?? '')
      .split(',')
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isFinite(n) && n !== 0),
  },
  ai: {
    apiKey: process.env.OPENAI_API_KEY ?? '',
    baseUrl: (process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1').replace(/\/+$/, ''),
    model: process.env.OPENAI_MODEL ?? 'gpt-4o-mini',
  },
  pipeline: {
    pollIntervalMs: Number(process.env.POLL_INTERVAL_MS ?? 5 * 60 * 1000),
    minScore: Number(process.env.MODERATION_MIN_SCORE ?? 3),
    maxPerRun: Number(process.env.MAX_ITEMS_PER_RUN ?? 10),
  },
  autopublish: {
    /** 'news' = global news lane (EPIC 021); 'roadmap' = legacy KZ education lane. */
    mode: (process.env.AUTOPUBLISH_MODE ?? 'news') as 'news' | 'roadmap',
  },
  paths: {
    root: process.cwd(),
    data: path.resolve(process.cwd(), 'data'),
    logs: path.resolve(process.cwd(), 'logs'),
  },
  /** Production runtime settings (EPIC 011). */
  runtime: {
    nodeEnv: process.env.NODE_ENV ?? 'development',
    logLevel: process.env.LOG_LEVEL ?? 'info',
    /** HTTP health-check port; 0 disables the health server. */
    healthcheckPort: Number(process.env.HEALTHCHECK_PORT ?? 0),
    backupDir: process.env.BACKUP_DIR
      ? path.resolve(process.env.BACKUP_DIR)
      : path.resolve(process.cwd(), 'backups'),
    alertsEnabled: (process.env.ALERTS_ENABLED ?? 'false').toLowerCase() === 'true',
    /** How many timestamped backups to retain. */
    backupRetention: Number(process.env.BACKUP_RETENTION ?? 7),
  },
} as const;

export type AppConfig = typeof config;
