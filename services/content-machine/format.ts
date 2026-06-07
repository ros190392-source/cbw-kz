import { ChannelPost, ContentMachineReport, DailyContentPlan } from '../../src/types';
import { statusIcon, validatePost, CAPTION_LIMIT_PHOTO, CAPTION_LIMIT_TEXT } from '../content-center';
import { ImageResult, PackResult } from './index';

/**
 * Telegram formatters for the content machine (EPIC 016): /today_posts,
 * /preview_post, /daily_report, generation results. Read-only, HTML. They never
 * publish — the channel post is sent by the content-center publisher on approval.
 */

const esc = (s: string) => (s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const snippet = (s: string, n = 90) => {
  const one = (s ?? '').replace(/\s+/g, ' ').trim();
  return one.length > n ? one.slice(0, n - 1) + '…' : one;
};
const footer = '\n\n<i>Auto-prepared drafts. Nothing publishes without /approve_publish — human approval is mandatory.</i>';

export function formatTodayPosts(plan: DailyContentPlan, posts: ChannelPost[]): string {
  const byTopic = new Map(posts.filter((p) => p.status !== 'rejected').map((p) => [p.topic, p]));
  const lines = [`🗓 <b>Content plan — ${esc(plan.date)}</b>`, ''];
  plan.items.forEach((it, i) => {
    const p = byTopic.get(it.topicKey);
    const state = p ? `${statusIcon(p.status)} ${esc(p.status)} (<code>${esc(p.id)}</code>${p.assetFile ? ' 🖼' : ' ⬜'})` : '⚪ not generated';
    lines.push(`${i + 1}. <b>${esc(it.title)}</b> · ${esc(it.postType)}\n   ${state}`);
  });
  lines.push('', 'Generate missing with <code>/generate_post</code>, or one: <code>/generate_post &lt;topic&gt;</code>');
  return lines.join('\n') + footer;
}

export function formatGeneratedPack(result: PackResult): string {
  const lines = ['🤖 <b>Generated content pack</b>', ''];
  for (const p of result.created) {
    lines.push(`${statusIcon(p.status)} <code>${esc(p.id)}</code> — ${esc(p.title)} ${p.assetFile ? '🖼' : '⬜ no image'}`);
  }
  if (result.skipped.length) lines.push('', `Skipped (already exist): ${result.skipped.map(esc).join(', ')}`);
  if (result.missingImages.length) lines.push(`⚠️ Missing images: ${result.missingImages.map(esc).join(', ')} — attach with /generate_image or /attach`);
  lines.push('', 'Preview any with <code>/preview_post &lt;id&gt;</code>.');
  return lines.join('\n') + footer;
}

export function formatPreviewPost(post: ChannelPost | undefined): string {
  if (!post) return '🔍 <b>Preview</b>\n\nPost not found. Usage: <code>/preview_post p1</code>' + footer;
  const problems = validatePost(post);
  const limit = post.assetFile ? CAPTION_LIMIT_PHOTO : CAPTION_LIMIT_TEXT;
  const lines = [
    `🔍 <b>${esc(post.title || post.topic)}</b> — ${statusIcon(post.status)} ${esc(post.status)} <code>${esc(post.id)}</code>`,
    `📂 ${esc(post.postType)} · topic ${esc(post.topic)} · evidence ${esc(post.evidenceLevel ?? '—')}`,
    post.assetFile ? `🖼 Image: <code>${esc(post.assetFile)}</code>` : (post.requiresImage ? '⬜ Image: MISSING (required)' : '📄 Text-only'),
    `✏️ Caption (${post.caption.length}/${limit}):`,
    '',
    `<blockquote>${esc(post.caption)}</blockquote>`,
  ];
  if (problems.length) lines.push('', '⚠️ <b>Cannot publish yet:</b>', ...problems.map((p) => `  • ${esc(p)}`));
  else lines.push('', `✅ Ready. Publish with <code>/approve_publish ${esc(post.id)}</code>`);
  return lines.join('\n') + footer;
}

export function formatImageResult(post: ChannelPost, img: ImageResult): string {
  const status = img.generated ? '🎨 generated' : img.usedFallback ? '🗂 fallback template' : '⚠️ none available';
  return (
    `🖼 <b>Image for ${esc(post.id)}</b> — ${status}\n` +
    (img.imageFile ? `File: <code>${esc(img.imageFile)}</code>\n` : 'No image could be resolved — attach one with /attach.\n') +
    `Prompt:\n<blockquote>${esc(img.prompt)}</blockquote>` +
    footer
  );
}

export function formatDailyReport(r: ContentMachineReport): string {
  const c = r.counts;
  const lines = [
    `📊 <b>Content machine — ${esc(r.plan.date)}</b>`,
    '',
    `<b>Pipeline</b>: 📝 ${c.draft} draft · 🟢 ${c.ready} ready · 👍 ${c.approved} approved · ✅ ${c.published} published · ❌ ${c.rejected} rejected`,
    `<b>Today</b>: ✅ ${r.publishedToday} published · ❌ ${r.rejectedToday} rejected`,
    '',
  ];
  if (r.pending.length) {
    lines.push('<b>Pending approval</b>:');
    r.pending.forEach((p) => lines.push(`  ${statusIcon(p.status)} <code>${esc(p.id)}</code> ${esc(p.title)}`));
  } else lines.push('<b>Pending approval</b>: none');
  if (r.missingImages.length) {
    lines.push('', '⚠️ <b>Missing images</b>:', ...r.missingImages.map((m) => `  • <code>${esc(m.id)}</code> ${esc(m.title)}`));
  }
  if (r.gaps.length) lines.push('', `🕳 <b>Content gaps</b> (no draft): ${r.gaps.map(esc).join(', ')}`);
  return lines.join('\n') + footer;
}
