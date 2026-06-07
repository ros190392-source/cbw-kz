import fs from 'fs';
import path from 'path';
import { config } from '../../config';
import { logger } from '../../src/logger';
import { ChannelPost, ChannelPostStatus, ContentPostType, ContentCenterReport, EvidenceLevel } from '../../src/types';

/**
 * Telegram content command center (EPIC 016).
 *
 * Lets an admin run the whole publishing flow from Telegram: draft a post,
 * attach an image from the asset folder, preview it, and publish to @cbw_kz —
 * but ONLY on an explicit /approve_publish. Nothing here auto-publishes; the
 * approval command is the human gate. Captions are sent as plain text (exactly
 * what the operator typed), so no markup can break a post.
 *
 * Pure helpers are exported for testing; the store wraps JSON persistence.
 */

/** Where post images live (relative to project root). */
export const ASSET_DIR = path.join(config.paths.root, 'assets', 'telegram', 'kartinki-dlya-postov');

/** Telegram limits. */
export const CAPTION_LIMIT_PHOTO = 1024;
export const CAPTION_LIMIT_TEXT = 4096;

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);
const isPlainFilename = (name: string) => !!name && !name.includes('/') && !name.includes('\\') && !name.includes('..');

// ── Assets ───────────────────────────────────────────────────────────────────

/** List image filenames in the asset folder (sorted). Missing dir → []. */
export function listAssets(dir: string = ASSET_DIR): string[] {
  try {
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir)
      .filter((f) => IMAGE_EXT.has(path.extname(f).toLowerCase()))
      .sort();
  } catch (err) {
    logger.error('content-center', `Failed to list assets: ${(err as Error).message}`);
    return [];
  }
}

/** Does a (plain, non-traversing) asset filename exist in the folder? */
export function assetExists(name: string, dir: string = ASSET_DIR): boolean {
  if (!isPlainFilename(name)) return false;
  return listAssets(dir).includes(name);
}

/** Absolute path for an asset filename (throws on unsafe/missing). */
export function assetPath(name: string, dir: string = ASSET_DIR): string {
  if (!assetExists(name, dir)) throw new Error(`Asset not found: ${name}`);
  return path.join(dir, name);
}

// ── Post creation / validation ───────────────────────────────────────────────

export interface NewPostFields {
  title?: string;
  topic?: string;
  postType?: ContentPostType;
  evidenceLevel?: EvidenceLevel | null;
  imagePrompt?: string | null;
  requiresImage?: boolean;
  assetFile?: string | null;
}

export function newPost(id: string, caption: string, createdBy: string, now: Date = new Date(), fields: NewPostFields = {}): ChannelPost {
  return {
    id,
    title: fields.title ?? '',
    caption: caption.trim(),
    assetFile: fields.assetFile ?? null,
    topic: fields.topic ?? 'manual',
    postType: fields.postType ?? 'news',
    evidenceLevel: fields.evidenceLevel ?? null,
    imagePrompt: fields.imagePrompt ?? null,
    requiresImage: fields.requiresImage ?? false,
    status: 'draft',
    createdBy: createdBy || 'admin',
    createdAt: now.toISOString(),
    approvedBy: null,
    decidedAt: null,
    publishedAt: null,
    channelMessageId: null,
    rejectionReason: null,
  };
}

/**
 * Safety / honesty validator (EPIC 016 §5). Returns violation strings (empty =
 * clean). Blocks financial guarantees, fake screenshots, fake exchange claims,
 * and "available in Kazakhstan" assertions made WITHOUT a verify-caveat.
 * Education is fine as long as caveats are present.
 */
export function validateContentSafety(text: string): string[] {
  const t = (text ?? '').toLowerCase();
  const v: string[] = [];

  if (/(гаранти|guarantee|guaranteed|без риска|risk[- ]?free|никаких рисков|no risk)/i.test(t)) {
    v.push('Financial guarantee / risk-free claim — not allowed.');
  }
  if (/\d+\s*%\s*(в день|в месяц|в неделю|per day|per month|daily|profit|доход|годовых|apy|apr)/i.test(t)) {
    v.push('Promised return / yield figure — not allowed.');
  }
  // NOTE: JS \w does NOT match Cyrillic — use literal stems, not \w quantifiers.
  if (/(реальн|живой|настоящ).{0,12}(скрин|screenshot)|screenshot.{0,12}(proof|доказательств)/i.test(t)) {
    v.push('Claims a real/live screenshot — fake screenshots are forbidden.');
  }
  // "available / works in Kazakhstan" without a verify caveat.
  const claimsKz = /(работает|доступ|available|works|supported)[^.]{0,40}(казахстане|kazakhstan|в\s*кз)/i.test(t);
  const hasCaveat = /(провер|уточн|может меняться|may change|verify|перед переводом|внутри биржи|не является финанс|not financial advice)/i.test(t);
  if (claimsKz && !hasCaveat) {
    v.push('Asserts availability in Kazakhstan without a verify-caveat — add "проверяйте внутри биржи" or evidence.');
  }
  return v;
}

