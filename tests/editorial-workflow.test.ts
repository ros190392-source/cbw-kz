import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  WorkflowStore,
  canTransition,
  fromOptimizationSuggestions,
  fromPlannerTopics,
  fromResearchFindings,
  generateDailyQueue,
  manualIdea,
  prioritize,
  reviewSummary,
} from '../services/editorial-workflow';
import {
  EditorialTopic,
  OptimizationSuggestion,
  ResearchFinding,
} from '../src/types';

function topic(over: Partial<EditorialTopic> = {}): EditorialTopic {
  return {
    id: over.id ?? 'bonus:bybit-x', title: over.title ?? 'Bybit bonus', type: over.type ?? 'bonus',
    exchange: over.exchange ?? 'bybit', geo: over.geo ?? 'KZ', locale: over.locale ?? 'ru-KZ',
    priority: over.priority ?? 80, priorityBand: 'high', reason: 'r', confidence: 70,
    suggestedCta: '{{CTA}}', requiredVerification: over.requiredVerification ?? 'verified',
  };
}

function finding(over: Partial<ResearchFinding> = {}): ResearchFinding {
  return {
    id: over.id ?? 'f1', title: over.title ?? 'Launchpool news', link: '', source: 'Cointelegraph',
    category: 'launchpool', priority: over.priority ?? 'HIGH', exchanges: over.exchanges ?? ['bybit'],
    geos: over.geos ?? ['KZ'], signals: [], sourceTrust: 'trusted', confidence: 90, reason: 'r',
    humanVerificationRequired: true, foundAt: '2026-06-01T00:00:00.000Z',
  };
}

function suggestion(over: Partial<OptimizationSuggestion> = {}): OptimizationSuggestion {
  return {
    id: over.id ?? 'verify:bybit:KZ:p2p', type: over.type ?? 'verification_refresh',
    target: over.target ?? 'bybit:KZ:p2p', direction: 'investigate', observation: 'o',
    recommendation: over.recommendation ?? 'Re-verify bybit:KZ:p2p', rationale: 'r',
    confidence: over.confidence ?? 'medium', sampleSize: 1, humanReviewRequired: true,
  };
}

