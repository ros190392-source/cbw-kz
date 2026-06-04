import fs from 'fs';
import path from 'path';
import { config } from '../config';
import { ProcessedRecord } from './types';

type Level = 'info' | 'warn' | 'error';

function ensureLogDir(): void {
  if (!fs.existsSync(config.paths.logs)) {
    fs.mkdirSync(config.paths.logs, { recursive: true });
  }
}

function appendJson(file: string, obj: unknown): void {
  try {
    ensureLogDir();
    fs.appendFileSync(path.join(config.paths.logs, file), JSON.stringify(obj) + '\n');
  } catch {
    /* logging must never crash the pipeline */
  }
}

function write(level: Level, scope: string, message: string): void {
  const ts = new Date().toISOString();
  const line = `[${ts}] ${level.toUpperCase().padEnd(5)} (${scope}) ${message}`;
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
  appendJson('pipeline.log', { ts, level, scope, message });
}

export const logger = {
  info: (scope: string, message: string) => write('info', scope, message),
  warn: (scope: string, message: string) => write('warn', scope, message),
  error: (scope: string, message: string) => write('error', scope, message),

  /**
   * Structured audit log for every processed item. Captures exactly what the
   * spec requires: title, source, total score, category, priority, reason
   * (+ status / sent).
   */
  event: (record: ProcessedRecord) => {
    appendJson('events.log', record);
    const tag = record.status.toUpperCase();
    const meta = [
      record.priority,
      record.scoreTotal != null ? `${record.scoreTotal}/100` : null,
      record.category,
    ]
      .filter(Boolean)
      .join(' · ');
    const extra = record.reason ? ` — ${record.reason}` : '';
    write('info', 'event', `${tag} «${record.title}» (${record.source})${meta ? ` [${meta}]` : ''}${extra}`);
  },

  /**
   * Audit log for moderation decisions and publishing (TASK 006).
   * Appends a structured entry to events.log and prints a readable line.
   * `event` is the action, e.g. approval / rejection / publish_success /
   * publish_failure / duplicate_prevented / unauthorized.
   */
  audit: (event: string, message: string, data: Record<string, unknown> = {}) => {
    const ts = new Date().toISOString();
    appendJson('events.log', { ts, audit: event, message, ...data });
    write('info', `audit:${event}`, message);
  },
};
