import fs from 'fs';
import path from 'path';
import { config } from '../../config';
import { logger } from '../../src/logger';
import { ScreenshotRecord, ScreenshotType } from '../../src/types';

/**
 * Screenshot registry (EPIC 013 · Phase 2 + 5).
 *
 * Tracks evidence screenshots and enforces redaction safety. No screenshot is
 * ever fabricated here — the registry only records assets a human captured, and
 * flags anything with sensitive data that hasn't been redacted. It publishes
 * nothing.
 */

/** Redaction rules — what must NEVER appear unredacted in a screenshot. */
export const REDACTION_RULES: string[] = [
  'No card numbers',
  'No personal names',
  'No phone numbers',
  'No bank account / IBAN details',
  'No QR / payment-link details',
  'No private chat screenshots without redaction',
];

/** Screenshot types that commonly capture sensitive data → review carefully. */
const SENSITIVE_PRONE: ScreenshotType[] = ['live_test', 'user_submitted'];

/** Does this record need redaction before it can be used? */
export function needsRedaction(rec: ScreenshotRecord): boolean {
  return rec.containsSensitiveData && rec.redactionStatus !== 'redacted';
}

/** A type that often contains sensitive data but isn't flagged → warn. */
export function sensitivityUnreviewed(rec: ScreenshotRecord): boolean {
  return SENSITIVE_PRONE.includes(rec.screenshotType) && !rec.containsSensitiveData && rec.redactionStatus === 'not_required';
}

export class ScreenshotRegistry {
  private file: string;
  private dir: string;
  private byId: Record<string, ScreenshotRecord> = {};

  constructor(fileName = 'screenshots.json', dir = config.paths.data) {
    this.dir = dir;
    this.file = path.join(dir, fileName);
    this.load();
  }

  private load(): void {
    try {
      if (fs.existsSync(this.file)) {
        this.byId = JSON.parse(fs.readFileSync(this.file, 'utf-8')) as Record<string, ScreenshotRecord>;
      }
    } catch (err) {
      logger.error('screenshots', `Failed to load registry, starting fresh: ${(err as Error).message}`);
      this.byId = {};
    }
  }

  private persist(): void {
    try {
      if (!fs.existsSync(this.dir)) fs.mkdirSync(this.dir, { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.byId, null, 2));
    } catch (err) {
      logger.error('screenshots', `Failed to persist registry: ${(err as Error).message}`);
    }
  }

  get(id: string): ScreenshotRecord | undefined {
    return this.byId[id];
  }

  all(): ScreenshotRecord[] {
    return Object.values(this.byId);
  }

  forExchange(slug: string): ScreenshotRecord[] {
    return this.all().filter((s) => s.exchange === slug);
  }

  forClaim(claimId: string): ScreenshotRecord[] {
    return this.all().filter((s) => s.claimId === claimId);
  }

  byType(type: ScreenshotType): ScreenshotRecord[] {
    return this.all().filter((s) => s.screenshotType === type);
  }

  /** Add a screenshot record. Auto-sets redaction to pending when sensitive. */
  add(rec: ScreenshotRecord): ScreenshotRecord {
    const normalized: ScreenshotRecord = {
      ...rec,
      redactionStatus:
        rec.containsSensitiveData && rec.redactionStatus === 'not_required' ? 'pending' : rec.redactionStatus,
    };
    this.byId[rec.id] = normalized;
    this.persist();
    if (needsRedaction(normalized)) {
      logger.audit('screenshot_needs_redaction', `Screenshot ${rec.id} needs redaction before use`, {
        exchange: rec.exchange, type: rec.screenshotType,
      });
    }
    return normalized;
  }

  markRedacted(id: string, reviewer: string): ScreenshotRecord | undefined {
    const rec = this.byId[id];
    if (!rec) return undefined;
    rec.redactionStatus = 'redacted';
    rec.reviewer = reviewer;
    this.persist();
    return rec;
  }

  /** All records that are blocked from use until redacted. */
  redactionBacklog(): ScreenshotRecord[] {
    return this.all().filter(needsRedaction);
  }
}
