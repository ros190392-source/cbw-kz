import { PostAnalyticsRecord, ResearchFinding, TrendSignal } from '../../src/types';

/**
 * Trend engine (EPIC 006 · Phase 3).
 *
 * Detects recurring keywords, trending exchanges/GEOs/categories and a momentum
 * score from research findings, cross-referenced with published-post coverage
 * (analytics) to flag UNDERCOVERED and EMERGING topics. Read-only signals for a
 * human editor — never an instruction to publish.
 *
 * Pure + deterministic; helpers exported for testing.
 */

const round = (n: number) => Math.round(n);

type Kind = TrendSignal['kind'];

function tally(values: string[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const v of values) {
    if (!v) continue;
    m.set(v, (m.get(v) ?? 0) + 1);
  }
  return m;
}

function coverageMaps(posts: PostAnalyticsRecord[]) {
  const exchange = tally(posts.flatMap((p) => p.exchangeMentions));
  const geo = tally(posts.flatMap((p) => p.geoTags));
  return { exchange, geo };
}

function statusFor(
  kind: Kind,
  count: number,
  momentum: number,
  postCoverage: number | null,
): TrendSignal['status'] {
  if (postCoverage != null && postCoverage === 0 && count >= 2) return 'undercovered';
  if (momentum >= 60) return 'trending';
  if (count === 1) return 'emerging';
  return 'steady';
}

function signalsFromTally(
  kind: Kind,
  counts: Map<string, number>,
  coverage?: Map<string, number>,
): TrendSignal[] {
  const max = Math.max(1, ...counts.values());
  const out: TrendSignal[] = [];
  for (const [key, count] of counts) {
    const momentum = round((100 * count) / max);
    const postCoverage = coverage ? coverage.get(key) ?? 0 : null;
    const status = statusFor(kind, count, momentum, postCoverage);
    const cov = postCoverage != null ? ` · coverage ${postCoverage} post(s)` : '';
    out.push({
      key,
      kind,
      count,
      momentum,
      status,
      reason: `${count} mention(s) · momentum ${momentum}${cov}`,
    });
  }
  return out.sort((a, b) => b.momentum - a.momentum || b.count - a.count || a.key.localeCompare(b.key));
}

export function trendingExchanges(findings: ResearchFinding[], posts: PostAnalyticsRecord[] = []): TrendSignal[] {
  return signalsFromTally('exchange', tally(findings.flatMap((f) => f.exchanges)), coverageMaps(posts).exchange);
}

export function trendingGeos(findings: ResearchFinding[], posts: PostAnalyticsRecord[] = []): TrendSignal[] {
  return signalsFromTally('geo', tally(findings.flatMap((f) => f.geos)), coverageMaps(posts).geo);
}

export function trendingKeywords(findings: ResearchFinding[]): TrendSignal[] {
  return signalsFromTally('keyword', tally(findings.flatMap((f) => f.signals)));
}

export function trendingCategories(findings: ResearchFinding[]): TrendSignal[] {
  return signalsFromTally('category', tally(findings.map((f) => f.category)));
}

/** All trend signals across kinds, strongest momentum first. */
export function buildTrends(findings: ResearchFinding[], posts: PostAnalyticsRecord[] = []): TrendSignal[] {
  return [
    ...trendingExchanges(findings, posts),
    ...trendingGeos(findings, posts),
    ...trendingCategories(findings),
    ...trendingKeywords(findings),
  ].sort((a, b) => b.momentum - a.momentum || b.count - a.count);
}

/** Topics with research interest but no published coverage yet. */
export function undercoveredTopics(findings: ResearchFinding[], posts: PostAnalyticsRecord[]): TrendSignal[] {
  return [...trendingExchanges(findings, posts), ...trendingGeos(findings, posts)].filter(
    (t) => t.status === 'undercovered',
  );
}

/** Newly-appearing topics (single mention so far). */
export function emergingTopics(findings: ResearchFinding[], posts: PostAnalyticsRecord[] = []): TrendSignal[] {
  return buildTrends(findings, posts).filter((t) => t.status === 'emerging');
}
