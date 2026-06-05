import fs from 'fs';
import path from 'path';
import { config } from '../../config';
import { logger } from '../../src/logger';
import { normalizeTitle } from '../../src/storage';
import {
  EditorialTopic,
  OptimizationSuggestion,
  QueueItem,
  QueueReviewSummary,
  QueueSource,
  ResearchFinding,
  WorkflowStatus,
} from '../../src/types';

/**
 * Editorial workflow / queue (EPIC 008).
 *
 * One human-gated lifecycle that ingests planner topics, research findings,
 * verification warnings, optimization suggestions and manual ideas, and tracks
 * them through: idea → draft_requested → drafted → in_review → approved →
 * scheduled → published (or → rejected).
 *
 * SAFETY: this module only tracks STATE. It never publishes, never auto-approves,
 * and imports no publisher. Items carrying a verification requirement cannot
 * advance to approved/scheduled/published until a human clears the gate. Every
 * advancing transition requires a `by` (reviewer) — there are no autonomous
 * moves. Publishing remains the separate manual Approve → channel flow.
 */

// ── Status machine ───────────────────────────────────────────────────────────

const TRANSITIONS: Record<WorkflowStatus, WorkflowStatus[]> = {
  idea: ['draft_requested', 'in_review', 'rejected'],
  draft_requested: ['drafted', 'rejected'],
  drafted: ['in_review', 'rejected'],
  in_review: ['approved', 'rejected', 'drafted'],
  approved: ['scheduled', 'rejected'],
  scheduled: ['published', 'approved', 'rejected'],
  rejected: ['idea'],
  published: [],
};

/** Targets that require a cleared verification gate (if one is linked). */
const GATED_TARGETS = new Set<WorkflowStatus>(['approved', 'scheduled', 'published']);

const ACTIVE = (s: WorkflowStatus) => s !== 'rejected' && s !== 'published';

export function canTransition(from: WorkflowStatus, to: WorkflowStatus): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

// ── Ingestion builders (pure) ────────────────────────────────────────────────

const now = () => new Date().toISOString();

function makeItem(partial: Partial<QueueItem> & Pick<QueueItem, 'id' | 'title' | 'source' | 'reason' | 'priority'>): QueueItem {
  const ts = partial.createdAt ?? now();
  return {
    status: 'idea',
    requiredVerification: null,
    verificationCleared: false,
    geo: null,
    locale: null,
    exchange: null,
    notes: null,
    decidedBy: null,
    createdAt: ts,
    updatedAt: ts,
    history: [{ status: partial.status ?? 'idea', at: ts, by: null }],
    ...partial,
  };
}

/** Planner topics → queue ideas. Bonus/verified topics carry a verification gate. */
export function fromPlannerTopics(topics: EditorialTopic[]): QueueItem[] {
  return topics.map((t) =>
    makeItem({
      id: `planner:${t.id}`,
      title: t.title,
      source: 'planner',
      reason: t.reason,
      priority: t.priority,
      geo: t.geo,
      locale: t.locale,
      exchange: t.exchange,
      requiredVerification:
        t.requiredVerification === 'verified' ? `${t.exchange ?? 'claim'}:${t.geo}` : null,
    }),
  );
}

const FINDING_PRIORITY = { HIGH: 85, MEDIUM: 60, LOW: 35 } as const;

/** Research findings → queue ideas. Always carry a verification gate. */
export function fromResearchFindings(findings: ResearchFinding[]): QueueItem[] {
  return findings.map((f) =>
    makeItem({
      id: `research:${f.id}`,
      title: f.title,
      source: 'research',
      reason: f.reason,
      priority: FINDING_PRIORITY[f.priority],
      geo: f.geos[0] ?? null,
      exchange: f.exchanges[0] ?? null,
      // Findings are unverified intelligence → must be verified before publishing.
      requiredVerification: f.exchanges[0] ? `${f.exchanges[0]}:${f.geos[0] ?? 'KZ'}` : 'finding',
    }),
  );
}

const CONF_PRIORITY = { high: 70, medium: 55, low: 40 } as const;

/** Optimization suggestions → queue ideas. verification_refresh → verification source + gate. */
export function fromOptimizationSuggestions(suggestions: OptimizationSuggestion[]): QueueItem[] {
  return suggestions.map((s) => {
    const isVerify = s.type === 'verification_refresh';
    return makeItem({
      id: `${isVerify ? 'verification' : 'optimization'}:${s.id}`,
      title: s.recommendation,
      source: (isVerify ? 'verification' : 'optimization') as QueueSource,
      reason: `${s.type}: ${s.observation}`,
      priority: isVerify ? 65 : CONF_PRIORITY[s.confidence],
      requiredVerification: isVerify ? s.target : null,
    });
  });
}

/** A manual admin idea. */
export function manualIdea(
  title: string,
  opts: { reason?: string; priority?: number; geo?: string; exchange?: string; by?: string } = {},
): QueueItem {
  const slug = normalizeTitle(title).replace(/\s+/g, '-').slice(0, 40) || String(Date.now());
  return makeItem({
    id: `manual:${slug}`,
    title,
    source: 'manual',
    reason: opts.reason ?? 'Manual admin idea',
    priority: opts.priority ?? 50,
    geo: opts.geo ?? null,
    exchange: opts.exchange ?? null,
    notes: opts.by ? `added by ${opts.by}` : null,
  });
}

// ── Prioritization + summaries (pure) ────────────────────────────────────────

