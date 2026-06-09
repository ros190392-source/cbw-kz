import { ChannelPost, ChannelPostStatus } from '../../src/types';
import { statusIcon } from '../content-center';
import { RoadmapEntry, SchedulerReport } from './index';

/**
 * Telegram HTML formatters for the roadmap scheduler (EPIC 019).
 */

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function pct(n: number): string {
  return `${Math.round(n * 100)}%`;
}

function shortDate(iso: string): string {
  return iso.slice(0, 10);
}

function kzTime(iso: string): string {
  const d = new Date(iso);
  const kz = new Date(d.getTime() + 5 * 60 * 60 * 1000);
  return `${kz.getUTCHours().toString().padStart(2, '0')}:${kz.getUTCMinutes().toString().padStart(2, '0')} KZ`;
}

// ── /next_post ─────────────────────────────────────────────────────────────

export function formatNextPost(entry: RoadmapEntry | null, publishTime: string): string {
  if (!entry) return '📭 No eligible topic found — all 60 roadmap entries are used or blocked.';
  const lines = [
    `📌 <b>Next post recommendation</b>`,
    '',
    `<b>${esc(entry.title)}</b>`,
    `Pillar: ${esc(entry.pillarName)} (#${entry.pillarId})`,
    `Chip: <code>${esc(entry.chip)}</code>`,
    `Type: ${entry.postType} · Evidence: ${entry.evidenceLevel}`,
    `Image: ${esc(entry.imageTheme)}`,
    entry.hasTemplate ? '✅ Caption template available' : '📝 Needs caption (no template yet)',
    entry.highRisk ? '⚠️ High-risk topic — requires evidence review' : '',
    '',
    `🕐 Next slot: <b>${shortDate(publishTime)}</b> ${kzTime(publishTime)}`,
    '',
    'To generate: <code>/generate_next</code>',
    'To plan a week: <code>/plan_week</code>',
  ].filter(Boolean);
  return lines.join('\n');
}

// ── /plan_week ─────────────────────────────────────────────────────────────

export function formatWeekPlan(
  week: Array<{ date: Date; publishTime: Date; entry: RoadmapEntry | null }>,
): string {
  const lines = ['📅 <b>7-day content plan</b>', ''];
  const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  for (const { date, publishTime, entry } of week) {
    const kz = new Date(date.getTime() + 5 * 60 * 60 * 1000);
    const dow = dayNames[kz.getUTCDay()];
    const dateStr = date.toISOString().slice(5, 10); // MM-DD
    if (!entry) {
      lines.push(`${dow} ${dateStr} — <i>no eligible topic</i>`);
    } else {
      const time = kzTime(publishTime.toISOString());
      lines.push(`${dow} ${dateStr} ${time} — <b>${esc(entry.title)}</b>`);
      lines.push(`    ${esc(entry.pillarName)} · ${entry.chip}${entry.hasTemplate ? '' : ' 📝'}`);
    }
  }

  lines.push('', '📝 = needs caption template', 'Human /approve_publish required for each post.');
  return lines.join('\n');
}

// ── /queue ──────────────────────────────────────────────────────────────────

export function formatSchedulerQueue(
  queue: SchedulerReport['queue'],
): string {
  if (!queue.length) return '📭 Queue is empty. Use <code>/plan_week</code> to generate.';

  const lines = [`📋 <b>Content queue</b> (${queue.length} post${queue.length > 1 ? 's' : ''})`, ''];
  for (const item of queue) {
    const icon = statusIcon(item.status);
    const sched = item.scheduledAt ? ` · ${shortDate(item.scheduledAt)} ${kzTime(item.scheduledAt)}` : '';
    lines.push(`${icon} <code>${item.id}</code> ${esc(item.title || item.topic)}${sched}`);
  }
  lines.push('', 'Approve: <code>/approve_publish &lt;id&gt;</code>');
  return lines.join('\n');
}

// ── /schedule_post ─────────────────────────────────────────────────────────

export function formatScheduleResult(post: ChannelPost | undefined, error?: string): string {
  if (error) return `⚠️ ${esc(error)}`;
  if (!post) return '⚠️ Post not found.';
  return [
    `🕐 <b>Scheduled</b>`,
    `Post: <code>${post.id}</code> — ${esc(post.title || post.topic)}`,
    post.scheduledAt ? `Time: ${shortDate(post.scheduledAt)} ${kzTime(post.scheduledAt)}` : 'No schedule set.',
    `Status: ${statusIcon(post.status)} ${post.status}`,
  ].join('\n');
}

// ── /daily_report (scheduler-enhanced) ─────────────────────────────────────

export function formatSchedulerReport(report: SchedulerReport): string {
  const lines = [
    '📊 <b>Scheduler report</b>',
    '',
    `<b>Roadmap:</b> ${report.roadmapProgress.used}/${report.roadmapProgress.total} used · ${report.roadmapProgress.remaining} remaining`,
    report.highRiskBlocked > 0 ? `⚠️ ${report.highRiskBlocked} high-risk topics blocked (evidence D)` : '',
    '',
    `<b>14-day ratios:</b>`,
    `  Education: ${pct(report.ratios.education)} (target ≥55%)`,
    `  Safety: ${pct(report.ratios.safety)} (target ≥20%)`,
    `  News: ${pct(report.ratios.news)}`,
    '',
  ].filter(Boolean);

  if (report.nextPost) {
    lines.push(`<b>Next:</b> ${esc(report.nextPost.title)} (${esc(report.nextPost.pillarName)})`);
    lines.push(`Publish: ${shortDate(report.nextPublishTime)} ${kzTime(report.nextPublishTime)}`);
  } else {
    lines.push('<b>Next:</b> no eligible topic');
  }

  if (report.queue.length) {
    lines.push('', `<b>Queue:</b> ${report.queue.length} pending`);
    for (const item of report.queue.slice(0, 5)) {
      lines.push(`  ${statusIcon(item.status)} ${esc(item.title || item.topic)}`);
    }
    if (report.queue.length > 5) lines.push(`  … +${report.queue.length - 5} more`);
  }

  lines.push('', 'Human /approve_publish is the only publish path.');
  return lines.join('\n');
}
