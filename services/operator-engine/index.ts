import {
  BonusRecord,
  DraftOpportunity,
  EditorialTopic,
  ExchangeRecord,
  OperatorAction,
  OperatorReport,
  OptimizationSuggestion,
  PostAnalyticsRecord,
  QueueItem,
  SystemHealth,
  SystemHealthStatus,
  VerificationClaim,
} from '../../src/types';
import { verificationAnalytics } from '../verification-engine';

/**
 * Operator / orchestration engine (EPIC 010).
 *
 * The human-gated command center. It reads the outputs of every other engine
 * and produces a daily operating picture: system health, next-best owner
 * actions, verification-blocked queue items, the stale-verification queue, and
 * draft opportunities.
 *
 * It RECOMMENDS — it never publishes, approves, or writes to production. Every
 * action it emits is `humanRequired: true`, and it never mutates the queue or
 * any store. Pure + deterministic; helpers exported for testing.
 */

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));
const round = (n: number) => Math.round(n);

const isActive = (i: QueueItem) => i.status !== 'rejected' && i.status !== 'published';
const isBlocked = (i: QueueItem) => isActive(i) && !!i.requiredVerification && !i.verificationCleared;
const isReviewReady = (i: QueueItem) => i.status === 'in_review' || i.status === 'drafted';

export interface OperatorInputs {
  posts: PostAnalyticsRecord[];
  claims: VerificationClaim[];
  bonuses: BonusRecord[];
  exchanges: ExchangeRecord[];
  queue: QueueItem[];
  plannerTopics: EditorialTopic[];
  optimization?: OptimizationSuggestion[];
  now?: Date;
}

// ── System health ────────────────────────────────────────────────────────────

export function buildHealth(inputs: OperatorInputs, now: Date): SystemHealth {
  const va = verificationAnalytics(inputs.claims, inputs.bonuses, now);
  const active = inputs.queue.filter(isActive).length;
  const blocked = inputs.queue.filter(isBlocked).length;
  const staleRatio = va.totalClaims ? va.staleClaims.length / va.totalClaims : 0;

  let status: SystemHealthStatus = 'green';
  if (va.avgConfidence < 20 || staleRatio > 0.75) status = 'red';
  else if (va.avgConfidence < 50 || va.staleClaims.length > 0 || blocked > 0 || va.outdatedBonuses.length > 0) {
    status = 'amber';
  }

  const notes: string[] = [];
  if (va.staleClaims.length) notes.push(`${va.staleClaims.length}/${va.totalClaims} verification claims are stale.`);
  if (va.outdatedBonuses.length) notes.push(`${va.outdatedBonuses.length} bonus(es) unverified/outdated.`);
  if (blocked) notes.push(`${blocked} queue item(s) blocked by verification.`);
  if (!inputs.posts.length) notes.push('No published-post analytics yet — health is provisional.');

  return {
    status,
    verificationConfidenceAvg: va.avgConfidence,
    staleClaims: va.staleClaims.length,
    unverifiedBonuses: va.outdatedBonuses.length,
    queueActive: active,
    queueBlocked: blocked,
    publishedPosts: inputs.posts.length,
    notes,
  };
}

// ── Draft opportunities ──────────────────────────────────────────────────────

/** Top planner topics not already drafted/published in the queue. */
export function draftOpportunities(
  plannerTopics: EditorialTopic[],
  queue: QueueItem[],
  limit = 5,
): DraftOpportunity[] {
  const done = new Set(
    queue.filter((q) => ['drafted', 'in_review', 'approved', 'scheduled', 'published'].includes(q.status))
      .map((q) => q.title.toLowerCase().trim()),
  );
  return [...plannerTopics]
    .filter((t) => !done.has(t.title.toLowerCase().trim()))
    .sort((a, b) => b.priority - a.priority)
    .slice(0, limit)
    .map((t) => ({ id: t.id, title: t.title, priority: t.priority, exchange: t.exchange }));
}

// ── Next best actions ────────────────────────────────────────────────────────

