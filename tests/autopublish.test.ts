import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  AutopublishStore,
  autopublishTick,
  isInPublishWindow,
  kzDateStr,
  generateImageWithRetry,
  PUBLISH_WINDOW_MIN,
  MAX_CONSECUTIVE_FAILURES,
  TickContext,
  TickResult,
} from '../services/autopublish';
import { ChannelPostStore } from '../services/content-center';
import { ChannelPost, ChannelPostStatus, ContentPostType, EvidenceLevel } from '../src/types';

// ── Helpers ──────────────────────────────────────────────────────────────────

const tmpDirs: string[] = [];
function tmpDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cbw-autopub-'));
  tmpDirs.push(d);
  return d;
}
function tmpStore(dir?: string): ChannelPostStore {
  const d = dir ?? tmpDir();
  return new ChannelPostStore('test-autopub.json', d);
}
function tmpAutopublish(dir?: string): AutopublishStore {
  const d = dir ?? tmpDir();
  return new AutopublishStore('test-autopub-state.json', d);
}
afterEach(() => {
  while (tmpDirs.length) {
    const d = tmpDirs.pop()!;
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

function fakePost(topic: string, opts: Partial<ChannelPost> = {}): ChannelPost {
  return {
    id: opts.id ?? `t_${topic}`, title: opts.title ?? topic, caption: opts.caption ?? 'test caption here',
    assetFile: opts.assetFile ?? null,
    topic, postType: opts.postType ?? 'education', evidenceLevel: opts.evidenceLevel ?? 'C',
    imagePrompt: null, requiresImage: opts.requiresImage ?? false, status: opts.status ?? 'ready',
    createdBy: 'test', createdAt: opts.createdAt ?? new Date().toISOString(),
    scheduledAt: opts.scheduledAt ?? null, approvedBy: null, decidedAt: null,
    publishedAt: opts.publishedAt ?? null, channelMessageId: null, rejectionReason: null,
  };
}

const fakeSenderBot = (messageId = 100) => ({
  sendMessage: vi.fn().mockResolvedValue({ message_id: messageId }),
  sendPhoto: vi.fn().mockResolvedValue({ message_id: messageId }),
});

function makeCtx(overrides: Partial<TickContext> = {}): TickContext {
  const dir = tmpDir();
  return {
    store: tmpStore(dir),
    autopublish: tmpAutopublish(dir),
    bot: fakeSenderBot(),
    channelId: '@test_channel',
    notify: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

// ── KZ date helpers ─────────────────────────────────────────────────────────

describe('kzDateStr', () => {
  it('converts UTC to KZ date (UTC+5)', () => {
    // 2026-06-10 20:00 UTC = 2026-06-11 01:00 KZ
    expect(kzDateStr(new Date('2026-06-10T20:00:00Z'))).toBe('2026-06-11');
    // 2026-06-10 04:00 UTC = 2026-06-10 09:00 KZ
    expect(kzDateStr(new Date('2026-06-10T04:00:00Z'))).toBe('2026-06-10');
  });
});

describe('isInPublishWindow', () => {
  it('returns true within ±5 min of target time', () => {
    // Weekday 2026-06-10 (Wednesday). Target = 19:30 KZ = 14:30 UTC
    const at = new Date('2026-06-10T14:30:00Z');
    expect(isInPublishWindow(at)).toBe(true);

    const early = new Date('2026-06-10T14:25:01Z');
    expect(isInPublishWindow(early)).toBe(true);

    const late = new Date('2026-06-10T14:34:59Z');
    expect(isInPublishWindow(late)).toBe(true);
  });

  it('returns false outside the window', () => {
    const tooEarly = new Date('2026-06-10T14:24:00Z');
    expect(isInPublishWindow(tooEarly)).toBe(false);

    const tooLate = new Date('2026-06-10T14:36:00Z');
    expect(isInPublishWindow(tooLate)).toBe(false);
  });

  it('respects weekend schedule (12:30 KZ = 07:30 UTC)', () => {
    // Saturday 2026-06-13 → 12:30 KZ = 07:30 UTC
    const at = new Date('2026-06-13T07:30:00Z');
    expect(isInPublishWindow(at)).toBe(true);

    const miss = new Date('2026-06-13T14:30:00Z');
    expect(isInPublishWindow(miss)).toBe(false);
  });
});

// ── AutopublishStore ────────────────────────────────────────────────────────

describe('AutopublishStore', () => {
  it('starts disabled', () => {
    const ap = tmpAutopublish();
    const state = ap.get();
    expect(state.enabled).toBe(false);
    expect(state.enabledBy).toBeNull();
  });

  it('enable / disable toggles state and persists', () => {
    const dir = tmpDir();
    const ap = tmpAutopublish(dir);
    ap.enable('admin');
    expect(ap.get().enabled).toBe(true);
    expect(ap.get().enabledBy).toBe('admin');

    // Reload from disk
    const ap2 = new AutopublishStore('test-autopub-state.json', dir);
    expect(ap2.get().enabled).toBe(true);

    ap2.disable('admin');
    expect(ap2.get().enabled).toBe(false);
  });

  it('enable resets consecutive failures', () => {
    const ap = tmpAutopublish();
    ap.updateTick({ consecutiveFailures: 3, lastError: 'some error' });
    ap.enable('admin');
    expect(ap.get().consecutiveFailures).toBe(0);
    expect(ap.get().lastError).toBeNull();
  });
});

// ── autopublishTick ─────────────────────────────────────────────────────────

describe('autopublishTick', () => {
  it('returns disabled when toggle is off', async () => {
    const ctx = makeCtx();
    const r = await autopublishTick(ctx);
    expect(r.action).toBe('disabled');
  });

  it('returns not_time_yet outside publish window', async () => {
    const ctx = makeCtx();
    ctx.autopublish.enable('test');
    // 2026-06-10 10:00 UTC — well outside 14:30 window
    ctx.now = new Date('2026-06-10T10:00:00Z');
    const r = await autopublishTick(ctx);
    expect(r.action).toBe('not_time_yet');
  });

  it('returns already_published_today when a post was published today KZ', async () => {
    const ctx = makeCtx();
    ctx.autopublish.enable('test');
    // Wednesday 14:30 UTC
    ctx.now = new Date('2026-06-10T14:30:00Z');

    // Add a published post for today
    const post = fakePost('usdt_basics', {
      status: 'published',
      publishedAt: '2026-06-10T14:00:00.000Z',
    });
    ctx.store.createFull(post.caption, 'test', {
      title: post.title, topic: post.topic, postType: post.postType,
      evidenceLevel: post.evidenceLevel,
    });
    // Manually set it to published
    const all = ctx.store.all();
    const p = all[0];
    ctx.store.update(p.id, { status: 'published' as ChannelPostStatus, publishedAt: '2026-06-10T14:00:00.000Z' });

    const r = await autopublishTick(ctx);
    expect(r.action).toBe('already_published_today');
  });

  it('publishes a ready post during the window', async () => {
    const ctx = makeCtx();
    ctx.autopublish.enable('test');
    ctx.now = new Date('2026-06-10T14:30:00Z');

    // Create a ready post with caption
    const p = ctx.store.createFull('Что такое USDT — гайд для новичков', 'test', {
      title: 'Test USDT', topic: 'usdt_basics', postType: 'education',
      evidenceLevel: 'C', requiresImage: false,
    });
    ctx.store.update(p.id, { status: 'ready' as ChannelPostStatus });

    const r = await autopublishTick(ctx);
    expect(r.action).toBe('published');
    expect(r.postId).toBe(p.id);

    // Verify it was marked published in the store
    const updated = ctx.store.get(p.id);
    expect(updated?.status).toBe('published');
    expect(updated?.channelMessageId).toBe(100);

    // Verify notification was called
    expect(ctx.notify).toHaveBeenCalled();
  });

  it('returns no_eligible_post when only draft/planned posts exist (not ready/approved)', async () => {
    const ctx = makeCtx();
    ctx.autopublish.enable('test');
    ctx.now = new Date('2026-06-10T14:30:00Z');

    // Fill the store with all 60 roadmap topics as rejected so selectNext returns null
    // This prevents the auto-generate path from running (which loads sharp and is slow)
    const { ROADMAP } = await import('../services/roadmap-scheduler');
    for (const entry of ROADMAP) {
      const p = ctx.store.createFull('dummy', 'test', {
        title: entry.title, topic: entry.topicKey, postType: entry.postType,
        evidenceLevel: entry.evidenceLevel, requiresImage: false,
      });
      // Mark as draft (not rejected so they appear in dedup, but not ready/approved)
      // Actually mark non-rejected so topic dedup blocks all entries
    }

    const r = await autopublishTick(ctx);
    // All 60 topics used → generateNextPost returns null → no_eligible_post
    expect(r.action).toBe('no_eligible_post');
  });

  it('auto-disables after MAX_CONSECUTIVE_FAILURES', async () => {
    const ctx = makeCtx();
    ctx.autopublish.enable('test');
    ctx.autopublish.updateTick({ consecutiveFailures: MAX_CONSECUTIVE_FAILURES });
    ctx.now = new Date('2026-06-10T14:30:00Z');

    const r = await autopublishTick(ctx);
    expect(r.action).toBe('auto_disabled_failures');
    expect(ctx.autopublish.get().enabled).toBe(false);
    expect(ctx.notify).toHaveBeenCalled();
  });

  it('records failure and increments consecutiveFailures on publish error', async () => {
    const ctx = makeCtx();
    ctx.autopublish.enable('test');
    ctx.now = new Date('2026-06-10T14:30:00Z');
    ctx.bot = {
      sendMessage: vi.fn().mockRejectedValue(new Error('Telegram API down')),
      sendPhoto: vi.fn().mockRejectedValue(new Error('Telegram API down')),
    };

    // Create a ready text post
    const p = ctx.store.createFull('Гайд по P2P торговле для начинающих', 'test', {
      title: 'P2P Guide', topic: 'p2p_basics', postType: 'education',
      evidenceLevel: 'C', requiresImage: false,
    });
    ctx.store.update(p.id, { status: 'ready' as ChannelPostStatus });

    const r = await autopublishTick(ctx);
    expect(r.action).toBe('publish_failed');
    expect(ctx.autopublish.get().consecutiveFailures).toBe(1);
    expect(ctx.autopublish.get().lastError).toContain('Telegram API down');
  });

  it('prefers earlier scheduledAt when picking eligible post', async () => {
    const ctx = makeCtx();
    ctx.autopublish.enable('test');
    ctx.now = new Date('2026-06-10T14:30:00Z');

    const p1 = ctx.store.createFull('Первый пост — более поздний', 'test', {
      title: 'Later', topic: 'p2p_basics', postType: 'education',
      evidenceLevel: 'C', requiresImage: false,
      scheduledAt: '2026-06-11T14:30:00.000Z',
    });
    ctx.store.update(p1.id, { status: 'ready' as ChannelPostStatus });

    const p2 = ctx.store.createFull('Второй пост — более ранний', 'test', {
      title: 'Earlier', topic: 'usdt_basics', postType: 'education',
      evidenceLevel: 'C', requiresImage: false,
      scheduledAt: '2026-06-10T14:30:00.000Z',
    });
    ctx.store.update(p2.id, { status: 'ready' as ChannelPostStatus });

    const r = await autopublishTick(ctx);
    expect(r.action).toBe('published');
    expect(r.postId).toBe(p2.id);
  });

  it('blocks high-risk topics via canAutoPublish', async () => {
    const ctx = makeCtx();
    ctx.autopublish.enable('test');
    ctx.now = new Date('2026-06-10T14:30:00Z');

    // buy_usdt_kzt is high-risk in the roadmap
    const p = ctx.store.createFull('Как купить USDT за тенге', 'test', {
      title: 'Buy USDT KZT', topic: 'buy_usdt_kzt', postType: 'education',
      evidenceLevel: 'D', requiresImage: false,
    });
    ctx.store.update(p.id, { status: 'ready' as ChannelPostStatus });

    const r = await autopublishTick(ctx);
    expect(r.action).toBe('safety_blocked');
    expect(r.postId).toBe(p.id);
  });

  it('second tick in same KZ day returns already_published_today', async () => {
    const ctx = makeCtx();
    ctx.autopublish.enable('test');
    ctx.now = new Date('2026-06-10T14:30:00Z');

    // Create and publish on first tick
    const p = ctx.store.createFull('Что такое USDT для новичков в криптовалюте', 'test', {
      title: 'USDT basics', topic: 'usdt_basics', postType: 'education',
      evidenceLevel: 'C', requiresImage: false,
    });
    ctx.store.update(p.id, { status: 'ready' as ChannelPostStatus });

    const r1 = await autopublishTick(ctx);
    expect(r1.action).toBe('published');

    // Second tick same day — should be idempotent
    const r2 = await autopublishTick(ctx);
    expect(r2.action).toBe('already_published_today');
  });
});

// ── generateImageWithRetry ──────────────────────────────────────────────────

describe('generateImageWithRetry', () => {
  it('retries on error and returns null after exhausting attempts', async () => {
    const { NullProvider } = await import('../services/image-generator');
    const dir = tmpDir();
    // Use NullProvider which is not configured → resolveImage returns quickly with no image
    const result = await generateImageWithRetry('usdt_basics', 'Test', 'education', {
      maxRetries: 1,
      provider: NullProvider,
      assetDir: dir,
    });
    expect(result.generated).toBe(false);
    expect(result.imageFile).toBeNull();
  });
});
