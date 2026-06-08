import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  TOPICS,
  FIRST_PACK,
  generateContentDraft,
  generateContentPack,
  resolveImage,
  contentMachineReport,
  dailyPlan,
} from '../services/content-machine';
import { ImageProvider } from '../services/image-generator';
import {
  ChannelPostStore,
  publishChannelPost,
  validateContentSafety,
  validatePost,
  newPost,
  SenderBot,
} from '../services/content-center';

const NOW = new Date('2026-06-06T09:00:00.000Z');
// Each topic maps to its OWN deterministic image filename (EPIC 017).
const TOPIC_IMG: Record<string, string> = {
  usdt_basics: 'cbw_kzt_usdt_p2p_1280.png',
  p2p_basics: 'cbw_p2p_simple_1280.png',
  p2p_scams: 'cbw_p2p_scam_safety_1280.png',
  choose_seller: 'cbw_payment_methods_1280.png',
  best_exchanges_kz: 'cbw_exchange_reviews_1280.png',
};
const ALL_IMAGES = Object.values(TOPIC_IMG);

const tmpDirs: string[] = [];
function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cbw-cm-'));
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

function stubBot() {
  const calls: string[] = [];
  let id = 50;
  const bot: SenderBot = {
    sendMessage: async () => { calls.push('text'); return { message_id: ++id }; },
    sendPhoto: async () => { calls.push('photo'); return { message_id: ++id }; },
  };
  return { bot, calls };
}

describe('generated content is safe', () => {
  it('all first-pack drafts pass the safety validator', () => {
    expect(FIRST_PACK.length).toBe(5);
    for (const key of FIRST_PACK) {
      const d = generateContentDraft(key);
      expect(d.safetyViolations, `${key}: ${d.safetyViolations.join('; ')}`).toEqual([]);
      expect(d.title.length).toBeGreaterThan(0);
    }
  });

  it('safety validator blocks unsafe claims', () => {
    expect(validateContentSafety('Гарантированный доход без риска')).not.toEqual([]);
    expect(validateContentSafety('Заработок 20% в день')).not.toEqual([]);
    expect(validateContentSafety('Реальный скриншот подтверждает вывод')).not.toEqual([]);
    expect(validateContentSafety('Bybit доступен в Казахстане')).not.toEqual([]); // no caveat
    expect(validateContentSafety('Bybit доступен в Казахстане — проверяйте внутри биржи')).toEqual([]); // caveat present
  });
});

describe('image pipeline (prompt + fallback)', () => {
  it('falls back to a template image when generation is unavailable', async () => {
    const assets = assetTmp([TOPIC_IMG.p2p_basics]);
    const img = await resolveImage('p2p_basics', 'P2P', 'education', { assetDir: assets });
    expect(img.imageFile).toBe(TOPIC_IMG.p2p_basics);
    expect(img.usedFallback).toBe(true);
    expect(img.generated).toBe(false);
    expect(img.prompt).toMatch(/CBW KZ/);
  });

  it('returns no image when neither generation nor a fallback exists', async () => {
    const img = await resolveImage('p2p_basics', 'P2P', 'education', { assetDir: assetTmp([]) });
    expect(img.imageFile).toBeNull();
    expect(img.usedFallback).toBe(false);
  });

  it('uses a configured provider when it produces a file', async () => {
    const assets = assetTmp([]);
    const provider: ImageProvider = {
      name: 'test',
      isConfigured() { return true; },
      async generate(_prompt, outPath) { fs.writeFileSync(outPath, 'img'); return true; },
    };
    const img = await resolveImage('usdt_basics', 'USDT', 'education', { assetDir: assets, provider });
    expect(img.generated).toBe(true);
    expect(img.imageFile).toBe(TOPIC_IMG.usdt_basics); // deterministic filename
  });
});

describe('first content pack', () => {
  it('generates 5 ready drafts (with fallback image), idempotently, never published', async () => {
    const assets = assetTmp(ALL_IMAGES);
    const store = new ChannelPostStore('posts.json', tmp());
    const res = await generateContentPack(store, undefined, { assetDir: assets, now: NOW });
    expect(res.created.length).toBe(5);
    expect(res.missingImages.length).toBe(0);
    // every post type gets its OWN image (all distinct)
    expect(new Set(res.created.map((p) => p.assetFile)).size).toBe(5);
    for (const p of res.created) {
      expect(p.status).toBe('ready');         // safe + has image
      expect(p.assetFile).toBe(TOPIC_IMG[p.topic]);
      expect(p.requiresImage).toBe(true);
      expect(p.status).not.toBe('published');  // NEVER auto-published
      expect(p.channelMessageId).toBeNull();
    }
    // idempotent
    const again = await generateContentPack(store, undefined, { assetDir: assets, now: NOW });
    expect(again.created.length).toBe(0);
    expect(again.skipped.length).toBe(5);
  });

  it('with no image available, drafts stay draft and are flagged missing', async () => {
    const assets = assetTmp([]); // no fallback present
    const store = new ChannelPostStore('posts.json', tmp());
    const res = await generateContentPack(store, ['usdt_basics'], { assetDir: assets, now: NOW });
    expect(res.missingImages).toContain('usdt_basics');
    const post = store.byTopic('usdt_basics')!;
    expect(post.status).toBe('draft');
    expect(post.assetFile).toBeNull();
    // imagePath required for a photo post → validation blocks it
    expect(validatePost(post, assets).some((p) => /requires an image/i.test(p))).toBe(true);
  });
});

describe('publish guardrails', () => {
  it('a photo post without an image cannot publish', async () => {
    const { bot, calls } = stubBot();
    const post = { ...newPost('p1', 'caption', 'machine', NOW, { requiresImage: true }) };
    const r = await publishChannelPost(bot, '@cbw_kz', post, { assetDir: assetTmp([]) });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/requires an image/i);
    expect(calls.length).toBe(0);
  });

  it('a rejected draft cannot publish, and unsafe captions are blocked', async () => {
    const { bot } = stubBot();
    const assets = assetTmp([TOPIC_IMG.p2p_basics]);
    const store = new ChannelPostStore('posts.json', tmp());
    await generateContentPack(store, ['p2p_basics'], { assetDir: assets, now: NOW });
    const post = store.byTopic('p2p_basics')!;

    store.reject(post.id, 'editor', 'later');
    expect((await publishChannelPost(bot, '@cbw_kz', store.get(post.id)!, { assetDir: assets })).ok).toBe(false);

    const unsafe = { ...newPost('u1', 'Гарантируем доход 100% в день, без риска!', 'x', NOW) };
    const r = await publishChannelPost(bot, '@cbw_kz', unsafe, { assetDir: assets });
    expect(r.ok).toBe(false);
  });
});

describe('reporting', () => {
  it('reports pipeline counts, missing images and content gaps', async () => {
    const store = new ChannelPostStore('posts.json', tmp());
    // only 2 of 5 generated, no images → gaps + missing images
    await generateContentPack(store, ['usdt_basics', 'p2p_basics'], { assetDir: assetTmp([]), now: NOW });
    const r = contentMachineReport(store.all(), dailyPlan(NOW), NOW);
    expect(r.counts.draft).toBe(2);
    expect(r.missingImages.length).toBe(2);
    expect(r.gaps.length).toBeGreaterThan(0); // p2p_safety / checklist / exchange_update not generated
    expect(r.publishedToday).toBe(0);
  });
});
