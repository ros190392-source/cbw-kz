import fs from 'fs';
import path from 'path';
import { config } from '../config';
import { ProcessedRecord } from './types';
import { logger } from './logger';

/**
 * Normalize a title for fuzzy duplicate detection across sources:
 * lowercase, strip punctuation, collapse whitespace.
 */
export function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Simple JSON-backed store for processed items.
 *
 * Phase 01 uses a flat JSON file — intentionally trivial. The interface
 * (isProcessed / hasTitle / markProcessed) is what the rest of the system
 * depends on, so this can later be swapped for SQLite/Postgres/Redis without
 * touching the pipeline.
 */
export class JsonStore {
  private file: string;
  private records: Record<string, ProcessedRecord> = {};
  /** Normalized titles of ACCEPTED items, for cross-run de-duplication. */
  private titles = new Set<string>();

  constructor(fileName = 'processed.json') {
    this.file = path.join(config.paths.data, fileName);
    this.load();
  }

  private load(): void {
    try {
      if (fs.existsSync(this.file)) {
        const raw = fs.readFileSync(this.file, 'utf-8');
        this.records = JSON.parse(raw) as Record<string, ProcessedRecord>;
        for (const rec of Object.values(this.records)) {
          if ((rec.status === 'sent' || rec.status === 'rewritten') && rec.titleNorm) {
            this.titles.add(rec.titleNorm);
          }
        }
      }
    } catch (err) {
      logger.error('storage', `Failed to load state, starting fresh: ${(err as Error).message}`);
      this.records = {};
    }
  }

  isProcessed(id: string): boolean {
    return id in this.records;
  }

  /** True if an accepted item with the same normalized title already exists. */
  hasTitle(titleNorm: string): boolean {
    return this.titles.has(titleNorm);
  }

  markProcessed(record: ProcessedRecord): void {
    this.records[record.id] = record;
    if ((record.status === 'sent' || record.status === 'rewritten') && record.titleNorm) {
      this.titles.add(record.titleNorm);
    }
  }

  save(): void {
    try {
      if (!fs.existsSync(config.paths.data)) {
        fs.mkdirSync(config.paths.data, { recursive: true });
      }
      fs.writeFileSync(this.file, JSON.stringify(this.records, null, 2));
    } catch (err) {
      logger.error('storage', `Failed to persist state: ${(err as Error).message}`);
    }
  }
}