/** Validate a post is sendable; returns problems (empty = ok). */
export function validatePost(post: ChannelPost, assetDir: string = ASSET_DIR): string[] {
  const problems: string[] = [];
  if (!post.caption.trim()) problems.push('Caption is empty.');
  const limit = post.assetFile ? CAPTION_LIMIT_PHOTO : CAPTION_LIMIT_TEXT;
  if (post.caption.length > limit) {
    problems.push(`Caption is ${post.caption.length} chars — over the ${limit} limit for a ${post.assetFile ? 'photo' : 'text'} post.`);
  }
  if (post.requiresImage && !post.assetFile) problems.push('This post type requires an image — attach one before publishing.');
  if (post.assetFile && !assetExists(post.assetFile, assetDir)) problems.push(`Attached asset "${post.assetFile}" is missing from the folder.`);
  problems.push(...validateContentSafety(`${post.title} ${post.caption}`));
  return problems;
}

// ── Publishing (the only send path; status-guarded) ──────────────────────────

/** Minimal Telegram sender interface (TelegramBot satisfies it structurally). */
export interface SenderBot {
  sendMessage(chatId: string | number, text: string, opts?: unknown): Promise<{ message_id: number }>;
  sendPhoto(chatId: string | number, photo: string, opts?: unknown): Promise<{ message_id: number }>;
}

export interface PublishResult {
  ok: boolean;
  dryRun: boolean;
  messageId: number | null;
  error?: string;
}

/**
 * Publish a post to the channel. Refuses anything already published/rejected and
 * refuses an invalid post. Caption is sent as PLAIN text (no parse_mode) so the
 * operator's text appears exactly as written. Dry-run sends nothing.
 *
 * This does NOT check approval intent — the bot calls it only from the explicit
 * /approve_publish handler. It DOES guard against double/invalid publishing.
 */
export async function publishChannelPost(
  bot: SenderBot,
  channelId: string,
  post: ChannelPost,
  opts: { dryRun?: boolean; assetDir?: string } = {},
): Promise<PublishResult> {
  const dryRun = !!opts.dryRun;
  if (!channelId) return { ok: false, dryRun, messageId: null, error: 'channelId is empty' };
  if (post.status === 'published') return { ok: false, dryRun, messageId: null, error: `Post ${post.id} already published (msg ${post.channelMessageId ?? '?'}).` };
  if (post.status === 'rejected') return { ok: false, dryRun, messageId: null, error: `Post ${post.id} is rejected — cannot publish.` };
  const problems = validatePost(post, opts.assetDir);
  if (problems.length) return { ok: false, dryRun, messageId: null, error: problems.join(' ') };

  if (dryRun) {
    logger.info('content-center', `[DRY RUN] would publish ${post.id} to ${channelId}${post.assetFile ? ` with image ${post.assetFile}` : ''}`);
    return { ok: true, dryRun: true, messageId: null };
  }
  try {
    let messageId: number;
    if (post.assetFile) {
      const file = assetPath(post.assetFile, opts.assetDir);
      const msg = await bot.sendPhoto(channelId, file, { caption: post.caption });
      messageId = msg.message_id;
    } else {
      const msg = await bot.sendMessage(channelId, post.caption, { disable_web_page_preview: false });
      messageId = msg.message_id;
    }
    logger.audit('content_center_publish', `Published post ${post.id} to ${channelId}`, { messageId });
    return { ok: true, dryRun: false, messageId };
  } catch (err) {
    const error = (err as Error).message;
    logger.error('content-center', `Failed to publish ${post.id}: ${error}`);
    return { ok: false, dryRun: false, messageId: null, error };
  }
}

// ── Daily report ─────────────────────────────────────────────────────────────

const isSameUtcDay = (iso: string | null, now: Date) =>
  !!iso && new Date(iso).toISOString().slice(0, 10) === now.toISOString().slice(0, 10);

export function contentCenterReport(posts: ChannelPost[], now: Date = new Date()): ContentCenterReport {
  const totals = { draft: 0, published: 0, rejected: 0 };
  const today = { created: 0, published: 0, rejected: 0 };
  let lastPublished: ContentCenterReport['lastPublished'] = null;

  for (const p of posts) {
    // draft/ready/approved are all "pending" for this simpler report.
    if (p.status === 'published') totals.published++;
    else if (p.status === 'rejected') totals.rejected++;
    else totals.draft++;
    if (isSameUtcDay(p.createdAt, now)) today.created++;
    if (p.status === 'published' && isSameUtcDay(p.publishedAt, now)) today.published++;
    if (p.status === 'rejected' && isSameUtcDay(p.decidedAt, now)) today.rejected++;
    if (p.status === 'published' && p.publishedAt) {
      if (!lastPublished || p.publishedAt > lastPublished.at) {
        lastPublished = { id: p.id, at: p.publishedAt, messageId: p.channelMessageId };
      }
    }
  }
  return { generatedAt: now.toISOString(), totals, today, pendingApproval: totals.draft, lastPublished };
}

