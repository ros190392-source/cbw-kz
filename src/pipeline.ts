import { RssParser } from '../services/rss-parser';
import { scoreItem } from '../services/scoring-layer';
import { NewsRewriter } from '../services/news-rewriter';
import { TelegramSender } from '../services/telegram-sender';
import { JsonStore, normalizeTitle } from './storage';
import { DraftStore } from './draft-store';
import { SOURCES } from '../config/sources';
import { config } from '../config';
import { logger } from './logger';
import { NewsItem, PipelineStatus, ProcessedRecord, ScoreResult } from './types';

export interface RunStats {
  fetched: number;
  duplicate: number;
  rejected: number;
  drafted: number; // console drafts (no sender)
  sent: number;    // delivered to moderation chat
  error: number;
  high: number;
  medium: number;
  low: number;
}

function makeRecord(
  item: NewsItem,
  status: PipelineStatus,
  extra: Partial<ProcessedRecord> = {},
): ProcessedRecord {
  return {
    id: item.id,
    title: item.title,
    titleNorm: normalizeTitle(item.title),
    source: item.source,
    publishDate: item.publishDate,
    status,
    category: extra.category ?? null,
    reason: extra.reason ?? null,
    scoreTotal: extra.scoreTotal ?? null,
    priority: extra.priority ?? null,
    sent: extra.sent ?? false,
    processedAt: new Date().toISOString(),
  };
}

/**
 * The end-to-end pipeline:
 *   fetch → de-dupe → SCORE/RANK → rewrite → deliver draft → log.
 *
 * The scoring layer is the gate: REJECT items are dropped + logged, the rest
 * are ranked by score_total and the top `maxPerRun` become drafts. There is
 * still NO auto-publishing — every surviving item is delivered as a draft to
 * the moderation chat for manual approval.
 *
 * Wire with a TelegramSender to deliver drafts; without one, drafts print to
 * the console/log (offline / dry-run mode).
 */
export class Pipeline {
  private parser = new RssParser(SOURCES);
  private rewriter = new NewsRewriter(config.ai);
  private store = new JsonStore();
  private drafts: DraftStore;
  private weights: Record<string, number> = Object.fromEntries(
    SOURCES.map((s) => [s.id, s.weight ?? 0]),
  );

  /** `drafts` can be shared with the bot so both see one live copy. */
  constructor(private sender?: TelegramSender, drafts?: DraftStore) {
    this.drafts = drafts ?? new DraftStore();
  }

  async run(): Promise<RunStats> {
    const items = await this.parser.fetchAll();
    items.sort((a, b) => +new Date(b.publishDate) - +new Date(a.publishDate));

    const stats: RunStats = {
      fetched: items.length, duplicate: 0, rejected: 0, drafted: 0, sent: 0, error: 0,
      high: 0, medium: 0, low: 0,
    };
    const seenThisRun = new Set<string>();
    const candidates: { item: NewsItem; score: ScoreResult }[] = [];

    // ---- Pass 0: cross-source coverage (popularity signal) -----------------
    // The same story carried by several independent feeds = trending. Count
    // distinct sources per normalized title across the whole batch BEFORE
    // de-duping, so the duplicate we drop still boosts the copy we keep.
    const coverage = new Map<string, Set<string>>();
    for (const item of items) {
      const norm = normalizeTitle(item.title);
      if (!norm) continue;
      if (!coverage.has(norm)) coverage.set(norm, new Set());
      coverage.get(norm)!.add(item.sourceId);
    }

    // ---- Pass 1: de-dupe + score, collect surviving candidates -------------
    for (const item of items) {
      // Skip ids already processed in a previous run.
      if (this.store.isProcessed(item.id)) {
        stats.duplicate++;
        continue;
      }

      // De-dupe near-identical stories by normalized title.
      const norm = normalizeTitle(item.title);
      if (norm && (seenThisRun.has(norm) || this.store.hasTitle(norm))) {
        stats.duplicate++;
        const rec = makeRecord(item, 'duplicate', { reason: 'duplicate story (title match)' });
        this.store.markProcessed(rec);
        logger.event(rec);
        continue;
      }
      if (norm) seenThisRun.add(norm);

      // Score + filter.
      const crossSourceCount = norm ? (coverage.get(norm)?.size ?? 1) : 1;
      const score = scoreItem(item, this.weights[item.sourceId] ?? 0, { crossSourceCount });
      if (score.priority === 'REJECT') {
        stats.rejected++;
        const rec = makeRecord(item, 'rejected', {
          category: score.category, reason: score.reason,
          scoreTotal: score.score_total, priority: 'REJECT',
        });
        this.store.markProcessed(rec);
        logger.event(rec);
        continue;
      }

      candidates.push({ item, score });
    }

    // ---- Rank by total score (highest signal first) -----------------------
    candidates.sort((a, b) => b.score.score_total - a.score.score_total);

    // ---- Pass 2: rewrite + deliver top N drafts ---------------------------
    let produced = 0;
    for (const { item, score } of candidates) {
      if (produced >= config.pipeline.maxPerRun) break;

      try {
        const text = await this.rewriter.rewrite(item);

        if (this.sender) {
          await this.sender.sendDraft({ item, text, category: score.category, score });
          // Persist the draft as `pending` so the bot can publish it on Approve.
          this.drafts.add({
            id: item.id, title: item.title, link: item.link, source: item.source,
            publishDate: item.publishDate, category: score.category,
            scoreTotal: score.score_total, priority: score.priority, text,
            status: 'pending', createdAt: new Date().toISOString(),
          });
          stats.sent++;
          const rec = makeRecord(item, 'sent', {
            category: score.category, reason: score.reason,
            scoreTotal: score.score_total, priority: score.priority, sent: true,
          });
          this.store.markProcessed(rec);
          logger.event(rec);
        } else {
          stats.drafted++;
          logger.info(
            'draft',
            `\n──── DRAFT 🔥 ${score.priority} · ${score.category} · ${score.score_total}/100 · ${item.source} ────\n` +
              `🧠 ${score.reason}\n\n${text}\n─────────────────────────────`,
          );
          const rec = makeRecord(item, 'rewritten', {
            category: score.category, reason: score.reason,
            scoreTotal: score.score_total, priority: score.priority,
          });
          this.store.markProcessed(rec);
          logger.event(rec);
        }

        if (score.priority === 'HIGH') stats.high++;
        else if (score.priority === 'MEDIUM') stats.medium++;
        else stats.low++;
        produced++;
      } catch (err) {
        stats.error++;
        const rec = makeRecord(item, 'error', { reason: (err as Error).message });
        this.store.markProcessed(rec);
        logger.error('pipeline', `Error processing «${item.title}»: ${(err as Error).message}`);
      }
    }

    this.store.save();
    logger.info('pipeline', `Run complete → ${JSON.stringify(stats)}`);
    return stats;
  }
}

export function buildPipeline(sender?: TelegramSender, drafts?: DraftStore): Pipeline {
  return new Pipeline(sender, drafts);
}
