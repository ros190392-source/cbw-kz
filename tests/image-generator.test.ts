import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  generatePremiumTelegramImage,
  validateImagePrompt,
  getProvider,
  NullProvider,
  premiumFilenames,
  buildSubjectPrompt,
  promptForTopic,
  PREMIUM_PROMPTS,
  TOPIC_TO_PROMPT,
  FIRST_PREMIUM_PACK,
  ImageProvider,
} from '../services/image-generator';

const tmpDirs: string[] = [];
function assetTmp(files: string[]): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cbw-img-'));
  tmpDirs.push(d);
  for (const f of files) fs.writeFileSync(path.join(d, f), 'x');
  return d;
}
afterEach(() => {
  while (tmpDirs.length) {
    const d = tmpDirs.pop()!;
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

const writingProvider: ImageProvider = {
  name: 'test',
  isConfigured() { return true; },
  async generate(_p, outPath) { fs.writeFileSync(outPath, 'png'); return true; },
};

describe('prompt registry', () => {
  it('covers the first pack and every topic maps to a UNIQUE filename', () => {
    expect(FIRST_PREMIUM_PACK.length).toBe(5);
    const files = premiumFilenames();
    expect(new Set(files).size).toBe(files.length); // all unique
    const topicFiles = Object.keys(TOPIC_TO_PROMPT).map((t) => promptForTopic(t)!.filename);
    expect(new Set(topicFiles).size).toBe(5); // 5 distinct images for 5 topics
  });

  it('builds a brand-safe subject prompt with KZ/₸ context', () => {
    const p = buildSubjectPrompt('p2p_basics', '');
    expect(p).toMatch(/CBW KZ/);
    expect(p).toMatch(/1280x720/);
  });
});

describe('image-prompt safety', () => {
  it('blocks fake UI / screenshots / balances / guarantees', () => {
    expect(validateImagePrompt('a real exchange app screenshot')).not.toEqual([]);
    expect(validateImagePrompt('fake Kaspi screen with account balance')).not.toEqual([]);
    expect(validateImagePrompt('guaranteed profit chart')).not.toEqual([]);
    expect(validateImagePrompt('casino slot machine theme')).not.toEqual([]);
    // a real premium subject is clean
    expect(validateImagePrompt(PREMIUM_PROMPTS.usdt_intro.subject)).toEqual([]);
  });

  it('generatePremiumTelegramImage returns violations for an unsafe caption-built prompt', async () => {
    // unknown topic → prompt built from the caption; unsafe caption is blocked
    const r = await generatePremiumTelegramImage('unknown_topic', 'fake exchange UI screenshot with balance', 'premium_dark', {
      provider: writingProvider, assetDir: assetTmp([]),
    });
    expect(r.safetyViolations.length).toBeGreaterThan(0);
    expect(r.imagePath).toBeNull();
  });
});

describe('generation + fallback', () => {
  it('stores the generated image path when a provider produces a file', async () => {
    const dir = assetTmp([]);
    const r = await generatePremiumTelegramImage('p2p_basics', 'Что такое P2P', 'premium_dark', { provider: writingProvider, assetDir: dir });
    expect(r.generated).toBe(true);
    expect(r.provider).toBe('test');
    expect(r.filename).toBe('cbw_p2p_simple_1280.png');
    expect(r.imagePath).toBe(path.join(dir, 'cbw_p2p_simple_1280.png'));
    expect(fs.existsSync(r.imagePath!)).toBe(true);
  });

  it('falls back to the existing image when no provider is configured', async () => {
    const dir = assetTmp(['cbw_p2p_simple_1280.png']);
    const r = await generatePremiumTelegramImage('p2p_basics', 'P2P', 'premium_dark', { provider: NullProvider, assetDir: dir });
    expect(r.generated).toBe(false);
    expect(r.usedFallback).toBe(true);
    expect(r.filename).toBe('cbw_p2p_simple_1280.png');
    expect(r.imagePath).toBe(path.join(dir, 'cbw_p2p_simple_1280.png'));
  });

  it('returns no image when neither a provider nor a fallback exists', async () => {
    const r = await generatePremiumTelegramImage('p2p_basics', 'P2P', 'premium_dark', { provider: NullProvider, assetDir: assetTmp([]) });
    expect(r.imagePath).toBeNull();
    expect(r.usedFallback).toBe(false);
  });
});

describe('provider selection', () => {
  it('defaults to the null provider (fallback) when IMAGE_PROVIDER is unset', () => {
    const prev = process.env.IMAGE_PROVIDER;
    delete process.env.IMAGE_PROVIDER;
    expect(getProvider().isConfigured()).toBe(false);
    if (prev !== undefined) process.env.IMAGE_PROVIDER = prev;
  });
});
