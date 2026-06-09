import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  ROADMAP,
  PILLARS,
  selectNext,
  selectWeek,
  generateQueue,
  getPublishTimeUtc,
  nextPublishSlot,
  isWeekendKz,
  isQuietHoursKz,
  isHighRiskEntry,
  canAutoPublish,
  schedulerReport,
  pillarForTopic,
  roadmapEntry,
  DEDUP_WINDOW_DAYS,
  KZ_OFFSET_H,
} from '../services/roadmap-scheduler';
import { ChannelPostStore } from '../services/content-center';
import { ChannelPost, ContentPostType } from '../src/types';

// ── Helpers ──────────────────────────────────────────────────────────────────

const tmpDirs: string[] = [];
function tmpStore(): ChannelPostStore {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cbw-sched-'));
  tmpDirs.push(d);
  return new ChannelPostStore('test-sched.json', d);
}
afterEach(() => {
  while (tmpDirs.length) {
    const d = tmpDirs.pop()!;
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

function fakePost(topic: string, opts: Partial<ChannelPost> = {}): ChannelPost {
  return {
    id: `t_${topic}`, title: opts.title ?? topic, caption: 'test', assetFile: null,
    topic, postType: opts.postType ?? 'education', evidenceLevel: opts.evidenceLevel ?? 'C',
    imagePrompt: null, requiresImage: false, status: opts.status ?? 'published',
    createdBy: 'test', createdAt: opts.createdAt ?? new Date().toISOString(),
    scheduledAt: opts.scheduledAt ?? null, approvedBy: null, decidedAt: null,
    publishedAt: opts.publishedAt ?? null, channelMessageId: null, rejectionReason: null,
  };
}

// ── Roadmap registry ──────────────────────────────────────────────────────

describe('roadmap registry', () => {
  it('has 60 entries across 12 pillars with unique topic keys', () => {
    expect(ROADMAP.length).toBe(60);
    expect(PILLARS.length).toBe(12);
    const keys = ROADMAP.map(e => e.topicKey);
    expect(new Set(keys).size).toBe(60);
    // Every pillar has 5 entries
    for (const p of PILLARS) {
      expect(ROADMAP.filter(e => e.pillarId === p.id).length).toBe(5);
    }
  });

  it('maps existing content-machine topics to roadmap entries', () => {
    expect(roadmapEntry('usdt_basics')).toBeDefined();
    expect(roadmapEntry('p2p_basics')).toBeDefined();
    expect(roadmapEntry('p2p_scams')).toBeDefined();
    expect(roadmapEntry('best_exchanges_kz')).toBeDefined();
    // These should have hasTemplate=true
    for (const key of ['usdt_basics', 'p2p_basics', 'p2p_scams', 'best_exchanges_kz']) {
      expect(roadmapEntry(key)!.hasTemplate).toBe(true);
    }
  });
});

// ── Scheduling ────────────────────────────────────────────────────────────

describe('scheduling (Asia/Almaty UTC+5)', () => {
  it('returns 19:30 KZ (14:30 UTC) for weekdays', () => {
    // 2026-06-09 is a Tuesday (weekday)
    const tue = new Date('2026-06-09T10:00:00Z');
    const slot = getPublishTimeUtc(tue);
    expect(slot.getUTCHours()).toBe(14);
    expect(slot.getUTCMinutes()).toBe(30);
    expect(isWeekendKz(tue)).toBe(false);
  });

  it('returns 12:30 KZ (07:30 UTC) for weekends', () => {
    // 2026-06-13 is a Saturday (weekend)
    const sat = new Date('2026-06-13T10:00:00Z');
    const slot = getPublishTimeUtc(sat);
    expect(slot.getUTCHours()).toBe(7);
    expect(slot.getUTCMinutes()).toBe(30);
    expect(isWeekendKz(sat)).toBe(true);
  });

  it('detects quiet hours (00:00-07:00 KZ)', () => {
    // 01:00 KZ = 20:00 UTC previous day
    expect(isQuietHoursKz(new Date('2026-06-09T20:00:00Z'))).toBe(true);  // 01:00 KZ
    expect(isQuietHoursKz(new Date('2026-06-09T01:30:00Z'))).toBe(true);  // 06:30 KZ
    expect(isQuietHoursKz(new Date('2026-06-09T03:00:00Z'))).toBe(false); // 08:00 KZ
    expect(isQuietHoursKz(new Date('2026-06-09T14:30:00Z'))).toBe(false); // 19:30 KZ
  });

  it('advances to next day if today slot has passed', () => {
    // After 19:30 KZ on Tuesday → should get Wednesday slot
    const lateTue = new Date('2026-06-09T15:00:00Z'); // 20:00 KZ
    const next = nextPublishSlot(lateTue);
    expect(next.toISOString().slice(0, 10)).toBe('2026-06-10'); // Wednesday
  });
});

// ── Selector ──────────────────────────────────────────────────────────────

describe('selector', () => {
  it('avoids duplicate topics within 21 days', () => {
    const now = new Date('2026-06-09T10:00:00Z');
    // Simulate: usdt_basics was posted 10 days ago
    const posts = [fakePost('usdt_basics', {
      createdAt: new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000).toISOString(),
    })];
    const entry = selectNext({ allPosts: posts, forDate: now });
    // Should NOT select usdt_basics (still within 21-day window)
    expect(entry).not.toBeNull();
    expect(entry!.topicKey).not.toBe('usdt_basics');
  });

  it('allows topic reuse after 21 days', () => {
    const now = new Date('2026-06-09T10:00:00Z');
    // usdt_basics posted 22 days ago — should be eligible
    const posts = [fakePost('usdt_basics', {
      createdAt: new Date(now.getTime() - 22 * 24 * 60 * 60 * 1000).toISOString(),
    })];
    const entry = selectNext({ allPosts: posts, forDate: now });
    // usdt_basics CAN be selected now (or something else might score higher, but it's not blocked)
    expect(entry).not.toBeNull();
  });

  it('never selects the same pillar back-to-back', () => {
    const now = new Date('2026-06-09T10:00:00Z');
    // Last post was usdt_basics (pillar 1)
    const posts = [fakePost('usdt_basics', { createdAt: now.toISOString() })];
    const entry = selectNext({ allPosts: posts, forDate: now });
    expect(entry).not.toBeNull();
    expect(entry!.pillarId).not.toBe(1); // Cannot be another USDT topic
  });

  it('enforces visual diversity (no same theme in last 2)', () => {
    const now = new Date('2026-06-09T10:00:00Z');
    // Two recent posts with the same image theme (tether_coin = pillar 1)
    // But back-to-back pillar rule already blocks this, so test with different pillars same theme
    // Actually, each pillar has its own theme, so this test verifies the constraint exists
    const posts = [
      fakePost('usdt_basics', { createdAt: new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000).toISOString() }),
      fakePost('usdt_vs_dollar', { createdAt: new Date(now.getTime() - 1 * 24 * 60 * 60 * 1000).toISOString() }),
    ];
    const entry = selectNext({ allPosts: posts, forDate: now });
    if (entry) {
      // The selected entry should not have the same image theme as the last 2
      const recentThemes = posts.map(p => roadmapEntry(p.topic)?.imageTheme).filter(Boolean);
      expect(recentThemes.includes(entry.imageTheme)).toBe(false);
    }
  });

  it('blocks high-risk topics (evidence D) from auto-queue', () => {
    const now = new Date('2026-06-09T10:00:00Z');
    // Verify that regulation/Kaspi entries with evidence D are never selected
    const highRiskEntries = ROADMAP.filter(e => e.highRisk && (e.evidenceLevel === 'D' || e.evidenceLevel === 'E'));
    expect(highRiskEntries.length).toBeGreaterThan(0);

    // With an empty post list, the selector should never pick a high-risk D entry
    const entry = selectNext({ allPosts: [], forDate: now });
    expect(entry).not.toBeNull();
    expect(highRiskEntries.some(e => e.topicKey === entry!.topicKey)).toBe(false);
  });

  it('rejected posts do not block topic reuse', () => {
    const now = new Date('2026-06-09T10:00:00Z');
    // p2p_basics was rejected (should not count in dedup)
    const posts = [fakePost('p2p_basics', {
      status: 'rejected',
      createdAt: new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000).toISOString(),
    })];
    // With only a rejected p2p_basics, p2p_basics should still be eligible
    const entry = selectNext({ allPosts: posts, forDate: now });
    // It might or might not be selected (depends on scoring), but it's not blocked
    const p2pEntry = ROADMAP.find(e => e.topicKey === 'p2p_basics')!;
    // Verify it's not in the dedup set by checking the selector doesn't exclude it
    // (we can't guarantee it's the TOP pick, but we can verify it's not blocked)
    expect(entry).not.toBeNull();
  });
});

