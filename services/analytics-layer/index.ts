import fs from 'fs';
import path from 'path';
import { config } from '../../config';
import { logger } from '../../src/logger';
import {
  AnalyticsSnapshot,
  DraftRecord,
  GroupStat,
  PostAnalyticsRecord,
  TelegramMetrics,
} from '../../src/types';

/**
 * Analytics layer (EPIC 001).
 *
 * Tracks every MANUALLY-published Telegram post and the engagement it earns,
 * then turns that history into aggregations the reporting + AI-feedback layers
 * consume. Pure aggregation helpers are exported separately so they can be unit
 * tested without touching the filesystem.
 *
 * This layer is read/measure only — it never publishes anything and has no
 * influence on moderation. Human approval remains the only path to publishing.
 */

// ── Detection tables ────────────────────────────────────────────────────────

/** Canonical exchange name → match substrings (all lowercase). */
const EXCHANGES: Record<string, string[]> = {
  binance: ['binance'],
  bybit: ['bybit'],
  okx: ['okx'],
  mexc: ['mexc'],
  kucoin: ['kucoin'],
  gate: ['gate.io', 'gateio', 'gate '],
  bitget: ['bitget'],
  htx: ['htx', 'huobi'],
  kraken: ['kraken'],
  coinbase: ['coinbase'],
  upbit: ['upbit'],
};

/** GEO tag → match substrings (all lowercase). */
const GEO: Record<string, string[]> = {
  KZ: [
    'kazakhstan', 'kazakh', 'astana', 'almaty', 'tenge', 'kzt', 'kaspi',
    'halyk', 'freedom', 'aifc', ' qaz', 'казахстан',
  ],
};

const lc = (s: string) => (s ?? '').toLowerCase();

/** Detect mentioned exchanges from any free text (title + body). */
export function detectExchanges(text: string): string[] {
  const hay = lc(text);
  const found: string[] = [];
  for (const [name, needles] of Object.entries(EXCHANGES)) {
    if (needles.some((n) => hay.includes(n))) found.push(name);
  }
  return found;
}

/** Detect GEO tags; falls back to ["Global"] when nothing region-specific. */
export function detectGeo(text: string): string[] {
  const hay = lc(text);
  const tags: string[] = [];
  for (const [tag, needles] of Object.entries(GEO)) {
    if (needles.some((n) => hay.includes(n))) tags.push(tag);
  }
  return tags.length ? tags : ['Global'];
}

/** Engagement metrics with everything unknown (publish-time default). */
export function emptyMetrics(): TelegramMetrics {
  return {
    views: null, forwards: null, reactions: null,
    edits: 0, deletes: 0, available: false, collectedAt: null,
  };
}

/**
 * A single, deterministic engagement number used for ranking + classification.
 * Returns 0 when no real engagement data is available, so unmeasured posts
 * never look "successful".
 */
export function engagementScore(m: TelegramMetrics): number {
  if (!m.available) return 0;
  const views = m.views ?? 0;
  const forwards = m.forwards ?? 0;
  const reactions = m.reactions ?? 0;
  return forwards * 3 + reactions * 2 + Math.round(views * 0.1);
}

/** Build a normalized analytics record from an approved+published draft. */
export function buildPostAnalytics(
  rec: DraftRecord,
  telegramMessageId: number,
  channelId: string,
  now = new Date().toISOString(),
): PostAnalyticsRecord {
  const text = `${rec.title} ${rec.text}`;
  return {
    id: rec.id,
    telegramMessageId,
    channelId,
    title: rec.title,
    link: rec.link,
    source: rec.source,
    category: rec.category,
    priority: rec.priority,
    scoreTotal: rec.scoreTotal,
    exchangeMentions: detectExchanges(text),
    geoTags: detectGeo(text),
    publishedAt: rec.publishedAt ?? now,
    metrics: emptyMetrics(),
    updatedAt: now,
  };
}

// ── Pure aggregations (Phase 3 + 7) ─────────────────────────────────────────

const round1 = (n: number) => Math.round(n * 10) / 10;