const STATUS_RANK: Record<WorkflowStatus, number> = {
  in_review: 0, approved: 1, scheduled: 2, drafted: 3, draft_requested: 4,
  idea: 5, rejected: 6, published: 7,
};

/** Active items, highest priority first (status used as a tiebreak). */
export function prioritize(items: QueueItem[]): QueueItem[] {
  return items
    .filter((i) => ACTIVE(i.status))
    .sort(
      (a, b) =>
        b.priority - a.priority ||
        STATUS_RANK[a.status] - STATUS_RANK[b.status] ||
        a.createdAt.localeCompare(b.createdAt),
    );
}

/** The top N actionable items for today. */
export function generateDailyQueue(items: QueueItem[], limit = 6): QueueItem[] {
  return prioritize(items).slice(0, limit);
}

export function reviewSummary(items: QueueItem[], at = now()): QueueReviewSummary {
  const byStatus: Record<string, number> = {};
  for (const i of items) byStatus[i.status] = (byStatus[i.status] ?? 0) + 1;

  const reviewReady = prioritize(items).filter((i) => i.status === 'in_review' || i.status === 'drafted');
  const blockedByVerification = items.filter(
    (i) => ACTIVE(i.status) && i.requiredVerification && !i.verificationCleared,
  );

  const notes: string[] = [];
  if (blockedByVerification.length) {
    notes.push(`🔒 ${blockedByVerification.length} item(s) blocked until verification clears.`);
  }
  notes.push('ℹ️ Workflow tracks state only — a human approves and publishes. Nothing auto-advances or auto-posts.');

  return { generatedAt: at, byStatus, reviewReady, blockedByVerification, notes };
}

// ── Persistence + transitions ────────────────────────────────────────────────

export interface TransitionResult {
  ok: boolean;
  message: string;
  item?: QueueItem;
}

export class WorkflowStore {
  private file: string;
  private dir: string;
  private byId: Record<string, QueueItem> = {};

  constructor(fileName = 'workflow-queue.json', dir = config.paths.data) {
    this.dir = dir;
    this.file = path.join(dir, fileName);
    this.load();
  }

  private load(): void {
    try {
      if (fs.existsSync(this.file)) {
        this.byId = JSON.parse(fs.readFileSync(this.file, 'utf-8')) as Record<string, QueueItem>;
      }
    } catch (err) {
      logger.error('workflow', `Failed to load queue, starting fresh: ${(err as Error).message}`);
      this.byId = {};
    }
  }

  private persist(): void {
    try {
      if (!fs.existsSync(this.dir)) fs.mkdirSync(this.dir, { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.byId, null, 2));
    } catch (err) {
      logger.error('workflow', `Failed to persist queue: ${(err as Error).message}`);
    }
  }

  get(id: string): QueueItem | undefined {
    return this.byId[id];
  }

  all(): QueueItem[] {
    return Object.values(this.byId);
  }

  byStatus(status: WorkflowStatus): QueueItem[] {
    return this.all().filter((i) => i.status === status);
  }

  /**
   * Add an item, preventing duplicates: by id, and by normalized title across
   * any non-rejected item. Returns the canonical item and whether it was new.
   */
  add(item: QueueItem): { item: QueueItem; added: boolean } {
    if (this.byId[item.id]) return { item: this.byId[item.id], added: false };
    const norm = normalizeTitle(item.title);
    if (norm) {
      const dup = this.all().find((i) => i.status !== 'rejected' && normalizeTitle(i.title) === norm);
      if (dup) return { item: dup, added: false };
    }
    this.byId[item.id] = item;
    this.persist();
    return { item, added: true };
  }

  /** Bulk idempotent ingest. Returns how many were newly added. */
  seed(items: QueueItem[]): number {
    let added = 0;
    for (const it of items) if (this.add(it).added) added++;
    return added;
  }

  /** Mark the linked verification as cleared (human confirms it was verified). */
  clearVerification(id: string, by: string): QueueItem | undefined {
    const item = this.byId[id];
    if (!item) return undefined;
    item.verificationCleared = true;
    item.updatedAt = now();
    this.persist();
    logger.audit('workflow_verification_cleared', `Verification cleared for ${id}`, { by });
    return item;
  }

  /**
   * Move an item to a new status. Enforces the transition map, the verification
   * gate, and requires a human `by`. NEVER publishes anything — 'published' is a
   * record set by a human after the separate manual publish flow.
   */
  transition(id: string, to: WorkflowStatus, by: string): TransitionResult {
    const item = this.byId[id];
    if (!item) return { ok: false, message: 'Queue item not found.' };
    if (!by) return { ok: false, message: 'A reviewer (by) is required — no autonomous transitions.' };
    if (!canTransition(item.status, to)) {
      return { ok: false, message: `Invalid transition ${item.status} → ${to}.` };
    }
    if (GATED_TARGETS.has(to) && item.requiredVerification && !item.verificationCleared) {
      logger.audit('workflow_blocked', `Transition blocked by verification gate`, {
        id, to, requiredVerification: item.requiredVerification,
      });
      return {
        ok: false,
        message: `Blocked: clear verification (${item.requiredVerification}) before ${to}.`,
      };
    }
    item.status = to;
    item.updatedAt = now();
    item.decidedBy = by;
    item.history.push({ status: to, at: item.updatedAt, by });
    this.persist();
    logger.audit('workflow_transition', `Queue item ${id} → ${to}`, { by });
    return { ok: true, message: `Moved to ${to}.`, item };
  }
}
