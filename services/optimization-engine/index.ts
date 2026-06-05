import fs from 'fs';
import path from 'path';
import { config } from '../../config';
import { logger } from '../../src/logger';
import {
  OptimizationConfidence,
  OptimizationSnapshot,
  OptimizationSuggestion,
  PostAnalyticsRecord,
  ResearchFinding,
  SuggestionType,
  VerificationClaim,
} from '../../src/types';
import { aggregateByCategory, engagementScore } from '../analytics-layer';
import { buildFeedback } from '../feedback-engine';
import { localePerformance } from '../locale-engine';
import { claimFreshness, computeConfidence, staleClaims } from '../verification-engine';

/**
 * Optimization / learning meta-brain (EPIC 007).
 *
 * Reads the system's own outputs — analytics engagement, verification freshness,
 * locale performance, research findings — and proposes SELF-IMPROVEMENT
 * suggestions: scoring weights, source trust, topic priority, locale focus,
 * verification refresh, engagement patterns.
 *
 * STRICTLY recommendation-only. It never edits config, never changes scoring,
 * never publishes, never acts. Sparse data ⇒ low-confidence "investigate"
 * suggestions (uncertainty over overfitting). Every suggestion is
 * humanReviewRequired. Pure helpers exported for testing.
 */

const round1 = (n: number) => Math.round(n * 10) / 10;
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

/** Confidence is gated by sample size — small data can never be "high". */
export function confidenceFromSample(n: number): OptimizationConfidence {
  if (n >= 8) return 'high';
  if (n >= 3) return 'medium';
  return 'low';
}

const CONF_RANK: Record<OptimizationConfidence, number> = { high: 0, medium: 1, low: 2 };

function suggestion(s: Omit<OptimizationSuggestion, 'humanReviewRequired'>): OptimizationSuggestion {
  return { ...s, humanReviewRequired: true };
}

export interface OptimizationInputs {
  posts: PostAnalyticsRecord[];
  claims: VerificationClaim[];
  findings?: ResearchFinding[];
  now?: Date;
}

// ── Scoring-weight suggestions ───────────────────────────────────────────────

/**
 * Compare each category's engagement to its average editorial score. A category
 * that engages well but scores low is UNDER-rated (suggest increasing weight);
 * one that scores high but engages poorly is OVER-rated (suggest decreasing).
 */
export function scoringSuggestions(posts: PostAnalyticsRecord[]): OptimizationSuggestion[] {
  const cats = aggregateByCategory(posts).filter((c) => c.posts > 0);
  if (cats.length < 2) return [];
  const avgEng = mean(cats.map((c) => c.avgEngagement));
  const avgScore = mean(cats.map((c) => c.avgScore));
  const out: OptimizationSuggestion[] = [];

  for (const c of cats) {
    if (avgEng > 0 && c.avgEngagement > avgEng * 1.2 && c.avgScore < avgScore) {
      out.push(suggestion({
        id: `scoring:${c.key}`, type: 'scoring_weight', target: `category:${c.key}`,
        direction: 'increase',
        observation: `engagement ${c.avgEngagement} > avg ${round1(avgEng)} but score ${c.avgScore} < avg ${round1(avgScore)}`,
        recommendation: `Consider increasing scoring weight for "${c.key}" signals (under-rated vs. engagement).`,
        rationale: 'High engagement with below-average editorial score suggests the scoring layer undervalues this category.',
        confidence: confidenceFromSample(c.posts), sampleSize: c.posts,
      }));
    } else if (c.avgScore > avgScore && avgEng > 0 && c.avgEngagement < avgEng * 0.8) {
      out.push(suggestion({
        id: `scoring:${c.key}`, type: 'scoring_weight', target: `category:${c.key}`,
        direction: 'decrease',
        observation: `score ${c.avgScore} > avg ${round1(avgScore)} but engagement ${c.avgEngagement} < avg ${round1(avgEng)}`,
        recommendation: `Consider lowering scoring weight for "${c.key}" signals (over-rated vs. engagement).`,
        rationale: 'High editorial score with weak engagement suggests the scoring layer overvalues this category.',
        confidence: confidenceFromSample(c.posts), sampleSize: c.posts,
      }));
    }
  }
  return out;
}

// ── Source-trust suggestions ─────────────────────────────────────────────────

