import { ChannelPost, ContentCenterReport } from '../../src/types';
import { CAPTION_LIMIT_PHOTO, CAPTION_LIMIT_TEXT, statusIcon, validatePost } from './index';

/**
 * Telegram formatters for the content command center (EPIC 016). Read-only,
 * HTML. They describe drafts/assets/previews/reports — the actual channel post
 * is sent as plain text by the publisher.
 */

const esc = (s: string) =>
  (s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const snippet = (s: string, n = 80) => {
  const oneLine = (s ?? '').replace(/\s+/g, ' ').trim();
  return oneLine.length > n ? oneLine.slice(0, n - 1) + '…' : oneLine;
};

const footer = '\n\n<i>Nothing publishes without an explicit /approve_publish. Human approval is mandatory.</i>';

export function formatNewPost(post: ChannelPost): string {
  return (
    `📝 <b>Draft created:</b> <code>${esc(post.id)}</code>\n` +
    `Caption: ${esc(snippet(post.caption, 120))}\n\n` +
    `Next:\n` +
    `• <code>/assets</code> — list images\n` +
    `• <code>/attach ${esc(post.id)} &lt;filename&gt;</code> — add an image\n` +
    `• <code>/preview ${esc(post.id)}</code> — see it\n` +
    `• <code>/approve_publish ${esc(post.id)}</code> — publish to the channel` +
    footer
  );
}

export function formatDrafts(posts: ChannelPost[]): string {
  const active = posts.filter((p) => p.status === 'draft');
  if (!active.length) return '🗂 <b>Drafts</b>\n\nNo drafts. Create one with <code>/new_post your text…</code>' + footer;
  const lines = ['🗂 <b>Drafts awaiting approval</b>', ''];
  for (const p of active) {
    const img = p.assetFile ? `🖼 ${esc(p.assetFile)}` : '📄 text only';
    lines.push(`📝 <code>${esc(p.id)}</code> · ${img}\n   ${esc(snippet(p.caption))}`);
  }
  return lines.join('\n') + footer;
}

export function formatPreview(post: ChannelPost | undefined): string {
  if (!post) return '🔍 <b>Preview</b>\n\nPost not found. Usage: <code>/preview p1</code>' + footer;
  const problems = validatePost(post);
  const limit = post.assetFile ? CAPTION_LIMIT_PHOTO : CAPTION_LIMIT_TEXT;
  const lines = [
    `🔍 <b>Preview ${esc(post.id)}</b> — ${statusIcon(post.status)} ${esc(post.status)}`,
    post.assetFile ? `🖼 Image: <code>${esc(post.assetFile)}</code>` : '📄 Text-only post',
    `✏️ Caption (${post.caption.length}/${limit}):`,
    '',
    `<blockquote>${esc(post.caption)}</blockquote>`,
  ];
  if (problems.length) lines.push('', '⚠️ <b>Cannot publish yet:</b>', ...problems.map((p) => `  • ${esc(p)}`));
  else lines.push('', `✅ Ready. Publish with <code>/approve_publish ${esc(post.id)}</code>`);
  return lines.join('\n') + footer;
}

export function formatAssets(files: string[]): string {
  if (!files.length) return '🖼 <b>Assets</b>\n\nNo images found in <code>assets/telegram/kartinki-dlya-postov/</code>.' + footer;
  const lines = ['🖼 <b>Available images</b>', ''];
  files.forEach((f) => lines.push(`• <code>${esc(f)}</code>`));
  lines.push('', 'Attach with <code>/attach &lt;postId&gt; &lt;filename&gt;</code>');
  return lines.join('\n') + footer;
}

export function formatContentReport(r: ContentCenterReport): string {
  const lp = r.lastPublished
    ? `${esc(r.lastPublished.id)} (msg ${r.lastPublished.messageId ?? '?'}) at ${esc(r.lastPublished.at.slice(0, 16).replace('T', ' '))} UTC`
    : '—';
  return (
    '📊 <b>Content center — daily report</b>\n\n' +
    `<b>Today (UTC)</b>: ✍️ ${r.today.created} created · ✅ ${r.today.published} published · ❌ ${r.today.rejected} rejected\n` +
    `<b>Totals</b>: 📝 ${r.totals.draft} drafts · ✅ ${r.totals.published} published · ❌ ${r.totals.rejected} rejected\n` +
    `<b>Pending approval</b>: ${r.pendingApproval}\n` +
    `<b>Last published</b>: ${lp}` +
    footer
  );
}
