import fs from 'fs';
import path from 'path';
import { config } from '../../config';
import { logger } from '../../src/logger';
import {
  FeedbackClass,
  FeedbackSummary,
  PatternFeedback,
  PostAnalyticsRecord,
} from '../../src/types';
import {
  aggregateByCategory,
  aggregateByExchange,
  engagementScore,
} from '../analytics-layer';

/**
 * AI-feedback FOUNDATION (EPIC 001 · Phase 6).
 *
 * This is NOT a self-learning model and it NEVER changes scoring or publishing.
 * It only labels published posts so a future learning layer has clean signal:
 *
 *   high score + healthy engagement  → "successful" pattern
 *   high score + (almost) no engagement → "weak" pattern (we mis-predicted)
 *   no engagement data at all        → "no_data" (cannot judge yet)
 *   everything else                  → "neutral"
 *
 * Thresholds are deliberately simple + explainable.
 */

/** Score at/above which we consider an item "high score" (HIGH band). */
export const HIGH_SCORE = 65;
/** Engagement at/above which we consider a post "high engagement". */
export const HIGH_ENGAGEMENT = 50;
/** Engagement at/below which a high-score post is flagged "weak". */
export const LOW_ENGAGEMENT = 5;

export function classifyPattern(rec: PostAnalyticsRecord): PatternFeedback {
  const score = rec.scoreTotal ?? 0;
  const engagement = engagementScore(rec.metrics);
  const highScore = score >= HIGH_SCORE;

  let classification: FeedbackClass;
  let reason: string;

  if (!rec.metrics.available) {
    classification = 'no_data';
    reason = 'No engagement data collected yet.';
  } else if (highScore && engagement >= HIGH_ENGAGEMENT) {
    classification = 'successful';
    reason = `High score (${score}) confirmed by strong engagement (${engagement}).`;
  } else if (highScore && engagement <= LOW_ENGAGEMENT) {
    classification = 'weak';
    reason = `High score (${score}) but very low engagement (${engagement}) — prediction missed.`;
  } else if (!highScore && engagement >= HIGH_ENGAGEMENT) {
    classification = 'successful';
    reason = `Modest score (${score}) over-performed with engagement ${engagement}.`;
  } else {
    classification = 'neutral';
    reason = `Score ${score}, engagement ${engagement} — within expected range.`;
  }

  return {
    id: rec.id,
    title: rec.title,
    category: rec.category,
    priority: rec.priority,
    scoreTotal: rec.scoreTotal,
    engagement,
    classification,
    reason,
  };
}

/** Build the full feedback summary over all published posts. */
export function buildFeedback(
  records: PostAnalyticsRecord[],
  generatedAt = new Date().toISOString(),
): FeedbackSummary {
  const patterns = records.map(classifyPattern);
  return {
    generatedAt,
    patterns,
    categoryPerformance: aggregateByCategory(records),
    exchangePerformance: aggregateByExchange(records),
    successfulCount: patterns.filter((p) => p.classification === 'successful').length,
    weakCount: patterns.filter((p) => p.classification === 'weak').length,
  };
}

/**
 * Persists feedback summaries → `data/feedback.json`. Foundation only: stores
 * pattern history + category/exchange performance for later analysis. There is
 * no model, no auto-tuning, and nothing here feeds back into publishing.
 */
export class FeedbackStore {
  private file: string;
  private dir: string;

  constructor(fileName = 'feedback.json', dir = config.paths.data) {
    this.dir = dir;
    this.file = path.join(dir, fileName);
  }

  /** Compute + persist the latest feedback summary, returning it. */
  save(records: PostAnalyticsRecord[]): FeedbackSummary {
    const summary = buildFeedback(records);
    try {
      if (!fs.existsSync(this.dir)) fs.mkdirSync(this.dir, { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(summary, null, 2));
      logger.audit('feedback_built', `Feedback summary built (foundation only)`, {
        successful: summary.successfulCount, weak: summary.weakCount, total: records.length,
      });
    } catch (err) {
      logger.error('feedback', `Failed to persist feedback: ${(err as Error).message}`);
    }
    return summary;
  }

  load(): FeedbackSummary | null {
    try {
      if (fs.existsSync(this.file)) {
        return JSON.parse(fs.readFileSync(this.file, 'utf-8')) as FeedbackSummary;
      }
    } catch (err) {
      logger.error('feedback', `Failed to load feedback: ${(err as Error).message}`);
    }
    return null;
  }
}
