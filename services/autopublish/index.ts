import fs from 'fs';
import path from 'path';
import { ChannelPost, ChannelPostStatus } from '../../src/types';
import { ChannelPostStore, publishChannelPost, SenderBot } from '../content-center';
import { logger } from '../../src/logger';
import {
  selectNext,
  generateNextPost,
  getPublishTimeUtc,
  KZ_OFFSET_H,
  canAutoPublish as canAutoPublishEntry,
  RoadmapEntry,
  roadmapEntry,
} from '../roadmap-scheduler';
import { ImageProvider, getProvider } from '../image-generator';
import { resolveImage, generateContentDraft, TOPICS } from '../content-machine';

/**
 * EPIC 020 — Autonomous daily publishing for @cbw_kz.
 *
 * Adds a toggle-controlled autopublish loop that runs on a 60s tick:
 *   1. Check if autopublish is enabled (toggle gate).
 *   2. Check the KZ-local publish window (±5 min of the target time).
 *   3. Check idempotency (already published today in KZ time?).
 *   4. Find the next ready/approved post, or auto-generate one.
 *   5. Validate safety, then publish via publishChannelPost().
 *
 * The human gate (/approve_publish) still works for manual flow.
 * The toggle (/autopublish_on, /autopublish_off) controls this loop.
 */

// ── Constants ──────────────────────────────────────────────────────────────

const KZ_OFFSET_MS = KZ_OFFSET_H * 60 * 60 * 1000;

/** Publish window: ±5 minutes around the target time. */
export const PUBLISH_WINDOW_MIN = 5;

/** Max image generation retries. */
export const MAX_IMAGE_RETRIES = 3;

/** Max consecutive failures before auto-disabling. */
export const MAX_CONSECUTIVE_FAILURES = 5;

// ── State persistence ──────────────────────────────────────────────────────

export interface AutopublishState {
  enabled: boolean;
  enabledBy: string | null;
  enabledAt: string | null;
  lastTickAt: string | null;
  lastPublishAt: string | null;
  lastError: string | null;
  consecutiveFailures: number;
  /** Idempotency key of the last published news slot, e.g. "2026-06-11#1". */
  lastNewsSlot: string | null;
}

const DEFAULTS: AutopublishState = {
  enabled: false,
  enabledBy: null,
  enabledAt: null,
  lastTickAt: null,
  lastPublishAt: null,
  lastError: null,
  consecutiveFailures: 0,
  lastNewsSlot: null,
};

export class AutopublishStore {
  private state: AutopublishState;
  private filePath: string;

  constructor(filename = 'autopublish-state.json', dataDir?: string) {
    const dir = dataDir ?? path.join(process.cwd(), 'data');
    this.filePath = path.join(dir, filename);
    if (fs.existsSync(this.filePath)) {
      try {
        this.state = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(this.filePath, 'utf-8')) };
      } catch {
        this.state = { ...DEFAULTS };
      }
    } else {
      this.state = { ...DEFAULTS };
    }
  }

  get(): AutopublishState {
    return { ...this.state };
  }

  enable(by: string, now: Date = new Date()): AutopublishState {
    this.state.enabled = true;
    this.state.enabledBy = by;
    this.state.enabledAt = now.toISOString();
    this.state.consecutiveFailures = 0;
    this.state.lastError = null;
    this.persist();
    logger.audit('autopublish', `Enabled by ${by}`);
    return this.get();
  }

  disable(by: string, now: Date = new Date()): AutopublishState {
    this.state.enabled = false;
    this.state.enabledBy = by;
    this.state.enabledAt = now.toISOString();
    this.persist();
    logger.audit('autopublish', `Disabled by ${by}`);
    return this.get();
  }

  updateTick(patch: Partial<AutopublishState>): void {
    Object.assign(this.state, patch);
    this.persist();
  }

  private persist(): void {
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(this.filePath, JSON.stringify(this.state, null, 2), 'utf-8');
  }
}

// ── Tick context (dependency injection for testability) ────────────────────

export interface TickContext {
  store: ChannelPostStore;
  autopublish: AutopublishStore;
  bot: SenderBot;
  channelId: string;
  now?: Date;
  provider?: ImageProvider;
  assetDir?: string;
  /** Optional callback to notify admin chat on events. */
  notify?: (text: string) => Promise<void>;
}