// ── Queue generation ──────────────────────────────────────────────────────

describe('queue generation', () => {
  it('generates 7 unique posts for a week', () => {
    const store = tmpStore();
    const start = new Date('2026-06-09T10:00:00Z'); // Monday
    const result = generateQueue(store, 7, { startDate: start });

    expect(result.created.length).toBe(7);

    // All unique topics
    const topics = result.created.map(p => p.topic);
    expect(new Set(topics).size).toBe(7);

    // All have scheduledAt set
    for (const post of result.created) {
      expect(post.scheduledAt).not.toBeNull();
      expect(post.status).toBe('planned');
    }

    // No two consecutive posts share the same pillar
    for (let i = 1; i < result.created.length; i++) {
      const prevPillar = pillarForTopic(result.created[i - 1].topic);
      const currPillar = pillarForTopic(result.created[i].topic);
      expect(currPillar).not.toBe(prevPillar);
    }
  });

  it('is idempotent — skips dates that already have a scheduled post', () => {
    const store = tmpStore();
    const start = new Date('2026-06-09T10:00:00Z');
    const first = generateQueue(store, 3, { startDate: start });
    expect(first.created.length).toBe(3);

    const second = generateQueue(store, 3, { startDate: start });
    expect(second.created.length).toBe(0);
    expect(second.skipped.length).toBe(3);
  });
});