// ── Persistence ──────────────────────────────────────────────────────────────

export class ChannelPostStore {
  private file: string;
  private dir: string;
  private byId: Record<string, ChannelPost> = {};

  constructor(fileName = 'channel-posts.json', dir = config.paths.data) {
    this.dir = dir;
    this.file = path.join(dir, fileName);
    this.load();
  }

  private load(): void {
    try {
      if (fs.existsSync(this.file)) this.byId = JSON.parse(fs.readFileSync(this.file, 'utf-8')) as Record<string, ChannelPost>;
    } catch (err) {
      logger.error('content-center', `Failed to load posts, starting fresh: ${(err as Error).message}`);
      this.byId = {};
    }
  }

  private persist(): void {
    try {
      if (!fs.existsSync(this.dir)) fs.mkdirSync(this.dir, { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.byId, null, 2));
    } catch (err) {
      logger.error('content-center', `Failed to persist posts: ${(err as Error).message}`);
    }
  }

  /** Next human-typable id: p1, p2, … */
  nextId(): string {
    const nums = Object.keys(this.byId)
      .map((id) => Number(/^p(\d+)$/.exec(id)?.[1] ?? 0))
      .filter((n) => Number.isFinite(n));
    return `p${(nums.length ? Math.max(...nums) : 0) + 1}`;
  }

  get(id: string): ChannelPost | undefined {
    return this.byId[id];
  }

  all(): ChannelPost[] {
    return Object.values(this.byId);
  }

  drafts(): ChannelPost[] {
    return this.all().filter((p) => p.status === 'draft');
  }

  create(caption: string, createdBy: string, now: Date = new Date()): ChannelPost {
    const post = newPost(this.nextId(), caption, createdBy, now);
    this.byId[post.id] = post;
    this.persist();
    return post;
  }

  /** Create a fully-specified post (used by the autonomous generator). */
  createFull(caption: string, createdBy: string, fields: NewPostFields, now: Date = new Date()): ChannelPost {
    const post = newPost(this.nextId(), caption, createdBy, now, fields);
    this.byId[post.id] = post;
    this.persist();
    return post;
  }

  /** Save an arbitrary patch to a post (generator/image pipeline use). */
  update(id: string, patch: Partial<ChannelPost>): ChannelPost | undefined {
    const post = this.byId[id];
    if (!post) return undefined;
    this.byId[id] = { ...post, ...patch };
    this.persist();
    return this.byId[id];
  }

  /** Promote a draft to `ready` only if it passes validation. */
  markReady(id: string, assetDir: string = ASSET_DIR): ChannelPost | { error: string } {
    const post = this.byId[id];
    if (!post) return { error: `Post not found: ${id}` };
    if (post.status !== 'draft') return { error: `Post ${id} is ${post.status} — only drafts become ready.` };
    const problems = validatePost(post, assetDir);
    if (problems.length) return { error: problems.join(' ') };
    post.status = 'ready';
    this.persist();
    return post;
  }

  byTopic(topicKey: string): ChannelPost | undefined {
    return this.all().find((p) => p.topic === topicKey && p.status !== 'rejected');
  }

  /** Attach (or clear) an image by filename. Validates existence. */
  attach(id: string, assetFile: string | null, assetDir: string = ASSET_DIR): ChannelPost | { error: string } {
    const post = this.byId[id];
    if (!post) return { error: `Post not found: ${id}` };
    if (post.status !== 'draft') return { error: `Post ${id} is ${post.status} — cannot edit.` };
    if (assetFile && !assetExists(assetFile, assetDir)) return { error: `Asset not found: ${assetFile}` };
    post.assetFile = assetFile;
    this.persist();
    return post;
  }

  reject(id: string, by: string, reason: string, now: Date = new Date()): ChannelPost | { error: string } {
    const post = this.byId[id];
    if (!post) return { error: `Post not found: ${id}` };
    if (post.status === 'published') return { error: `Post ${id} already published — cannot reject.` };
    post.status = 'rejected';
    post.approvedBy = by;
    post.decidedAt = now.toISOString();
    post.rejectionReason = reason || '';
    this.persist();
    logger.audit('content_center_reject', `Post ${id} rejected by ${by}`, { reason });
    return post;
  }

  /** Mark a post published after a successful send (called by the bot). */
  markPublished(id: string, by: string, messageId: number, now: Date = new Date()): ChannelPost | undefined {
    const post = this.byId[id];
    if (!post) return undefined;
    post.status = 'published';
    post.approvedBy = by;
    post.decidedAt = now.toISOString();
    post.publishedAt = now.toISOString();
    post.channelMessageId = messageId;
    this.persist();
    return post;
  }
}

export function statusIcon(s: ChannelPostStatus): string {
  return s === 'published' ? '✅' : s === 'rejected' ? '❌' : s === 'ready' ? '🟢' : s === 'approved' ? '👍' : '📝';
}
