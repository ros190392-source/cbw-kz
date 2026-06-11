import fs from 'fs';
import path from 'path';
import { config } from '../config';
import { DraftRecord } from './types';
import { logger } from './logger';

/**
 * JSON-backed store of moderation drafts and their lifecycle
 * (pending → approved → published | rejected).
 *
 * Holds the publishable post text so the bot can publish on Approve, and is the
 * source of truth for duplicate-publish prevention.
 */
export class DraftStore {
  private file: string;
  private dir: string;
  private records: Record<string, DraftRecord> = {};

  constructor(fileName = 'drafts.json', dataDir?: string) {
    this.dir = dataDir ?? config.paths.data;
    this.file = path.join(this.dir, fileName);
    this.load();
  }

  private load(): void {
    try {
      if (fs.existsSync(this.file)) {
        this.records = JSON.parse(fs.readFileSync(this.file, 'utf-8')) as Record<string, DraftRecord>;
      }
    } catch (err) {
      logger.error('drafts', `Failed to load drafts, starting fresh: ${(err as Error).message}`);
      this.records = {};
    }
  }

  private save(): void {
    try {
      if (!fs.existsSync(this.dir)) fs.mkdirSync(this.dir, { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.records, null, 2));
    } catch (err) {
      logger.error('drafts', `Failed to persist drafts: ${(err as Error).message}`);
    }
  }

  get(id: string): DraftRecord | undefined {
    return this.records[id];
  }

  /** Insert a new pending draft (no-op if the id already exists). */
  add(record: DraftRecord): void {
    if (this.records[record.id]) return;
    this.records[record.id] = record;
    this.save();
  }

  /** Patch an existing draft and persist. Returns the updated record. */
  update(id: string, patch: Partial<DraftRecord>): DraftRecord | undefined {
    const rec = this.records[id];
    if (!rec) return undefined;
    this.records[id] = { ...rec, ...patch };
    this.save();
    return this.records[id];
  }

  all(): DraftRecord[] {
    return Object.values(this.records);
  }
}
