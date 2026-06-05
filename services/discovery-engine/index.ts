import { BonusRecord, DiscoveryCandidate, ExchangeRecord, NewsItem } from '../../src/types';
import { sourceTrustFor } from '../research-engine';

/**
 * Discovery engine (EPIC 006 · Phase 4).
 *
 * Scans news for UNKNOWN exchanges / launchpools / bonuses (not already in the
 * registry) and proposes them as candidates for MANUAL review, with a
 * confidence score and a scam-risk score. Obvious scam patterns are rejected
 * and never suggested. It NEVER writes to the registry — every candidate is a
 * suggestion a human must act on.
 *
 * Pure + deterministic; helpers exported for testing.
 */

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));
const lc = (s: string) => (s ?? '').toLowerCase();

/** Phrases that strongly signal a scam / pump pitch. */
const SCAM_KEYWORDS = [
  'guaranteed', 'risk-free', 'risk free', '100x', '1000x', 'x100', 'double your', 'triple your',
  'send eth', 'send bnb', 'connect wallet', 'seed phrase', 'claim now', 'giveaway', 'elon',
  'free money', '100% profit', 'no risk', 'guaranteed returns', 'to the moon', 'get rich',
];

/** Words that are not real brand names (avoid false-positive extraction). */
const STOPWORDS = new Set([
  'the', 'this', 'that', 'these', 'those', 'new', 'crypto', 'major', 'top', 'best', 'a', 'an',
  'our', 'its', 'his', 'her', 'their', 'big', 'first', 'global', 'leading', 'popular', 'another',
]);

export function scamRiskScore(text: string): number {
  const hay = lc(text);
  const hits = SCAM_KEYWORDS.filter((k) => hay.includes(k)).length;
  return clamp(hits * 30, 0, 100);
}

interface Extracted { kind: DiscoveryCandidate['kind']; name: string }

/** Pull candidate brand names + their kind from one text. */
export function extractCandidates(text: string): Extracted[] {
  const out: Extracted[] = [];
  const push = (kind: DiscoveryCandidate['kind'], name: string) => {
    const clean = name.trim();
    if (clean.length < 3) return;
    if (STOPWORDS.has(lc(clean))) return;
    out.push({ kind, name: clean });
  };

  const patterns: { re: RegExp; kind: DiscoveryCandidate['kind'] }[] = [
    { re: /\b([A-Z][A-Za-z0-9.]{2,15})\s+(?:crypto\s+)?exchange\b/g, kind: 'exchange' },
    { re: /\b([A-Z][A-Za-z0-9.]{2,15})\s+(?:launches|lists|listing|debuts)\b/g, kind: 'exchange' },
    { re: /\b([A-Z][A-Za-z0-9.]{2,15})\s+launch\s?pool\b/gi, kind: 'launchpool' },
    { re: /\b([A-Z][A-Za-z0-9.]{2,15})\s+(?:airdrop|bonus|rewards)\b/g, kind: 'bonus' },
  ];
  for (const { re, kind } of patterns) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) push(kind, m[1]);
  }
  return out;
}

export interface KnownData {
  exchanges: ExchangeRecord[];
  bonuses?: BonusRecord[];
}

function knownExchangeSet(exchanges: ExchangeRecord[]): Set<string> {
  const s = new Set<string>();
  for (const e of exchanges) {
    s.add(lc(e.slug));
    s.add(lc(e.name));
    s.add(lc(e.name).replace(/\.io$/, '')); // gate.io → gate
  }
  return s;
}

/**
 * Discover unknown candidates from news. Known exchanges are skipped; scam
 * patterns are rejected (kept, but flagged + zero-suggestion). Returns
 * de-duplicated candidates, safe (non-rejected) first by confidence.
 */
export function discover(
  items: NewsItem[],
  known: KnownData,
  now = new Date().toISOString(),
): DiscoveryCandidate[] {
  const knownEx = knownExchangeSet(known.exchanges);
  const byId = new Map<string, DiscoveryCandidate>();

  for (const item of items) {
    const text = `${item.title} ${item.summary}`;
    const risk = scamRiskScore(text);
    const trust = sourceTrustFor(item.source);
    const base = trust === 'trusted' ? 75 : trust === 'weak' ? 30 : 55;

    for (const { kind, name } of extractCandidates(text)) {
      const nameLc = lc(name);
      // Skip things already in the registry (only for exchange kind).
      if (kind === 'exchange' && knownEx.has(nameLc)) continue;
      if (kind === 'launchpool' && knownEx.has(nameLc)) continue;

      const rejected = risk >= 60;
      let confidence = clamp(base - risk * 0.6 + (trust === 'trusted' ? 8 : 0), 0, 100);
      if (rejected) confidence = Math.min(confidence, 15);

      const id = `${kind}:${nameLc}`;
      const candidate: DiscoveryCandidate = {
        id,
        kind,
        name,
        sourceLink: item.link,
        source: item.source,
        confidence,
        scamRisk: risk,
        rejected,
        reason: rejected
          ? `Scam pattern detected (risk ${risk}) — rejected, not suggested.`
          : `Unknown ${kind} from ${trust} source — candidate for manual review.`,
        suggestedAction: rejected
          ? 'Reject — do NOT add to registry.'
          : 'Manual review required before adding to registry (never auto-added).',
      };

      const prev = byId.get(id);
      // Keep the strongest (or a rejection, which always wins for safety).
      if (!prev || candidate.rejected || candidate.confidence > prev.confidence) {
        byId.set(id, prev?.rejected ? prev : candidate);
      }
    }
  }

  return [...byId.values()].sort((a, b) => {
    if (a.rejected !== b.rejected) return a.rejected ? 1 : -1; // safe first
    return b.confidence - a.confidence || a.name.localeCompare(b.name);
  });
}
