import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  NEWS_SLOTS_UTC,
  currentNewsSlot,
  newsSlotKey,
  selectTopNewsDraft,
  buildNewsCaption,
  newsAutopublishTick,
  MAX_NEWS_AGE_H,
} from '../services/autopublish/news';
import { AutopublishStore } from '../services/autopublish';
import { renderNewsCard, applyWatermark, wrapHeadline, accentFor, CARD_W, CARD_H } from '../services/news-card';
import { DraftStore } from '../src/draft-store';
import { DraftRecord } from '../src/types';
import sharp from 'sharp';

// ── Helpers ──────────────────────────────────────────────────────────────────

const tmpDirs: string[] = [];
function tmpDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cbw-news-'));
  tmpDirs.push(d);
  return d;
}
afterEach(() => {
  while (tmpDirs.length) {
    const d = tmpDirs.pop()!;
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

function fakeDraft(id: string, opts: Partial<DraftRecord> = {}): DraftRecord {
  return {
    id,
    title: opts.title ?? `News story ${id}`,
    link: opts.link ?? `https://example.com/${id}`,
    source: opts.source ?? 'Cointelegraph',
    publishDate: opts.publishDate ?? new Date().toISOString(),
    category: opts.category ?? 'Global',
    scoreTotal: opts.scoreTotal ?? 50,
    priority: opts.priority ?? 'MEDIUM',
    text: opts.text ?? 'A factual crypto news summary that is safe to publish.',
    status: opts.status ?? 'pending',
    createdAt: opts.createdAt ?? new Date().toISOString(),
  };
}

const fakeBot = (messageId = 200) => ({
  sendMessage: vi.fn().mockResolvedValue({ message_id: messageId }),
  sendPhoto: vi.fn().mockResolvedValue({ message_id: messageId }),
});

// ── Slots ────────────────────────────────────────────────────────────────────

describe('news slots', () => {
  it('detects each UTC slot within ±5 min', () => {
    expect(currentNewsSlot(new Date('2026-06-11T08:00:00Z'))).toBe(0);
    expect(currentNewsSlot(new Date('2026-06-11T08:04:59Z'))).toBe(0);
    expect(currentNewsSlot(new Date('2026-06-11T07:55:30Z'))).toBe(0);
    expect(currentNewsSlot(new Date('2026-06-11T13:02:00Z'))).toBe(1);
    expect(currentNewsSlot(new Date('2026-06-11T18:00:00Z'))).toBe(2);
  });

  it('returns null outside any window', () => {
    expect(currentNewsSlot(new Date('2026-06-11T08:06:00Z'))).toBeNull();
    expect(currentNewsSlot(new Date('2026-06-11T10:00:00Z'))).toBeNull();
    expect(currentNewsSlot(new Date('2026-06-11T23:59:00Z'))).toBeNull();
  });

  it('slot keys are unique per UTC day and slot', () => {
    const k0 = newsSlotKey(new Date('2026-06-11T08:00:00Z'), 0);
    const k1 = newsSlotKey(new Date('2026-06-11T13:00:00Z'), 1);
    const k0next = newsSlotKey(new Date('2026-06-12T08:00:00Z'), 0);
    expect(k0).toBe('2026-06-11#0');
    expect(k1).toBe('2026-06-11#1');
    expect(k0next).toBe('2026-06-12#0');
    expect(new Set([k0, k1, k0next]).size).toBe(3);
  });

  it('has exactly 3 daily slots', () => {
    expect(NEWS_SLOTS_UTC).toHaveLength(3);
  });
});

// ── Selection ────────────────────────────────────────────────────────────────

describe('selectTopNewsDraft', () => {
  const now = new Date('2026-06-11T12:00:00Z');

  it('picks the highest-scored fresh pending draft', () => {
    const drafts = [
      fakeDraft('a', { scoreTotal: 40, publishDate: '2026-06-11T08:00:00Z' }),
      fakeDraft('b', { scoreTotal: 80, publishDate: '2026-06-11T09:00:00Z' }),
      fakeDraft('c', { scoreTotal: 60, publishDate: '2026-06-11T10:00:00Z' }),
    ];
    expect(selectTopNewsDraft(drafts, now)?.id).toBe('b');
  });

  it('skips published / rejected drafts', () => {
    const drafts = [
      fakeDraft('a', { scoreTotal: 90, status: 'published' }),
      fakeDraft('b', { scoreTotal: 85, status: 'rejected' }),
      fakeDraft('c', { scoreTotal: 30 }),
    ];
    expect(selectTopNewsDraft(drafts, now)?.id).toBe('c');
  });

  it('skips stale drafts beyond MAX_NEWS_AGE_H', () => {
    const stale = new Date(now.getTime() - (MAX_NEWS_AGE_H + 2) * 3600 * 1000).toISOString();
    const drafts = [fakeDraft('old', { scoreTotal: 99, publishDate: stale })];
    expect(selectTopNewsDraft(drafts, now)).toBeNull();
  });

  it('skips drafts that fail the content safety validator', () => {
    const drafts = [
      fakeDraft('bad', { scoreTotal: 95, text: 'Guaranteed profit! 50% per day risk-free returns!' }),
      fakeDraft('ok', { scoreTotal: 40 }),
    ];
    expect(selectTopNewsDraft(drafts, now)?.id).toBe('ok');
  });

  it('breaks score ties by newer publish date', () => {
    const drafts = [
      fakeDraft('older', { scoreTotal: 50, publishDate: '2026-06-11T06:00:00Z' }),
      fakeDraft('newer', { scoreTotal: 50, publishDate: '2026-06-11T11:00:00Z' }),
    ];
    expect(selectTopNewsDraft(drafts, now)?.id).toBe('newer');
  });
});

// ── Caption ──────────────────────────────────────────────────────────────────

describe('buildNewsCaption', () => {
  it('appends source attribution and stays under the 1024 caption limit', () => {
    const rec = fakeDraft('x', { text: 'Body. '.repeat(300), source: 'The Block', link: 'https://theblock.co/x' });
    const caption = buildNewsCaption(rec);
    expect(caption.length).toBeLessThanOrEqual(1024);
    expect(caption).toContain('The Block');
    expect(caption).toContain('https://theblock.co/x');
  });
});

// ── Card rendering ───────────────────────────────────────────────────────────

describe('news card', () => {
  it('renders a 1280x720 PNG with deterministic filename', async () => {
    const dir = tmpDir();
    const r = await renderNewsCard('abc123', {
      title: 'Bitcoin ETF inflows hit a new record as institutions pile in',
      category: 'Bitcoin',
      source: 'Cointelegraph',
      publishDate: '2026-06-11T09:00:00Z',
    }, { outDir: dir });
    expect(r.filename).toBe('news_abc123.png');
    expect(fs.existsSync(r.filePath)).toBe(true);
    const meta = await sharp(r.filePath).metadata();
    expect(meta.width).toBe(CARD_W);
    expect(meta.height).toBe(CARD_H);
  });

  it('applyWatermark composites onto an existing image without resizing', async () => {
    const dir = tmpDir();
    const img = path.join(dir, 'plain.png');
    await sharp({ create: { width: 640, height: 360, channels: 4, background: { r: 20, g: 20, b: 30, alpha: 1 } } })
      .png().toFile(img);
    await applyWatermark(img, 'CryptoBonusWorld.com');
    const meta = await sharp(img).metadata();
    expect(meta.width).toBe(640);
    expect(meta.height).toBe(360);
  });

  it('wrapHeadline truncates very long titles with ellipsis', () => {
    const lines = wrapHeadline('word '.repeat(60).trim(), 26, 4);
    expect(lines.length).toBeLessThanOrEqual(4);
    expect(lines[lines.length - 1]).toMatch(/…$/);
  });

  it('accentFor falls back to Global for unknown categories', () => {
    expect(accentFor('Nonsense').label).toBe('CRYPTO NEWS');
    expect(accentFor(null).label).toBe('CRYPTO NEWS');
    expect(accentFor('Bitcoin').label).toBe('BITCOIN');
  });
});

// ── Tick ─────────────────────────────────────────────────────────────────────

function makeCtx(overrides: Record<string, unknown> = {}) {
  const dir = tmpDir();
  const drafts = new DraftStore('test-news-drafts.json', dir);
  const autopublish = new AutopublishStore('test-news-state.json', dir);
  return {
    drafts,
    autopublish,
    bot: fakeBot(),
    channelId: '@test_channel',
    cardDir: path.join(dir, 'cards'),
    notify: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe('newsAutopublishTick', () => {
  it('does nothing when toggle is off', async () => {
    const ctx = makeCtx({ now: new Date('2026-06-11T08:00:00Z') });
    const r = await newsAutopublishTick(ctx as any);
    expect(r.action).toBe('disabled');
  });

  it('waits outside slot windows', async () => {
    const ctx = makeCtx({ now: new Date('2026-06-11T10:00:00Z') });
    (ctx.autopublish as AutopublishStore).enable('test');
    const r = await newsAutopublishTick(ctx as any);
    expect(r.action).toBe('not_time_yet');
  });

  it('publishes the top draft in a slot, renders card, marks draft published', async () => {
    const now = new Date('2026-06-11T13:00:00Z');
    const ctx = makeCtx({ now });
    (ctx.autopublish as AutopublishStore).enable('test');
    (ctx.drafts as DraftStore).add(fakeDraft('n1', { scoreTotal: 70, publishDate: '2026-06-11T11:00:00Z' }));
    (ctx.drafts as DraftStore).add(fakeDraft('n2', { scoreTotal: 30, publishDate: '2026-06-11T11:30:00Z' }));

    const r = await newsAutopublishTick(ctx as any);
    expect(r.action).toBe('published');
    expect(r.draftId).toBe('n1');
    expect(r.slotKey).toBe('2026-06-11#1');

    const rec = (ctx.drafts as DraftStore).get('n1')!;
    expect(rec.status).toBe('published');
    expect(rec.channelMessageId).toBe(200);

    // Card was rendered and sent.
    const sendPhoto = (ctx.bot as ReturnType<typeof fakeBot>).sendPhoto;
    expect(sendPhoto).toHaveBeenCalledOnce();
    const [, photoPath, opts] = sendPhoto.mock.calls[0];
    expect(fs.existsSync(photoPath as string)).toBe(true);
    expect((opts as { caption: string }).caption).toContain('Cointelegraph');
  });

  it('is idempotent within one slot (second tick → already_published_this_slot)', async () => {
    const now = new Date('2026-06-11T08:01:00Z');
    const ctx = makeCtx({ now });
    (ctx.autopublish as AutopublishStore).enable('test');
    (ctx.drafts as DraftStore).add(fakeDraft('n1', { publishDate: '2026-06-11T06:00:00Z' }));
    (ctx.drafts as DraftStore).add(fakeDraft('n2', { publishDate: '2026-06-11T06:30:00Z' }));

    const r1 = await newsAutopublishTick(ctx as any);
    expect(r1.action).toBe('published');
    const r2 = await newsAutopublishTick(ctx as any);
    expect(r2.action).toBe('already_published_this_slot');
  });

  it('publishes again in the NEXT slot of the same day', async () => {
    const ctx = makeCtx({ now: new Date('2026-06-11T08:00:00Z') });
    (ctx.autopublish as AutopublishStore).enable('test');
    (ctx.drafts as DraftStore).add(fakeDraft('n1', { publishDate: '2026-06-11T06:00:00Z' }));
    (ctx.drafts as DraftStore).add(fakeDraft('n2', { publishDate: '2026-06-11T06:30:00Z' }));

    const r1 = await newsAutopublishTick(ctx as any);
    expect(r1.action).toBe('published');

    (ctx as { now: Date }).now = new Date('2026-06-11T13:00:00Z');
    const r2 = await newsAutopublishTick(ctx as any);
    expect(r2.action).toBe('published');
    expect(r2.draftId).not.toBe(r1.draftId);
  });

  it('reports no_eligible_news when the queue is empty', async () => {
    const ctx = makeCtx({ now: new Date('2026-06-11T18:00:00Z') });
    (ctx.autopublish as AutopublishStore).enable('test');
    const r = await newsAutopublishTick(ctx as any);
    expect(r.action).toBe('no_eligible_news');
  });

  it('records failure and increments consecutiveFailures on send error', async () => {
    const ctx = makeCtx({
      now: new Date('2026-06-11T08:00:00Z'),
      bot: {
        sendMessage: vi.fn().mockRejectedValue(new Error('telegram down')),
        sendPhoto: vi.fn().mockRejectedValue(new Error('telegram down')),
      },
    });
    (ctx.autopublish as AutopublishStore).enable('test');
    (ctx.drafts as DraftStore).add(fakeDraft('n1', { publishDate: '2026-06-11T06:00:00Z' }));

    const r = await newsAutopublishTick(ctx as any);
    expect(r.action).toBe('publish_failed');
    const st = (ctx.autopublish as AutopublishStore).get();
    expect(st.consecutiveFailures).toBe(1);
    expect(st.lastError).toContain('telegram down');
    // Draft stays pending for the next slot.
    expect((ctx.drafts as DraftStore).get('n1')!.status).toBe('pending');
  });
});
