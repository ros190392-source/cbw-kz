import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  buildDailyPlan, nextDueItem, isExpired, makeRng, seedFromDate, SCHEDULE, ATTEMPT_WINDOW_MIN, DailyPlan,
} from '../services/autopublish/schedule';
import { organicAutopublishTick } from '../services/autopublish/organic';
import { AutopublishStore } from '../services/autopublish';
import { DraftStore } from '../src/draft-store';
import { DraftRecord } from '../src/types';
import { PromoItem } from '../services/promo-radar';

const tmpDirs: string[] = [];
function tmpDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cbw-organic-'));
  tmpDirs.push(d);
  return d;
}
afterEach(() => {
  while (tmpDirs.length) {
    const d = tmpDirs.pop()!;
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

// ── Schedule (pure) ───────────────────────────────────────────────────────────

describe('buildDailyPlan', () => {
  const now = new Date('2026-06-14T03:00:00Z');

  it('is deterministic for the same date + salt', () => {
    const a = buildDailyPlan(now, 7);
    const b = buildDailyPlan(now, 7);
    expect(a).toEqual(b);
  });

  it('varies with the salt', () => {
    const a = JSON.stringify(buildDailyPlan(now, 1).items.map(i => [i.at, i.lane]));
    const b = JSON.stringify(buildDailyPlan(now, 2).items.map(i => [i.at, i.lane]));
    expect(a).not.toBe(b);
  });

  it('produces a count within the configured range', () => {
    for (let salt = 0; salt < 40; salt++) {
      const n = buildDailyPlan(now, salt).items.length;
      expect(n).toBeGreaterThanOrEqual(SCHEDULE.exMin + SCHEDULE.glMin);
      expect(n).toBeLessThanOrEqual(SCHEDULE.exMax + SCHEDULE.glMax);
    }
  });

  it('keeps all times inside the active window, sorted, min-gap apart', () => {
    for (let salt = 0; salt < 40; salt++) {
      const plan = buildDailyPlan(now, salt);
      const mins = plan.items.map(i => new Date(i.at).getUTCHours() * 60 + new Date(i.at).getUTCMinutes());
      for (const m of mins) {
        expect(m).toBeGreaterThanOrEqual(SCHEDULE.windowStartH * 60);
        expect(m).toBeLessThanOrEqual(SCHEDULE.windowEndH * 60);
      }
      const sorted = [...mins].sort((a, b) => a - b);
      expect(mins).toEqual(sorted);
      for (let i = 1; i < mins.length; i++) {
        expect(mins[i] - mins[i - 1]).toBeGreaterThanOrEqual(SCHEDULE.minGapMin);
      }
    }
  });

  it('uses only known lanes and at least one of each news lane', () => {
    const plan = buildDailyPlan(now, 3);
    for (const it of plan.items) expect(['exchange', 'global', 'bonus']).toContain(it.lane);
    const hasExchangeOrBonus = plan.items.some(i => i.lane === 'exchange' || i.lane === 'bonus');
    const hasGlobal = plan.items.some(i => i.lane === 'global');
    expect(hasExchangeOrBonus).toBe(true);
    expect(hasGlobal).toBe(true);
  });
});

describe('nextDueItem / isExpired', () => {
  const base: DailyPlan = {
    date: '2026-06-14', seed: 1,
    items: [
      { id: '2026-06-14#0', at: '2026-06-14T08:00:00Z', lane: 'global', status: 'pending', attempts: 0 },
      { id: '2026-06-14#1', at: '2026-06-14T10:00:00Z', lane: 'exchange', status: 'pending', attempts: 0 },
    ],
  };

  it('returns the earliest pending item whose time has come', () => {
    expect(nextDueItem(base, new Date('2026-06-14T07:59:00Z'))).toBeNull();
    expect(nextDueItem(base, new Date('2026-06-14T08:01:00Z'))?.id).toBe('2026-06-14#0');
    expect(nextDueItem(base, new Date('2026-06-14T10:01:00Z'))?.id).toBe('2026-06-14#0'); // #0 still pending
  });

  it('skips non-pending items', () => {
    const plan: DailyPlan = { ...base, items: [{ ...base.items[0], status: 'posted' }, base.items[1]] };
    expect(nextDueItem(plan, new Date('2026-06-14T10:01:00Z'))?.id).toBe('2026-06-14#1');
  });

  it('isExpired after the attempt window', () => {
    const it = base.items[0];
    expect(isExpired(it, new Date('2026-06-14T08:30:00Z'))).toBe(false);
    expect(isExpired(it, new Date(`2026-06-14T08:${ATTEMPT_WINDOW_MIN + 5}:00Z`))).toBe(true);
  });
});

describe('makeRng / seedFromDate', () => {
  it('rng is deterministic and in [0,1)', () => {
    const r1 = makeRng(123); const r2 = makeRng(123);
    for (let i = 0; i < 5; i++) {
      const v = r1();
      expect(v).toBe(r2());
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
  it('seedFromDate is stable and salt-sensitive', () => {
    expect(seedFromDate('2026-06-14', 0)).toBe(seedFromDate('2026-06-14', 0));
    expect(seedFromDate('2026-06-14', 0)).not.toBe(seedFromDate('2026-06-14', 1));
  });
});

// ── Organic tick (integration with mocks) ─────────────────────────────────────

function fakeDraft(id: string, opts: Partial<DraftRecord> = {}): DraftRecord {
  return {
    id, title: opts.title ?? `Story ${id}`, link: opts.link ?? `https://example.com/${id}`,
    source: opts.source ?? 'Cointelegraph', publishDate: opts.publishDate ?? new Date().toISOString(),
    category: opts.category ?? 'Global', scoreTotal: opts.scoreTotal ?? 50, priority: opts.priority ?? 'MEDIUM',
    text: opts.text ?? 'A factual crypto news summary that is safe to publish.',
    status: opts.status ?? 'pending', createdAt: new Date().toISOString(), publishedAt: opts.publishedAt ?? null,
  };
}
const fakeBot = () => ({ sendMessage: vi.fn().mockResolvedValue({ message_id: 1 }), sendPhoto: vi.fn().mockResolvedValue({ message_id: 42 }) });

function setup(lane: 'exchange' | 'global' | 'bonus', drafts: DraftRecord[], promos: PromoItem[] = []) {
  const dir = tmpDir();
  const store = new DraftStore('drafts.json', dir);
  for (const d of drafts) store.add(d);
  const autopublish = new AutopublishStore('autopublish-state.json', dir);
  autopublish.enable('test');
  const now = new Date('2026-06-14T09:00:00Z');
  autopublish.updateTick({
    dailyPlan: { date: '2026-06-14', seed: 1, items: [{ id: '2026-06-14#0', at: '2026-06-14T08:50:00Z', lane, status: 'pending', attempts: 0 }] },
  });
  const bot = fakeBot();
  return {
    dir, store, autopublish, bot, now,
    ctx: {
      drafts: store, autopublish, bot, channelId: '@T', now, cardDir: dir,
      banner: false, collect: async () => promos,
    },
  };
}

describe('organicAutopublishTick', () => {
  it('does nothing when disabled', async () => {
    const s = setup('global', [fakeDraft('a')]);
    s.autopublish.disable('test');
    const r = await organicAutopublishTick(s.ctx as any);
    expect(r.action).toBe('disabled');
  });

  it('publishes a global story for a due global slot and marks it posted', async () => {
    const s = setup('global', [fakeDraft('g', { title: 'Bitcoin reclaims a key level as ETFs absorb supply', scoreTotal: 90 })]);
    const r = await organicAutopublishTick(s.ctx as any);
    expect(r.action).toBe('published');
    expect(r.lane).toBe('global');
    expect(s.bot.sendPhoto).toHaveBeenCalledTimes(1);
    // idempotent: same slot won't post twice
    const r2 = await organicAutopublishTick(s.ctx as any);
    expect(r2.action).toBe('no_due_item');
    expect(s.bot.sendPhoto).toHaveBeenCalledTimes(1);
  });

  it('exchange slot picks an exchange story, not a global one', async () => {
    const s = setup('exchange', [
      fakeDraft('glob', { title: 'Macro: inflation prints cool off', scoreTotal: 99 }),
      fakeDraft('exch', { title: 'Binance lists a new token on launchpool', scoreTotal: 40 }),
    ]);
    const r = await organicAutopublishTick(s.ctx as any);
    expect(r.action).toBe('published');
    expect(r.draftId).toBe('exch');
  });

  it('retries (waiting) when no eligible content yet, then skips after the window', async () => {
    const s = setup('global', [fakeDraft('x', { title: 'Binance launchpool', scoreTotal: 80 })]); // only exchange story → global lane finds nothing
    const r = await organicAutopublishTick(s.ctx as any);
    expect(r.action).toBe('waiting_no_content');
    // jump past the attempt window
    const later = { ...s.ctx, now: new Date('2026-06-14T09:50:00Z') };
    const r2 = await organicAutopublishTick(later as any);
    expect(r2.action).toBe('skipped_no_content');
  });

  it('bonus slot publishes a promo and records dedup state', async () => {
    const promo: PromoItem = {
      exchangeSlug: 'bybit', exchangeName: 'Bybit', title: 'Trade to share rewards',
      url: 'https://announcements.bybit.com/x', publishedAt: Date.now() - 3_600_000, endsAt: null,
    };
    const s = setup('bonus', [], [promo]);
    const r = await organicAutopublishTick(s.ctx as any);
    expect(r.action).toBe('published');
    expect(r.promoUrl).toBe(promo.url);
    expect(s.autopublish.get().postedPromoUrls).toContain(promo.url);
    expect(s.autopublish.get().lastPromoExchange).toBe('bybit');
  });

  it('bonus slot falls back to exchange news when no promo is available', async () => {
    const s = setup('bonus', [fakeDraft('exch', { title: 'OKX adds new trading pairs', scoreTotal: 70 })], []);
    const r = await organicAutopublishTick(s.ctx as any);
    expect(r.action).toBe('published');
    expect(r.draftId).toBe('exch');
  });
});