function statFor(key: string, recs: PostAnalyticsRecord[]): GroupStat {
  const posts = recs.length;
  const sum = (f: (r: PostAnalyticsRecord) => number) => recs.reduce((a, r) => a + f(r), 0);
  const totalViews = sum((r) => r.metrics.views ?? 0);
  const totalForwards = sum((r) => r.metrics.forwards ?? 0);
  const totalReactions = sum((r) => r.metrics.reactions ?? 0);
  const totalEngagement = sum((r) => engagementScore(r.metrics));
  const totalScore = sum((r) => r.scoreTotal ?? 0);
  return {
    key,
    posts,
    avgScore: posts ? round1(totalScore / posts) : 0,
    totalViews,
    totalForwards,
    totalReactions,
    totalEngagement,
    avgEngagement: posts ? round1(totalEngagement / posts) : 0,
  };
}

function groupBy(
  records: PostAnalyticsRecord[],
  keyer: (r: PostAnalyticsRecord) => string[],
): GroupStat[] {
  const buckets = new Map<string, PostAnalyticsRecord[]>();
  for (const r of records) {
    for (const k of keyer(r)) {
      if (!k) continue;
      (buckets.get(k) ?? buckets.set(k, []).get(k)!).push(r);
    }
  }
  return [...buckets.entries()]
    .map(([k, recs]) => statFor(k, recs))
    // Best performers first: engagement, then score, then volume.
    .sort((a, b) =>
      b.avgEngagement - a.avgEngagement ||
      b.avgScore - a.avgScore ||
      b.posts - a.posts);
}

export function aggregateByCategory(records: PostAnalyticsRecord[]): GroupStat[] {
  return groupBy(records, (r) => [r.category ?? 'Uncategorized']);
}

export function aggregateByExchange(records: PostAnalyticsRecord[]): GroupStat[] {
  return groupBy(records, (r) => (r.exchangeMentions.length ? r.exchangeMentions : ['none']));
}

/** Performance grouped by GEO tag (EPIC 002 · Phase 7). */
export function aggregateByGeo(records: PostAnalyticsRecord[]): GroupStat[] {
  return groupBy(records, (r) => (r.geoTags.length ? r.geoTags : ['Global']));
}

export function aggregateByPriority(records: PostAnalyticsRecord[]): GroupStat[] {
  return groupBy(records, (r) => [r.priority ?? 'UNKNOWN']);
}

/** Buckets aligned with the scoring bands (LOW/MEDIUM/HIGH and below). */
export function aggregateByScoreRange(records: PostAnalyticsRecord[]): GroupStat[] {
  const band = (s: number | null): string => {
    const v = s ?? 0;
    if (v >= 80) return '80-100';
    if (v >= 65) return '65-79';
    if (v >= 45) return '45-64';
    if (v >= 20) return '20-44';
    return '0-19';
  };
  return groupBy(records, (r) => [band(r.scoreTotal)]);
}

/** Best-performing categories (already sorted by aggregateByCategory). */
export function bestCategories(records: PostAnalyticsRecord[], limit = 3): GroupStat[] {
  return aggregateByCategory(records).slice(0, limit);
}

/** Categories with the weakest average engagement (lowest first). */
export function lowEngagementCategories(records: PostAnalyticsRecord[], limit = 3): GroupStat[] {
  return [...aggregateByCategory(records)]
    .sort((a, b) => a.avgEngagement - b.avgEngagement || a.avgScore - b.avgScore)
    .slice(0, limit);
}

/** Top posts by engagement (ties broken by score). */
export function topPosts(records: PostAnalyticsRecord[], limit = 5): PostAnalyticsRecord[] {
  return [...records]
    .sort((a, b) =>
      engagementScore(b.metrics) - engagementScore(a.metrics) ||
      (b.scoreTotal ?? 0) - (a.scoreTotal ?? 0))
    .slice(0, limit);
}

/** Best-scoring posts (editorial quality, independent of engagement). */
export function bestScoringPosts(records: PostAnalyticsRecord[], limit = 5): PostAnalyticsRecord[] {
  return [...records]
    .sort((a, b) => (b.scoreTotal ?? 0) - (a.scoreTotal ?? 0))
    .slice(0, limit);
}

/** Build a normalized snapshot of the whole analytics state (Phase 7). */
export function buildSnapshot(
  records: PostAnalyticsRecord[],
  takenAt = new Date().toISOString(),
): AnalyticsSnapshot {
  return {
    takenAt,
    totalPublished: records.length,
    byCategory: aggregateByCategory(records),
    byExchange: aggregateByExchange(records),
    byPriority: aggregateByPriority(records),
    byScoreRange: aggregateByScoreRange(records),
  };
}

