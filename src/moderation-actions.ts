import { DraftStore } from './draft-store';
import { DraftRecord, DraftStatus } from './types';
import { logger } from './logger';

export interface ActionResult {
  ok: boolean;
  status: DraftStatus | null;
  /** Short message suitable for a Telegram callback answer. */
  message: string;
  channelMessageId?: number;
}

/** Publishes a draft and returns the channel message id. Injected so the same
 * logic can be unit/simulation-tested without touching Telegram. */
export type Publisher = (record: DraftRecord) => Promise<number>;

const now = () => new Date().toISOString();

/**
 * Approve → publish. Enforces the publish-safety rules:
 *  - draft must exist,
 *  - already-published drafts are NEVER re-published (duplicate prevention),
 *  - already-rejected drafts cannot be published,
 *  - on publish failure the draft reverts to `pending` so it can be retried.
 *
 * This function performs NO automatic publishing — it only runs in response to
 * an explicit manual Approve action passed in by the bot.
 */
export async function approveDraft(
  store: DraftStore,
  id: string,
  publish: Publisher,
): Promise<ActionResult> {
  const rec = store.get(id);
  if (!rec) {
    logger.audit('approval', `Approve ignored — draft not found`, { id });
    return { ok: false, status: null, message: 'Draft not found.' };
  }
  if (rec.status === 'published') {
    logger.audit('duplicate_prevented', `Approve ignored — already published`, {
      id, title: rec.title, channelMessageId: rec.channelMessageId,
    });
    return { ok: false, status: 'published', message: 'Already published — ignored.' };
  }
  if (rec.status === 'rejected') {
    logger.audit('duplicate_prevented', `Approve ignored — already rejected`, { id, title: rec.title });
    return { ok: false, status: 'rejected', message: 'Already rejected — cannot publish.' };
  }

  // Record the approval intent before publishing.
  store.update(id, { status: 'approved', decidedAt: now() });
  logger.audit('approval', `Draft approved`, {
    id, title: rec.title, score: rec.scoreTotal, category: rec.category, priority: rec.priority,
  });

  try {
    const channelMessageId = await publish(rec);
    store.update(id, { status: 'published', publishedAt: now(), channelMessageId });
    logger.audit('publish_success', `Published to channel`, {
      id, title: rec.title, score: rec.scoreTotal, category: rec.category,
      channelMessageId, publishedAt: now(),
    });
    return { ok: true, status: 'published', message: 'Published ✅', channelMessageId };
  } catch (err) {
    // Revert so the owner can retry; nothing was published.
    store.update(id, { status: 'pending', decidedAt: null });
    logger.audit('publish_failure', `Publish failed — reverted to pending`, {
      id, title: rec.title, error: (err as Error).message,
    });
    return { ok: false, status: 'pending', message: `Publish failed: ${(err as Error).message}` };
  }
}

/**
 * Reject → mark rejected with reason "manual_rejection". Already-published
 * drafts cannot be rejected; repeated rejects are ignored. Rejected drafts are
 * never resent (the pipeline de-dupes by id).
 */
export function rejectDraft(store: DraftStore, id: string): ActionResult {
  const rec = store.get(id);
  if (!rec) {
    logger.audit('rejection', `Reject ignored — draft not found`, { id });
    return { ok: false, status: null, message: 'Draft not found.' };
  }
  if (rec.status === 'published') {
    logger.audit('duplicate_prevented', `Reject ignored — already published`, { id, title: rec.title });
    return { ok: false, status: 'published', message: 'Already published — cannot reject.' };
  }
  if (rec.status === 'rejected') {
    logger.audit('duplicate_prevented', `Reject ignored — already rejected`, { id, title: rec.title });
    return { ok: false, status: 'rejected', message: 'Already rejected — ignored.' };
  }

  store.update(id, { status: 'rejected', rejectionReason: 'manual_rejection', decidedAt: now() });
  logger.audit('rejection', `Draft rejected (manual_rejection)`, { id, title: rec.title });
  return { ok: true, status: 'rejected', message: 'Rejected ❌' };
}
