/**
 * Telegram channel publisher (manual, human-gated) — CBW KZ → @cbw_kz.
 *
 * This is a MANUAL tool. It does NOT poll, schedule, or auto-publish anything.
 * A human runs it on purpose, and when publishing a stored draft it REFUSES
 * unless that draft's status is exactly `approved`. There is no code path here
 * that publishes a draft automatically.
 *
 * Usage (always via npm so tsx + .env load correctly):
 *
 *   # Publish an APPROVED draft from the store (text post)
 *   npm run publish -- --id <draftId>
 *
 *   # Publish an APPROVED draft as an image + caption
 *   npm run publish -- --id <draftId> --photo <url-or-path>
 *
 *   # Ad-hoc one-off posts (manual; for testing the connection)
 *   npm run publish -- --text "Hello channel"
 *   npm run publish -- --photo <url-or-path> --caption "A caption"
 *
 *   # Dry run — build and print the payload, send NOTHING
 *   npm run publish -- --id <draftId> --dry-run
 *
 * Required env: TELEGRAM_BOT_TOKEN, TELEGRAM_CHANNEL_ID (e.g. @cbw_kz).
 * The bot must be an admin of the channel.
 */
import TelegramBot from 'node-telegram-bot-api';
import { config } from '../config';
import { logger } from '../src/logger';
import { DraftStore } from '../src/draft-store';
import { DraftRecord } from '../src/types';

const esc = (s: string) => (s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export interface PublishOptions {
  /** When true, build the payload and log it but send nothing. */
  dryRun?: boolean;
  /** Override the destination channel (defaults to TELEGRAM_CHANNEL_ID). */
  channelId?: string;
  disableLinkPreview?: boolean;
}

export interface PublishResult {
  ok: boolean;
  dryRun: boolean;
  channelId: string;
  messageId: number | null;
  error?: string;
}

/** Send a plain text post to the channel. Returns the channel message id. */
export async function sendTelegramPost(
  bot: TelegramBot,
  channelId: string,
  text: string,
  opts: PublishOptions = {},
): Promise<PublishResult> {
  if (!channelId) return { ok: false, dryRun: !!opts.dryRun, channelId, messageId: null, error: 'channelId is empty' };
  if (!text || !text.trim()) return { ok: false, dryRun: !!opts.dryRun, channelId, messageId: null, error: 'text is empty' };

  if (opts.dryRun) {
    logger.info('publish', `[DRY RUN] text → ${channelId}:\n${text}`);
    return { ok: true, dryRun: true, channelId, messageId: null };
  }
  try {
    const msg = await bot.sendMessage(channelId, text, {
      parse_mode: 'HTML',
      disable_web_page_preview: opts.disableLinkPreview ?? false,
    });
    logger.audit('publish', `Published text post to ${channelId}`, { messageId: msg.message_id });
    return { ok: true, dryRun: false, channelId, messageId: msg.message_id };
  } catch (err) {
    const error = (err as Error).message;
    logger.error('publish', `Failed to publish text post: ${error}`);
    return { ok: false, dryRun: false, channelId, messageId: null, error };
  }
}

/** Send an image + caption post to the channel. Returns the channel message id. */
export async function sendTelegramPhotoPost(
  bot: TelegramBot,
  channelId: string,
  photo: string,
  caption: string,
  opts: PublishOptions = {},
): Promise<PublishResult> {
  if (!channelId) return { ok: false, dryRun: !!opts.dryRun, channelId, messageId: null, error: 'channelId is empty' };
  if (!photo) return { ok: false, dryRun: !!opts.dryRun, channelId, messageId: null, error: 'photo (url or path) is empty' };

  if (opts.dryRun) {
    logger.info('publish', `[DRY RUN] photo → ${channelId}: ${photo}\ncaption:\n${caption}`);
    return { ok: true, dryRun: true, channelId, messageId: null };
  }
  try {
    const msg = await bot.sendPhoto(channelId, photo, { caption, parse_mode: 'HTML' });
    logger.audit('publish', `Published photo post to ${channelId}`, { messageId: msg.message_id });
    return { ok: true, dryRun: false, channelId, messageId: msg.message_id };
  } catch (err) {
    const error = (err as Error).message;
    logger.error('publish', `Failed to publish photo post: ${error}`);
    return { ok: false, dryRun: false, channelId, messageId: null, error };
  }
}

/** Render an approved draft into a clean channel post (no scoring header). */
function renderDraft(rec: DraftRecord): string {
  const tag = rec.category ? `#${rec.category.replace(/\s+/g, '')}` : '';
  const lines = [esc(rec.text), '', `🔗 <a href="${esc(rec.link)}">${esc(rec.source)}</a>`];
  if (tag) lines.push(tag);
  return lines.join('\n');
}

/**
 * APPROVAL GUARD. Publish a stored draft ONLY if its status is `approved`.
 * Refuses pending/rejected drafts and refuses to re-publish.
 * On success, marks the draft `published` with the channel message id.
 */
export async function publishApprovedDraft(
  bot: TelegramBot,
  store: DraftStore,
  draftId: string,
  opts: PublishOptions & { photo?: string } = {},
): Promise<PublishResult> {
  const channelId = opts.channelId ?? config.telegram.channelId;
  const rec = store.get(draftId);
  if (!rec) {
    return { ok: false, dryRun: !!opts.dryRun, channelId, messageId: null, error: `Draft not found: ${draftId}` };
  }
  if (rec.status === 'published') {
    return { ok: false, dryRun: !!opts.dryRun, channelId, messageId: null, error: `Draft already published (msg ${rec.channelMessageId ?? '?'}) — refusing duplicate` };
  }
  if (rec.status !== 'approved') {
    // The core guard: nothing but an approved draft may be published.
    return { ok: false, dryRun: !!opts.dryRun, channelId, messageId: null, error: `Draft status is "${rec.status}" — only "approved" drafts can be published. Approve it in the moderation chat first.` };
  }

  const body = renderDraft(rec);
  const result = opts.photo
    ? await sendTelegramPhotoPost(bot, channelId, opts.photo, body, opts)
    : await sendTelegramPost(bot, channelId, body, { ...opts, disableLinkPreview: false });

  if (result.ok && !result.dryRun && result.messageId != null) {
    store.update(draftId, { status: 'published', publishedAt: new Date().toISOString(), channelMessageId: result.messageId });
    logger.audit('publish', `Draft ${draftId} marked published`, { messageId: result.messageId });
  }
  return result;
}

// ── CLI ──────────────────────────────────────────────────────────────────────

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined;
}
const has = (name: string) => process.argv.includes(`--${name}`);