export function sourceTrustSuggestions(posts: PostAnalyticsRecord[]): OptimizationSuggestion[] {
  const bySource = new Map<string, PostAnalyticsRecord[]>();
  for (const p of posts) (bySource.get(p.source) ?? bySource.set(p.source, []).get(p.source)!).push(p);

  const sources = [...bySource.entries()].map(([source, recs]) => ({
    source, posts: recs.length,
    avgEng: round1(mean(recs.map((r) => engagementScore(r.metrics)))),
  }));
  if (sources.length < 2) return [];
  const globalMean = mean(sources.map((s) => s.avgEng));
  const out: OptimizationSuggestion[] = [];

  for (const s of sources) {
    if (s.posts < 2) continue; // need a little evidence
    if (globalMean > 0 && s.avgEng > globalMean * 1.3) {
      out.push(suggestion({
        id: `source:${s.source}`, type: 'source_trust', target: `source:${s.source}`,
        direction: 'increase',
        observation: `avg engagement ${s.avgEng} vs global ${round1(globalMean)} over ${s.posts} posts`,
        recommendation: `Consider raising the source weight/trust for "${s.source}".`,
        rationale: 'This source\'s posts consistently out-engage the average.',
        confidence: confidenceFromSample(s.posts), sampleSize: s.posts,
      }));
    } else if (globalMean > 0 && s.avgEng < globalMean * 0.5) {
      out.push(suggestion({
        id: `source:${s.source}`, type: 'source_trust', target: `source:${s.source}`,
        direction: 'decrease',
        observation: `avg engagement ${s.avgEng} vs global ${round1(globalMean)} over ${s.posts} posts`,
        recommendation: `Consider lowering the source weight/trust for "${s.source}".`,
        rationale: 'This source under-performs the average — its content may be lower-signal.',
        confidence: confidenceFromSample(s.posts), sampleSize: s.posts,
      }));
    }
  }
  return out;
}

// ── Topic-priority suggestions (planner feedback loop) ───────────────────────

export function topicPrioritySuggestions(posts: PostAnalyticsRecord[]): OptimizationSuggestion[] {
  const cats = aggregateByCategory(posts).filter((c) => c.posts > 0);
  if (cats.length < 2) return [];
  const sorted = [...cats].sort((a, b) => b.avgEngagement - a.avgEngagement);
  const top = sorted[0];
  const bottom = sorted[sorted.length - 1];
  const out: OptimizationSuggestion[] = [];

  out.push(suggestion({
    id: `topic:${top.key}`, type: 'topic_priority', target: `topic:${top.key}`,
    direction: 'increase',
    observation: `top category by engagement (${top.avgEngagement})`,
    recommendation: `Editorial planner: prioritize more "${top.key}" topics.`,
    rationale: 'Best-engaging category — worth more planner slots.',
    confidence: confidenceFromSample(top.posts), sampleSize: top.posts,
  }));
  if (bottom.key !== top.key && bottom.avgEngagement < top.avgEngagement * 0.4 && bottom.posts >= 2) {
    out.push(suggestion({
      id: `topic:${bottom.key}`, type: 'topic_priority', target: `topic:${bottom.key}`,
      direction: 'decrease',
      observation: `lowest category by engagement (${bottom.avgEngagement})`,
      recommendation: `Editorial planner: de-prioritize "${bottom.key}" topics for now.`,
      rationale: 'Weakest-engaging category — lower planner emphasis until it improves.',
      confidence: confidenceFromSample(bottom.posts), sampleSize: bottom.posts,
    }));
  }
  return out;
}

// ── Locale / GEO focus suggestions ───────────────────────────────────────────

const PRIMARY_LOCALES = ['ru-KZ', 'kk-KZ'];

export function localeFocusSuggestions(posts: PostAnalyticsRecord[]): OptimizationSuggestion[] {
  const perf = localePerformance(posts);
  const out: OptimizationSuggestion[] = [];
  if (perf.length) {
    const top = perf[0];
    out.push(suggestion({
      id: `locale:${top.locale}`, type: 'locale_focus', target: `locale:${top.locale}`,
      direction: 'maintain',
      observation: `best locale by engagement (${top.avgEngagement}) over ${top.posts} posts`,
      recommendation: `Keep investing in ${top.locale}; it performs best.`,
      rationale: 'Highest-engagement locale — sustain coverage.',
      confidence: confidenceFromSample(top.posts), sampleSize: top.posts,
    }));
  }
  const covered = new Set(perf.map((p) => p.locale));
  for (const loc of PRIMARY_LOCALES) {
    if (!covered.has(loc)) {
      out.push(suggestion({
        id: `locale:${loc}`, type: 'locale_focus', target: `locale:${loc}`,
        direction: 'investigate',
        observation: 'no published posts for this primary locale',
        recommendation: `Investigate seeding content for ${loc} (primary KZ locale, currently uncovered).`,
        rationale: 'Primary market locale has no data — a coverage gap, not a performance signal.',
        confidence: 'low', sampleSize: 0,
      }));
    }
  }
  return out;
}

// ── Verification-refresh warnings ────────────────────────────────────────────

export function verificationWarnings(claims: VerificationClaim[], now: Date): OptimizationSuggestion[] {
  const stale = staleClaims(claims, now);
  if (!stale.length) return [];
  // Surface the few weakest-confidence stale claims individually; summarize rest.
  const ranked = [...stale].sort((a, b) => computeConfidence(a, now) - computeConfidence(b, now));
  const top = ranked.slice(0, 5);
  const out = top.map((c) =>
    suggestion({
      id: `verify:${c.id}`, type: 'verification_refresh', target: c.id,
      direction: 'investigate',
      observation: `freshness ${claimFreshness(c, now)} · confidence ${computeConfidence(c, now)}`,
      recommendation: `Re-verify ${c.id} before it informs any published content.`,
      rationale: 'Stale/low-confidence GEO claim — refresh evidence to keep trust high.',
      confidence: 'medium', sampleSize: c.evidence.length,
    }),
  );
  return out;
}