export type TickAction =
  | 'disabled'
  | 'not_time_yet'
  | 'already_published_today'
  | 'no_eligible_post'
  | 'generated_and_published'
  | 'published'
  | 'publish_failed'
  | 'safety_blocked'
  | 'image_failed'
  | 'auto_disabled_failures';

export interface TickResult {
  action: TickAction;
  postId?: string;
  error?: string;
  detail?: string;
}

// ── KZ date helpers ────────────────────────────────────────────────────────

/** Get the KZ local date string (YYYY-MM-DD) for a UTC timestamp. */
export function kzDateStr(utc: Date): string {
  const kz = new Date(utc.getTime() + KZ_OFFSET_MS);
  return kz.toISOString().slice(0, 10);
}

/** Check if a post was published on a specific KZ date. */
function publishedOnKzDate(post: ChannelPost, kzDate: string): boolean {
  if (!post.publishedAt) return false;
  return kzDateStr(new Date(post.publishedAt)) === kzDate;
}

/** Check if the current time is within the publish window. */
export function isInPublishWindow(now: Date, windowMin: number = PUBLISH_WINDOW_MIN): boolean {
  const target = getPublishTimeUtc(now);
  const diffMs = Math.abs(now.getTime() - target.getTime());
  return diffMs <= windowMin * 60 * 1000;
}

// ── Image retry ────────────────────────────────────────────────────────────

export async function generateImageWithRetry(
  topicKey: string,
  title: string,
  postType: string,
  opts: { provider?: ImageProvider; assetDir?: string; maxRetries?: number },
): Promise<{ imageFile: string | null; prompt: string; generated: boolean }> {
  const maxRetries = opts.maxRetries ?? MAX_IMAGE_RETRIES;
  let lastErr: Error | null = null;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const r = await resolveImage(topicKey, title, postType as any, {
        provider: opts.provider,
        assetDir: opts.assetDir,
      });
      if (r.imageFile) return { imageFile: r.imageFile, prompt: r.prompt, generated: r.generated };
      // No image but no error — provider not configured or no prompt
      return { imageFile: null, prompt: r.prompt, generated: false };
    } catch (err) {
      lastErr = err as Error;
      logger.warn('autopublish', `Image attempt ${attempt}/${maxRetries} failed: ${lastErr.message}`);
      if (attempt < maxRetries) {
        // Exponential backoff: 2s, 4s, 8s
        await new Promise(resolve => setTimeout(resolve, Math.pow(2, attempt) * 1000));
      }
    }
  }
  logger.error('autopublish', `Image generation failed after ${maxRetries} attempts: ${lastErr?.message}`);
  return { imageFile: null, prompt: '', generated: false };
}

// ── Main tick ──────────────────────────────────────────────────────────────

/**
 * The core autopublish tick. Called every 60s by the bot's setInterval.
 * Idempotent: safe to call multiple times — publishes at most once per KZ day.
 */
