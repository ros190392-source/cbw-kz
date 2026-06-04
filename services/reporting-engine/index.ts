import {
  AnalyticsReport,
  DraftRecord,
  PostAnalyticsRecord,
  ReportPeriod,
  ReportPostRef,
} from '../../src/types';
import {
  aggregateByCategory,
  aggregateByExchange,
  engagementScore,
  topPosts,
} from '../analytics-layer';

/**
 * Reporting engine (EPIC 001 · Phases 4-5).
 *
 * Turns published-post analytics + the draft lifecycle into daily / weekly
 * reports. Pure and deterministic: pass in the records and a reference time,
 * get a report object back. The Telegram layer formats + delivers it.
 *
 * Reports describe what HUMANS already approved and published — they do not
 * trigger any publishing.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const round1 = (n: number) => Math.round(n * 10) / 10;

export function windowStart(period: ReportPeriod, now: Date): Date {
  const span = period === 'weekly' ? 7 * DAY_MS : DAY_MS;
  return new Date(now.getTime() - span);
}

function inRange(iso: string | null | undefined, start: Date, end: Date): boolean {
  if (!iso) return false;
  const t = new Date(iso).getTime();
  return Number.isFinite(t) && t >= start.getTime() && t <= end.getTime();
}

export interface ReportInput {
  posts: PostAnalyticsRecord[];
  drafts: DraftRecord[];
  period: ReportPeriod;
  now?: Date;
}

/** Build a daily or weekly report over a rolling time window. */
export function buildReport({ posts, drafts, period, now = new Date() }: ReportInput): AnalyticsReport {
  const start = windowStart(period, now);

  const publishedPosts = posts.filter((p) => inRange(p.publishedAt, start, now));

  // Draft lifecycle counts within the window (by decision time).
  const decidedInRange = drafts.filter((d) => inRange(d.decidedAt, start, now));
  const approvalCount = decidedInRange.filter(
    (d) => d.status === 'approved' || d.status === 'published',
  ).length;
  const rejectedCount = decidedInRange.filter((d) => d.status === 'rejected').length;
  const publishedCount = decidedInRange.filter((d) => d.status === 'published').length;

  const avgScore = publishedPosts.length
    ? round1(publishedPosts.reduce((a, p) => a + (p.scoreTotal ?? 0), 0) / publishedPosts.length)
    : 0;

  const top = topPosts(publishedPosts, 1)[0];
  const topPost: ReportPostRef | null = top
    ? {
        id: top.id,
        title: top.title,
        category: top.category,
        scoreTotal: top.scoreTotal,
        engagement: engagementScore(top.metrics),
        telegramMessageId: top.telegramMessageId,
      }
    : null;

  const topCategory = aggregateByCategory(publishedPosts)[0]?.key ?? null;
  const topExchange =
    aggregateByExchange(publishedPosts).find((g) => g.key !== 'none')?.key ?? null;

  return {
    period,
    generatedAt: now.toISOString(),
    rangeStart: start.toISOString(),
    rangeEnd: now.toISOString(),
    totalPublished: publishedPosts.length,
    approvalCount,
    rejectedCount,
    publishSuccessRate: approvalCount ? round1(publishedCount / approvalCount) : 1,
    averageScore: avgScore,
    topPost,
    topCategory,
    topExchange,
  };
}

const esc = (s: string) =>
  (s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Render a report as Telegram-ready HTML for the moderation/admin chat. */
export function formatReport(r: AnalyticsReport): string {
  const title = r.period === 'weekly' ? '📈 Weekly report' : '📊 Daily report';
  const pct = Math.round(r.publishSuccessRate * 100);
  const lines = [
    `<b>${title}</b>`,
    `🗓 ${r.rangeStart.slice(0, 10)} → ${r.rangeEnd.slice(0, 10)}`,
    '',
    `📰 Published: <b>${r.totalPublished}</b>`,
    `✅ Approved: ${r.approvalCount} · ❌ Rejected: ${r.rejectedCount}`,
    `🚀 Publish success rate: ${pct}%`,
    `📊 Average score: ${r.averageScore}/100`,
    `🏷 Top category: ${r.topCategory ? esc(r.topCategory) : '—'}`,
    `🏦 Top exchange: ${r.topExchange ? esc(r.topExchange) : '—'}`,
  ];
  if (r.topPost) {
    lines.push(
      '',
      `🏆 Top post (eng ${r.topPost.engagement}, score ${r.topPost.scoreTotal ?? '—'}):`,
      `   «${esc(r.topPost.title)}»`,
    );
  }
  if (r.totalPublished === 0) {
    lines.push('', 'ℹ️ No posts published in this window yet.');
  }
  return lines.join('\n');
}

/** Render a compact "top posts" leaderboard for the /top command. */
export function formatTop(posts: PostAnalyticsRecord[], limit = 5): string {
  const top = topPosts(posts, limit);
  if (!top.length) return '🏆 <b>Top posts</b>\n\nNo published posts yet.';
  const rows = top.map((p, i) => {
    const eng = engagementScore(p.metrics);
    const engTxt = p.metrics.available ? `eng ${eng}` : 'eng n/a';
    return `${i + 1}. «${esc(p.title)}» — ${engTxt} · ${p.scoreTotal ?? '—'}/100 · ${esc(
      p.category ?? '—',
    )}`;
  });
  return ['🏆 <b>Top posts</b>', '', ...rows].join('\n');
}
