import { describe, it, expect } from 'vitest';
import { discover, extractCandidates, scamRiskScore } from '../services/discovery-engine';
import { DEFAULT_EXCHANGES } from '../services/exchange-registry';
import { NewsItem } from '../src/types';

let n = 0;
function news(title: string, summary = '', source = 'Cointelegraph'): NewsItem {
  return {
    id: `d-${n++}`, title, link: 'https://example.com/x', source, sourceId: 'src',
    publishDate: '2026-06-01T00:00:00.000Z', summary,
  };
}
const known = { exchanges: DEFAULT_EXCHANGES };

describe('scam risk', () => {
  it('counts scam keywords', () => {
    expect(scamRiskScore('guaranteed 100x risk-free returns')).toBeGreaterThanOrEqual(60);
    expect(scamRiskScore('a normal sober news headline')).toBe(0);
  });
});

describe('candidate extraction', () => {
  it('extracts brand-like names, skips stopwords', () => {
    const c = extractCandidates('Whitebit exchange lists a new token');
    expect(c.some((x) => x.name === 'Whitebit' && x.kind === 'exchange')).toBe(true);
    // "New exchange" must not be extracted as a brand
    expect(extractCandidates('A new exchange opened').some((x) => x.name.toLowerCase() === 'new')).toBe(false);
  });
});

describe('discovery', () => {
  it('proposes an unknown exchange for MANUAL review (never auto-add)', () => {
    const out = discover([news('Whitebit exchange lists a new token')], known);
    const c = out.find((d) => d.id === 'exchange:whitebit');
    expect(c).toBeDefined();
    expect(c!.rejected).toBe(false);
    expect(c!.confidence).toBeGreaterThan(0);
    expect(c!.suggestedAction.toLowerCase()).toContain('manual review');
  });

  it('skips exchanges already in the registry', () => {
    const out = discover([news('Bybit launches a new feature')], known);
    expect(out.some((d) => d.id === 'exchange:bybit')).toBe(false);
  });

  it('rejects obvious scam patterns', () => {
    const out = discover(
      [news('MoonSafeX exchange offers guaranteed 100x risk-free returns', '', 'Some Telegram channel')],
      known,
    );
    const c = out.find((d) => d.id === 'exchange:moonsafex');
    expect(c).toBeDefined();
    expect(c!.rejected).toBe(true);
    expect(c!.scamRisk).toBeGreaterThanOrEqual(60);
    expect(c!.confidence).toBeLessThanOrEqual(15);
  });

  it('weak source scores lower than trusted for the same unknown exchange', () => {
    const trusted = discover([news('Whitebit exchange lists a token', '', 'Cointelegraph')], known)
      .find((d) => d.id === 'exchange:whitebit')!;
    const weak = discover([news('Whitebit exchange lists a token', '', 'Random Medium blog')], known)
      .find((d) => d.id === 'exchange:whitebit')!;
    expect(trusted.confidence).toBeGreaterThan(weak.confidence);
  });

  it('safe candidates are sorted before rejected ones', () => {
    const out = discover(
      [
        news('Whitebit exchange lists a token'),
        news('ScamX exchange guaranteed 1000x risk-free giveaway', '', 'telegram'),
      ],
      known,
    );
    expect(out[0].rejected).toBe(false);
    expect(out[out.length - 1].rejected).toBe(true);
  });
});