// ── Engagement-pattern learning ──────────────────────────────────────────────

export function engagementPatternSuggestions(posts: PostAnalyticsRecord[]): OptimizationSuggestion[] {
  if (!posts.length) return [];
  const fb = buildFeedback(posts);
  const out: OptimizationSuggestion[] = [];
  if (fb.successfulCount > 0) {
    out.push(suggestion({
      id: 'pattern:successful', type: 'engagement_pattern', target: 'successful_patterns',
      direction: 'increase',
      observation: `${fb.successfulCount} successful pattern(s)`,
      recommendation: 'Lean into the formats/topics behind successful posts.',
      rationale: 'High score confirmed by strong engagement — repeatable winning patterns.',
      confidence: confidenceFromSample(fb.successfulCount), sampleSize: fb.successfulCount,
    }));
  }
  if (fb.weakCount > 0) {
    out.push(suggestion({
      id: 'pattern:weak', type: 'engagement_pattern', target: 'weak_patterns',
      direction: 'investigate',
      observation: `${fb.weakCount} weak pattern(s)`,
      recommendation: 'Investigate high-score / low-engagement posts — the scoring or angle may be off.',
      rationale: 'Predicted strong but under-engaged — a mismatch worth a human look.',
      confidence: confidenceFromSample(fb.weakCount), sampleSize: fb.weakCount,
    }));
  }
  return out;
}

// ── Aggregation ──────────────────────────────────────────────────────────────

export function buildOptimization(inputs: OptimizationInputs): OptimizationSnapshot {
  const now = inputs.now ?? new Date();
  const suggestions = [
    ...scoringSuggestions(inputs.posts),
    ...sourceTrustSuggestions(inputs.posts),
    ...topicPrioritySuggestions(inputs.posts),
    ...localeFocusSuggestions(inputs.posts),
    ...verificationWarnings(inputs.claims, now),
    ...engagementPatternSuggestions(inputs.posts),
  ].sort((a, b) => CONF_RANK[a.confidence] - CONF_RANK[b.confidence] || a.type.localeCompare(b.type));

  const byType: Record<string, number> = {};
  for (const s of suggestions) byType[s.type] = (byType[s.type] ?? 0) + 1;

  const notes: string[] = [];
  if (inputs.posts.length < 5) {
    notes.push('⚠️ Low data volume — suggestions are low-confidence; treat as hypotheses, not conclusions.');
  }
  const staleN = staleClaims(inputs.claims, now).length;
  if (staleN) notes.push(`🕒 ${staleN} verification claims stale — see verification_refresh suggestions.`);
  notes.push('ℹ️ Recommendations only — a human reviews and applies. No config, scoring, or content is changed automatically.');

  return {
    generatedAt: now.toISOString(),
    suggestions,
    summary: {
      total: suggestions.length,
      byType,
      highConfidence: suggestions.filter((s) => s.confidence === 'high').length,
    },
    notes,
  };
}

export function suggestionsByType(snap: OptimizationSnapshot, type: SuggestionType): OptimizationSuggestion[] {
  return snap.suggestions.filter((s) => s.type === type);
}

// ── Persistence (recommendation snapshots) ───────────────────────────────────

export class OptimizationStore {
  private file: string;
  private dir: string;

  constructor(fileName = 'optimization-snapshots.json', dir = config.paths.data) {
    this.dir = dir;
    this.file = path.join(dir, fileName);
  }

  /** Append a snapshot to the history and return it. */
  save(snapshot: OptimizationSnapshot): OptimizationSnapshot {
    try {
      let list: OptimizationSnapshot[] = [];
      if (fs.existsSync(this.file)) {
        list = JSON.parse(fs.readFileSync(this.file, 'utf-8')) as OptimizationSnapshot[];
      }
      list.push(snapshot);
      if (!fs.existsSync(this.dir)) fs.mkdirSync(this.dir, { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(list, null, 2));
      logger.audit('optimization_snapshot', 'Optimization snapshot saved', {
        total: snapshot.summary.total, highConfidence: snapshot.summary.highConfidence,
      });
    } catch (err) {
      logger.error('optimize', `Failed to persist optimization snapshot: ${(err as Error).message}`);
    }
    return snapshot;
  }

  history(): OptimizationSnapshot[] {
    try {
      if (fs.existsSync(this.file)) return JSON.parse(fs.readFileSync(this.file, 'utf-8')) as OptimizationSnapshot[];
    } catch (err) {
      logger.error('optimize', `Failed to read optimization history: ${(err as Error).message}`);
    }
    return [];
  }

  latest(): OptimizationSnapshot | null {
    const h = this.history();
    return h.length ? h[h.length - 1] : null;
  }
}
