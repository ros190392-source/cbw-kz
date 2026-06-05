import { NewsItem, PostAnalyticsRecord, ResearchSnapshot } from '../../src/types';
import { research } from './index';
import { buildTrends } from '../trend-engine';
import { discover, KnownData } from '../discovery-engine';

/**
 * Assembles a full ResearchSnapshot from news inputs: findings (research-engine)
 * + trends (trend-engine) + discovery candidates (discovery-engine). Pure;
 * lives outside the individual engines to avoid import cycles.
 */
export function buildSnapshot(
  items: NewsItem[],
  posts: PostAnalyticsRecord[],
  known: KnownData,
  now = new Date().toISOString(),
): ResearchSnapshot {
  const findings = research(items, now);
  const trends = buildTrends(findings, posts);
  const discoveries = discover(items, known, now);

  return {
    generatedAt: now,
    findings,
    trends,
    discoveries,
    counts: {
      high: findings.filter((f) => f.priority === 'HIGH').length,
      medium: findings.filter((f) => f.priority === 'MEDIUM').length,
      low: findings.filter((f) => f.priority === 'LOW').length,
      discoveries: discoveries.filter((d) => !d.rejected).length,
      rejected: discoveries.filter((d) => d.rejected).length,
    },
  };
}
