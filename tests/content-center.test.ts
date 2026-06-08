import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  ChannelPostStore,
  assetExists,
  assetPath,
  contentCenterReport,
  listAssets,
  newPost,
  publishChannelPost,
  validatePost,
  SenderBot,
} from '../services/content-center';
import { ChannelPost } from '../src/types';

const NOW = new Date('2026-06-06T12:00:00.000Z');

const tmpDirs: string[] = [];
function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cbw-cc-'));
  tmpDirs.push(d);
  return d;
}
function assetTmp(files: string[]): string {
  const d = tmp();
  for (const f of files) fs.writeFileSync(path.join(d, f), 'x');
  return d;
}
afterEach(() => {
  while (tmpDirs.length) {
    const d = tmpDirs.pop()!;
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

/** A stub bot that records calls and returns incrementing message ids. */
function stubBot() {
  const calls: { kind: 'text' | 'photo'; chatId: string | number; payload: string; opts: unknown }[] = [];
  let id = 100;
  const bot: SenderBot = {
    sendMessage: async (chatId, text, opts) => { calls.push({ kind: 'text', chatId, payload: text, opts }); return { message_id: ++id }; },
    sendPhoto: async (chatId, photo, opts) => { calls.push({ kind: 'photo', chatId, payload: photo, opts }); return { message_id: ++id }; },
  };
  return { bot, calls };
}

describe('assets', () => {
  it('lists only images and validates filenames (rejects path traversal)', () => {
    const dir = assetTmp(['a.png', 'b.jpg', 'notes.txt', 'c.webp']);
    expect(listAssets(dir)).toEqual(['a.png', 'b.jpg', 'c.webp']);
    expect(assetExists('a.png', dir)).toBe(true);
    expect(assetExists('missing.png', dir)).toBe(false);
    expect(assetExists('../secret.png', dir)).toBe(false);
    expect(assetExists('sub/a.png', dir)).toBe(false);
    expect(() => assetPath('a.png', dir)).not.toThrow();
    expect(() => assetPath('../x.png', dir)).toThrow();
  });

  it('missing folder yields empty list, not an error', () => {
    expect(listAssets(path.join(os.tmpdir(), 'definitely-not-here-xyz'))).toEqual([]);
  });
});

describe('post creation + store', () => {
  it('creates posts with incrementing ids and persists/reloads', () => {
    const dir = tmp();
    const store = new ChannelPostStore('posts.json', dir);
    const p1 = store.create('Hello KZ', 'alice', NOW);
    const p2 = store.create('Second', 'alice', NOW);
    expect(p1.id).toBe('p1');
    expect(p2.id).toBe('p2');
    expect(store.drafts().length).toBe(2);
    expect(new ChannelPostStore('posts.json', dir).get('p1')!.caption).toBe('Hello KZ');
  });

  it('attach validates existence and only edits drafts; reject blocks publish', () => {
    const dir = tmp();
    const assets = assetTmp(['img.png']);
    const store = new ChannelPostStore('posts.json', dir);
    const p = store.create('caption', 'alice', NOW);
    expect('error' in store.attach(p.id, 'nope.png', assets)).toBe(true);
    const ok = store.attach(p.id, 'img.png', assets);
    expect('error' in ok).toBe(false);
    expect(store.get(p.id)!.assetFile).toBe('img.png');

    const r = store.reject(p.id, 'alice', 'off-brand', NOW);
    expect('error' in r).toBe(false);
    expect(store.get(p.id)!.status).toBe('rejected');
    expect('error' in store.attach(p.id, 'img.png', assets)).toBe(true); // not a draft anymore
  });
});

describe('validation', () => {
  function post(over: Partial<ChannelPost> = {}): ChannelPost {
    return { ...newPost('p1', over.caption ?? 'hi', 'a', NOW), ...over };
  }
  it('flags empty caption, over-limit caption, and missing asset', () => {
    expect(validatePost(post({ caption: '   ' }))).toContain('Caption is empty.');
    const long = 'x'.repeat(1100);
    expect(validatePost(post({ caption: long, assetFile: 'a.png' }), assetTmp(['a.png'])).some((p) => /over the 1024/.test(p))).toBe(true);
    expect(validatePost(post({ assetFile: 'gone.png' }), assetTmp([])).some((p) => /missing/.test(p))).toBe(true);
    expect(validatePost(post({ caption: 'ok' }))).toEqual([]); // text-only, fine
  });
});

describe('publishChannelPost (guarded, the only send path)', () => {
  function draft(over: Partial<ChannelPost> = {}): ChannelPost {
    return { ...newPost('p1', 'Привет, KZ', 'a', NOW), ...over };
  }

  it('dry-run sends nothing', async () => {
    const { bot, calls } = stubBot();
    const r = await publishChannelPost(bot, '@cbw_kz', draft(), { dryRun: true });
    expect(r.ok).toBe(true);
    expect(r.dryRun).toBe(true);
    expect(calls.length).toBe(0);
  });

  it('publishes a text post via sendMessage with plain caption', async () => {
    const { bot, calls } = stubBot();
    const r = await publishChannelPost(bot, '@cbw_kz', draft());
    expect(r.ok).toBe(true);
    expect(calls[0].kind).toBe('text');
    expect(calls[0].payload).toBe('Привет, KZ'); // exact, no markup
  });

  it('publishes a photo post via sendPhoto with the caption in options', async () => {
    const assets = assetTmp(['pic.png']);
    const { bot, calls } = stubBot();
    const r = await publishChannelPost(bot, '@cbw_kz', draft({ assetFile: 'pic.png' }), { assetDir: assets });
    expect(r.ok).toBe(true);
    expect(calls[0].kind).toBe('photo');
    expect((calls[0].opts as { caption: string }).caption).toBe('Привет, KZ');
  });

  it('refuses already-published, rejected, missing channel, and invalid posts', async () => {
    const { bot, calls } = stubBot();
    expect((await publishChannelPost(bot, '@cbw_kz', draft({ status: 'published', channelMessageId: 5 }))).ok).toBe(false);
    expect((await publishChannelPost(bot, '@cbw_kz', draft({ status: 'rejected' }))).ok).toBe(false);
    expect((await publishChannelPost(bot, '', draft())).ok).toBe(false);
    expect((await publishChannelPost(bot, '@cbw_kz', draft({ caption: '  ' }))).ok).toBe(false);
    expect(calls.length).toBe(0); // nothing ever sent
  });
});

describe('daily report', () => {
  it('aggregates totals, today counts and last published', () => {
    const dir = tmp();
    const store = new ChannelPostStore('posts.json', dir);
    const a = store.create('one', 'x', NOW);
    store.markPublished(a.id, 'x', 11, NOW);
    const b = store.create('two', 'x', NOW);
    store.reject(b.id, 'x', 'no', NOW);
    store.create('three', 'x', NOW); // stays draft

    const r = contentCenterReport(store.all(), NOW);
    expect(r.totals).toEqual({ draft: 1, published: 1, rejected: 1 });
    expect(r.today.published).toBe(1);
    expect(r.today.rejected).toBe(1);
    expect(r.pendingApproval).toBe(1);
    expect(r.lastPublished?.id).toBe(a.id);
    expect(r.lastPublished?.messageId).toBe(11);
  });
});