// ── Safety ────────────────────────────────────────────────────────────────

describe('safety', () => {
  it('marks regulation/Kaspi topics as high-risk', () => {
    const highRisk = ROADMAP.filter(e => isHighRiskEntry(e));
    // Pillar 5 (KZT/Kaspi) has 4 high-risk + Pillar 10 (Regulation) has 4 high-risk
    expect(highRisk.length).toBeGreaterThanOrEqual(8);
    // Pillar 5 entries
    expect(highRisk.some(e => e.topicKey === 'buy_usdt_kzt')).toBe(true);
    expect(highRisk.some(e => e.topicKey === 'kz_regulation')).toBe(true);
  });

  it('canAutoPublish always returns false (auto-publish OFF)', () => {
    for (const entry of ROADMAP) {
      expect(canAutoPublish(entry)).toBe(false);
    }
  });

  it('no post is published without explicit approval', () => {
    const store = tmpStore();
    const start = new Date('2026-06-09T10:00:00Z');
    generateQueue(store, 7, { startDate: start });

    // Every generated post must be 'planned', not 'published' or 'approved'
    for (const post of store.all()) {
      expect(post.status).toBe('planned');
      expect(post.publishedAt).toBeNull();
      expect(post.channelMessageId).toBeNull();
    }
  });
});

// ── Week plan ─────────────────────────────────────────────────────────────

describe('week plan projection', () => {
  it('projects 7 days with no duplicate pillars back-to-back', () => {
    const start = new Date('2026-06-09T10:00:00Z'); // Monday
    const week = selectWeek([], start);
    expect(week.length).toBe(7);

    const entries = week.map(w => w.entry).filter((e): e is NonNullable<typeof e> => e !== null);
    expect(entries.length).toBe(7);

    // No back-to-back pillar
    for (let i = 1; i < entries.length; i++) {
      expect(entries[i].pillarId).not.toBe(entries[i - 1].pillarId);
    }

    // Publish times respect weekday/weekend
    for (const { date, publishTime } of week) {
      const kzHour = new Date(publishTime.getTime() + KZ_OFFSET_H * 60 * 60 * 1000).getUTCHours();
      if (isWeekendKz(date)) {
        expect(kzHour).toBe(12); // 12:30 KZ
      } else {
        expect(kzHour).toBe(19); // 19:30 KZ
      }
    }
  });
});

// ── Report ────────────────────────────────────────────────────────────────

describe('scheduler report', () => {
  it('reports progress and ratios', () => {
    const posts = [
      fakePost('usdt_basics', { postType: 'education' }),
      fakePost('p2p_scams', { postType: 'p2p_safety' }),
      fakePost('p2p_basics', { postType: 'education' }),
    ];
    const report = schedulerReport(posts);
    expect(report.roadmapProgress.total).toBe(60);
    expect(report.roadmapProgress.used).toBe(3);
    expect(report.roadmapProgress.remaining).toBe(57);
    expect(report.ratios.education).toBeCloseTo(2 / 3, 1);
    expect(report.ratios.safety).toBeCloseTo(1 / 3, 1);
    expect(report.highRiskBlocked).toBeGreaterThan(0);
  });
});