function fail(msg: string): never {
  console.error(`❌ ${msg}`);
  process.exit(1);
}

async function main(): Promise<void> {
  const dryRun = has('dry-run');
  const channelId = arg('channel') ?? config.telegram.channelId;

  if (!config.telegram.botToken) fail('TELEGRAM_BOT_TOKEN is not set. Fill it in .env');
  if (!channelId) fail('TELEGRAM_CHANNEL_ID is not set (e.g. @cbw_kz). Fill it in .env or pass --channel');

  const bot = new TelegramBot(config.telegram.botToken, { polling: false });
  const id = arg('id');
  const text = arg('text');
  const photo = arg('photo');
  const caption = arg('caption');

  let result: PublishResult;

  if (id) {
    // Guarded path: publish an APPROVED stored draft.
    result = await publishApprovedDraft(bot, new DraftStore(), id, { dryRun, channelId, photo });
  } else if (photo && !text) {
    // Ad-hoc image post (manual one-off).
    result = await sendTelegramPhotoPost(bot, channelId, photo, caption ?? '', { dryRun, channelId });
  } else if (text) {
    // Ad-hoc text post (manual one-off).
    result = await sendTelegramPost(bot, channelId, text, { dryRun, channelId });
  } else {
    fail('Nothing to publish. Pass --id <draftId>, or --text "...", or --photo <url> [--caption "..."]. Add --dry-run to simulate.');
  }

  if (!result.ok) fail(result.error ?? 'Publish failed');

  if (result.dryRun) {
    console.log(`✅ [DRY RUN] Would publish to ${result.channelId}. Nothing was sent.`);
  } else {
    console.log(`✅ Published to ${result.channelId} — message id ${result.messageId}`);
  }
}

// Only run the CLI when invoked directly (keeps the functions importable/testable).
if (require.main === module) {
  main().catch((err) => fail((err as Error).message));
}