function action(a: Omit<OperatorAction, 'humanRequired'>): OperatorAction {
  return { ...a, humanRequired: true };
}

export function buildNextActions(inputs: OperatorInputs, now: Date): OperatorAction[] {
  const va = verificationAnalytics(inputs.claims, inputs.bonuses, now);
  const blocked = inputs.queue.filter(isBlocked);
  const reviewReady = inputs.queue.filter((i) => isActive(i) && isReviewReady(i));
  const opps = draftOpportunities(inputs.plannerTopics, inputs.queue);
  const actions: OperatorAction[] = [];

  if (reviewReady.length) {
    actions.push(action({
      id: 'act:review-ready', kind: 'review_queue',
      title: `Review ${reviewReady.length} item(s) awaiting a decision`,
      priority: 78, reason: 'Items are drafted / in review and need a human decision.', command: '/review',
    }));
  }
  if (va.staleClaims.length) {
    const staleRatio = va.totalClaims ? va.staleClaims.length / va.totalClaims : 0;
    actions.push(action({
      id: 'act:verify-stale', kind: 'verify',
      title: `Re-verify ${va.staleClaims.length} stale verification claim(s)`,
      priority: clamp(round(55 + staleRatio * 35), 0, 95),
      reason: 'GEO/trust data is stale — refresh before it informs content.', command: '/stale',
    }));
  }
  if (blocked.length) {
    actions.push(action({
      id: 'act:unblock', kind: 'review_queue',
      title: `Clear verification on ${blocked.length} blocked queue item(s)`,
      priority: 68, reason: 'Queue items cannot advance until verification is cleared.', command: '/review',
    }));
  }
  if (va.outdatedBonuses.length) {
    actions.push(action({
      id: 'act:verify-bonuses', kind: 'verify',
      title: `Verify ${va.outdatedBonuses.length} bonus(es) before featuring`,
      priority: 60, reason: 'Unverified/outdated bonuses must not be presented as confirmed.', command: '/bonuses',
    }));
  }
  if (opps.length) {
    const top = opps[0];
    actions.push(action({
      id: 'act:draft', kind: 'create_draft',
      title: `Draft top opportunity: "${top.title}"`,
      priority: 52, reason: 'High-priority planner topic with no draft yet.',
      command: top.exchange ? `/draft ${top.exchange}` : '/draft',
    }));
  }
  const optHigh = (inputs.optimization ?? []).filter((s) => s.confidence === 'high');
  if (optHigh.length) {
    actions.push(action({
      id: 'act:tune', kind: 'tune',
      title: `Review ${optHigh.length} high-confidence optimization suggestion(s)`,
      priority: 44, reason: 'Self-improvement suggestions ready for human review.', command: '/suggestions',
    }));
  }
  if (!actions.length) {
    actions.push(action({
      id: 'act:maintain', kind: 'maintain',
      title: 'No urgent actions — monitor feeds and analytics',
      priority: 20, reason: 'Nothing pressing detected.', command: '/today',
    }));
  }
  return actions.sort((a, b) => b.priority - a.priority);
}

// ── Daily command center ─────────────────────────────────────────────────────

export function buildOperatorReport(inputs: OperatorInputs): OperatorReport {
  const now = inputs.now ?? new Date();
  const health = buildHealth(inputs, now);
  const nextActions = buildNextActions(inputs, now);
  const blockedItems = inputs.queue.filter(isBlocked);
  const staleVerifications = verificationAnalytics(inputs.claims, inputs.bonuses, now).staleClaims;

  const queueStatus: Record<string, number> = {};
  for (const i of inputs.queue) queueStatus[i.status] = (queueStatus[i.status] ?? 0) + 1;

  const notes = [
    'Operator recommendations only — a human executes every action.',
    'No auto-publishing, no auto-approval, no autonomous writes. You remain the final operator.',
  ];

  return {
    generatedAt: now.toISOString(),
    health,
    nextActions,
    blockedItems,
    staleVerifications,
    draftOpportunities: draftOpportunities(inputs.plannerTopics, inputs.queue),
    queueStatus,
    notes,
  };
}