const tmpDirs: string[] = [];
function store(): WorkflowStore {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cbw-wf-'));
  tmpDirs.push(dir);
  return new WorkflowStore('workflow-queue.json', dir);
}
afterEach(() => {
  while (tmpDirs.length) {
    const d = tmpDirs.pop()!;
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

describe('queue creation', () => {
  it('adds a manual idea as status idea', () => {
    const s = store();
    const res = s.add(manualIdea('Cover Kaspi deposits'));
    expect(res.added).toBe(true);
    expect(res.item.status).toBe('idea');
    expect(s.get(res.item.id)).toBeDefined();
  });
});

describe('duplicate prevention', () => {
  it('rejects the same id and the same normalized title', () => {
    const s = store();
    const a = s.add(manualIdea('Bybit Launchpool guide'));
    expect(a.added).toBe(true);
    expect(s.add(manualIdea('Bybit Launchpool guide')).added).toBe(false); // same id (slug)
    // same title, different id source still de-dupes by normalized title
    const dup = s.add({ ...a.item, id: 'planner:other' });
    expect(dup.added).toBe(false);
    expect(s.all()).toHaveLength(1);
  });
});

describe('ingestion builders', () => {
  it('planner topics carry a verification gate when verified is required', () => {
    const [q] = fromPlannerTopics([topic({ requiredVerification: 'verified', exchange: 'bybit', geo: 'KZ' })]);
    expect(q.id).toBe('planner:bonus:bybit-x');
    expect(q.requiredVerification).toBe('bybit:KZ');
    expect(q.status).toBe('idea');
  });
  it('research findings are always gated and priority-mapped', () => {
    const [q] = fromResearchFindings([finding({ priority: 'HIGH' })]);
    expect(q.source).toBe('research');
    expect(q.priority).toBe(85);
    expect(q.requiredVerification).toBe('bybit:KZ');
  });
  it('optimization verification_refresh becomes a gated verification item', () => {
    const [q] = fromOptimizationSuggestions([suggestion()]);
    expect(q.source).toBe('verification');
    expect(q.requiredVerification).toBe('bybit:KZ:p2p');
  });
});

describe('status transitions', () => {
  it('follows the allowed map and records history + reviewer', () => {
    const s = store();
    const id = s.add(manualIdea('No-gate idea')).item.id; // manual → no verification gate
    expect(s.transition(id, 'in_review', 'alice').ok).toBe(true);
    expect(s.transition(id, 'approved', 'alice').ok).toBe(true);
    expect(s.transition(id, 'scheduled', 'alice').ok).toBe(true);
    const pub = s.transition(id, 'published', 'alice');
    expect(pub.ok).toBe(true);
    expect(pub.item!.status).toBe('published');
    expect(pub.item!.history.length).toBeGreaterThanOrEqual(5);
  });

  it('rejects invalid transitions', () => {
    const s = store();
    const id = s.add(manualIdea('x')).item.id;
    expect(s.transition(id, 'published', 'alice').ok).toBe(false); // idea → published not allowed
    expect(canTransition('idea', 'published')).toBe(false);
    expect(canTransition('scheduled', 'published')).toBe(true);
  });

  it('published is terminal', () => {
    expect(canTransition('published', 'idea')).toBe(false);
  });
});

describe('verification-gated items', () => {
  it('blocks advancing to approved until verification is cleared', () => {
    const s = store();
    const item = s.add(fromPlannerTopics([topic({ requiredVerification: 'verified' })])[0]).item;
    s.transition(item.id, 'in_review', 'alice');
    const blocked = s.transition(item.id, 'approved', 'alice');
    expect(blocked.ok).toBe(false);
    expect(blocked.message).toMatch(/verification/i);

    s.clearVerification(item.id, 'alice');
    expect(s.transition(item.id, 'approved', 'alice').ok).toBe(true);
  });
});

describe('no auto-publish / no autonomous action guarantee', () => {
  it('requires a human reviewer for every transition', () => {
    const s = store();
    const id = s.add(manualIdea('y')).item.id;
    expect(s.transition(id, 'in_review', '').ok).toBe(false); // empty `by` → refused
  });

  it('read/prioritize/summary helpers never advance status', () => {
    const s = store();
    s.seed([
      ...fromPlannerTopics([topic({ id: 't1', title: 'A' })]),
      ...fromResearchFindings([finding({ id: 'f1', title: 'B' })]),
    ]);
    generateDailyQueue(s.all());
    reviewSummary(s.all());
    prioritize(s.all());
    expect(s.all().every((i) => i.status === 'idea')).toBe(true); // nothing auto-advanced
  });
});

describe('prioritization + review summary', () => {
  it('prioritizes by priority and excludes rejected/published', () => {
    const s = store();
    const hi = s.add(manualIdea('High', { priority: 90 })).item;
    const lo = s.add(manualIdea('Low', { priority: 10 })).item;
    s.transition(lo.id, 'rejected', 'alice');
    const ordered = prioritize(s.all());
    expect(ordered[0].id).toBe(hi.id);
    expect(ordered.find((i) => i.id === lo.id)).toBeUndefined(); // rejected excluded
  });

  it('summary lists review-ready and verification-blocked items', () => {
    const s = store();
    const gated = s.add(fromPlannerTopics([topic({ id: 'g', title: 'Gated' })])[0]).item;
    const free = s.add(manualIdea('Free idea')).item;
    s.transition(free.id, 'in_review', 'alice');
    const sum = reviewSummary(s.all());
    expect(sum.reviewReady.some((i) => i.id === free.id)).toBe(true);
    expect(sum.blockedByVerification.some((i) => i.id === gated.id)).toBe(true);
    expect(sum.notes.some((n) => n.includes('human approves'))).toBe(true);
  });
});