// ── Persistence ──────────────────────────────────────────────────────────────

/**
 * JSON-backed store of published-post analytics → `data/post-analytics.json`.
 * Same trivial-by-design approach as JsonStore / DraftStore; swappable later.
 */
export class AnalyticsStore {
  private file: string;
  private snapshotsFile: string;
  private dir: string;
  private records: Record<string, PostAnalyticsRecord> = {};

  constructor(fileName = 'post-analytics.json', dir = config.paths.data) {
    this.dir = dir;
    this.file = path.join(dir, fileName);
    this.snapshotsFile = path.join(dir, 'analytics-snapshots.json');
    this.load();
  }

  private load(): void {
    try {
      if (fs.existsSync(this.file)) {
        this.records = JSON.parse(fs.readFileSync(this.file, 'utf-8')) as Record<
          string,
          PostAnalyticsRecord
        >;
      }
    } catch (err) {
      logger.error('analytics', `Failed to load analytics, starting fresh: ${(err as Error).message}`);
      this.records = {};
    }
  }

  private persist(): void {
    try {
      if (!fs.existsSync(this.dir)) fs.mkdirSync(this.dir, { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.records, null, 2));
    } catch (err) {
      logger.error('analytics', `Failed to persist analytics: ${(err as Error).message}`);
    }
  }

  get(id: string): PostAnalyticsRecord | undefined {
    return this.records[id];
  }

  all(): PostAnalyticsRecord[] {
    return Object.values(this.records);
  }

  /**
   * Track a freshly published post. Idempotent: a second call for the same id
   * (e.g. a duplicate Approve that slipped through) updates the message id
   * rather than creating a duplicate analytics row.
   */
  trackPublished(rec: DraftRecord, telegramMessageId: number, channelId: string): PostAnalyticsRecord {
    const existing = this.records[rec.id];
    const built = buildPostAnalytics(rec, telegramMessageId, channelId);
    // Preserve any metrics already collected for this id.
    const record: PostAnalyticsRecord = existing
      ? { ...built, metrics: existing.metrics, publishedAt: existing.publishedAt }
      : built;
    this.records[rec.id] = record;
    this.persist();
    logger.audit('analytics_tracked', `Tracked published post`, {
      id: rec.id, telegramMessageId, category: rec.category, score: rec.scoreTotal,
      exchanges: record.exchangeMentions, geo: record.geoTags,
    });
    return record;
  }

  /**
   * Merge collected metrics into a tracked post. Unknown fields are left as-is;
   * passing a real view/forward/reaction number flips `available` to true.
   */
  updateMetrics(id: string, patch: Partial<TelegramMetrics>): PostAnalyticsRecord | undefined {
    const rec = this.records[id];
    if (!rec) return undefined;
    const merged: TelegramMetrics = { ...rec.metrics, ...patch };
    const gotEngagement =
      patch.views != null || patch.forwards != null || patch.reactions != null;
    if (gotEngagement) merged.available = true;
    merged.collectedAt = new Date().toISOString();
    this.records[id] = { ...rec, metrics: merged, updatedAt: merged.collectedAt };
    this.persist();
    return this.records[id];
  }

  /** Convenience counters for edits / deletes observed locally. */
  recordEdit(id: string): void {
    const rec = this.records[id];
    if (!rec) return;
    this.updateMetrics(id, { edits: rec.metrics.edits + 1 });
  }

  recordDelete(id: string): void {
    const rec = this.records[id];
    if (!rec) return;
    this.updateMetrics(id, { deletes: rec.metrics.deletes + 1 });
  }

  /** Append a historical snapshot (Phase 7). Returns the snapshot written. */
  saveSnapshot(): AnalyticsSnapshot {
    const snap = buildSnapshot(this.all());
    try {
      let list: AnalyticsSnapshot[] = [];
      if (fs.existsSync(this.snapshotsFile)) {
        list = JSON.parse(fs.readFileSync(this.snapshotsFile, 'utf-8')) as AnalyticsSnapshot[];
      }
      list.push(snap);
      if (!fs.existsSync(this.dir)) fs.mkdirSync(this.dir, { recursive: true });
      fs.writeFileSync(this.snapshotsFile, JSON.stringify(list, null, 2));
    } catch (err) {
      logger.error('analytics', `Failed to persist snapshot: ${(err as Error).message}`);
    }
    return snap;
  }
}