export async function autopublishTick(ctx: TickContext): Promise<TickResult> {
  const now = ctx.now ?? new Date();
  const state = ctx.autopublish.get();

  // Update last tick timestamp
  ctx.autopublish.updateTick({ lastTickAt: now.toISOString() });

  // 1. Toggle gate
  if (!state.enabled) {
    return { action: 'disabled' };
  }

  // 2. Auto-disable on too many consecutive failures
  if (state.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
    ctx.autopublish.disable('system_auto_disable', now);
    const msg = `⚠️ Autopublish auto-disabled after ${MAX_CONSECUTIVE_FAILURES} consecutive failures. Last error: ${state.lastError}`;
    logger.error('autopublish', msg);
    void ctx.notify?.(msg);
    return { action: 'auto_disabled_failures', error: state.lastError ?? undefined };
  }

  // 3. Check publish window
  if (!isInPublishWindow(now)) {
    return { action: 'not_time_yet' };
  }

  // 4. Idempotency: already published today (KZ time)?
  const todayKz = kzDateStr(now);
  const alreadyPublished = ctx.store.all().some(
    p => p.status === 'published' && publishedOnKzDate(p, todayKz),
  );
  if (alreadyPublished) {
    return { action: 'already_published_today' };
  }

  // 5. Find eligible post: ready or approved, sorted by scheduledAt
  let post = findEligiblePost(ctx.store);

  // 6. No eligible post → try auto-generating
  if (!post) {
    logger.info('autopublish', 'No eligible post found — auto-generating from roadmap');
    try {
      const generated = await generateNextPost(ctx.store, {
        provider: ctx.provider ?? getProvider(),
        assetDir: ctx.assetDir,
        createdBy: 'autopublish',
        forDate: now,
      });
      if (!generated) {
        return { action: 'no_eligible_post', detail: 'Roadmap exhausted — no more topics' };
      }

      // If it came out as planned/draft with template, generate image with retry
      if (generated.status !== 'ready' && generated.caption && TOPICS[generated.topic]) {
        const img = await generateImageWithRetry(
          generated.topic,
          generated.title,
          generated.postType,
          { provider: ctx.provider ?? getProvider(), assetDir: ctx.assetDir },
        );
        if (img.imageFile) {
          ctx.store.update(generated.id, { imagePrompt: img.prompt, assetFile: img.imageFile });
          ctx.store.markReady(generated.id, ctx.assetDir);
        } else if (generated.requiresImage) {
          ctx.autopublish.updateTick({
            lastError: 'Image generation failed',
            consecutiveFailures: state.consecutiveFailures + 1,
          });
          void ctx.notify?.(`⚠️ Autopublish: image failed for ${generated.topic} — skipping today`);
          return { action: 'image_failed', postId: generated.id, error: 'Image generation failed after retries' };
        }
      }
      post = ctx.store.get(generated.id);
    } catch (err) {
      const error = (err as Error).message;
      ctx.autopublish.updateTick({
        lastError: error,
        consecutiveFailures: state.consecutiveFailures + 1,
      });
      return { action: 'publish_failed', error: `Generation failed: ${error}` };
    }
  }

  if (!post || (post.status !== 'ready' && post.status !== 'approved')) {
    return { action: 'no_eligible_post', detail: 'Post not in publishable state' };
  }

  // 7. Safety check on the roadmap entry (high-risk gate)
  const entry = roadmapEntry(post.topic);
  if (entry && !canAutoPublishEntry(entry, true)) {
    logger.warn('autopublish', `Topic ${post.topic} blocked by canAutoPublish (high-risk / low evidence)`);
    return { action: 'safety_blocked', postId: post.id, detail: `High-risk topic: ${post.topic}` };
  }

  // 8. Publish
  try {
    const res = await publishChannelPost(ctx.bot, ctx.channelId, post);
    if (!res.ok) {
      ctx.autopublish.updateTick({
        lastError: res.error ?? 'Unknown publish error',
        consecutiveFailures: state.consecutiveFailures + 1,
      });
      return { action: 'publish_failed', postId: post.id, error: res.error ?? undefined };
    }

    ctx.store.markPublished(post.id, 'autopublish', res.messageId!, now);
    ctx.autopublish.updateTick({
      lastPublishAt: now.toISOString(),
      lastError: null,
      consecutiveFailures: 0,
    });

    const msg = `✅ Autopublished <code>${post.id}</code> — "${post.title}" (msg ${res.messageId})`;
    logger.audit('autopublish', `Published ${post.id} → msg ${res.messageId}`);
    void ctx.notify?.(msg);

    return { action: 'published', postId: post.id };
  } catch (err) {
    const error = (err as Error).message;
    ctx.autopublish.updateTick({
      lastError: error,
      consecutiveFailures: state.consecutiveFailures + 1,
    });
    void ctx.notify?.(`⚠️ Autopublish error: ${error}`);
    return { action: 'publish_failed', postId: post.id, error };
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────

/** Find the best eligible post to publish: ready/approved, prefer earliest scheduledAt. */
function findEligiblePost(store: ChannelPostStore): ChannelPost | undefined {
  return store.all()
    .filter(p => p.status === 'ready' || p.status === 'approved')
    .sort((a, b) => (a.scheduledAt ?? a.createdAt).localeCompare(b.scheduledAt ?? b.createdAt))
    [0];
}
