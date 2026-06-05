import { describe, it, expect } from 'vitest';
import { classifyItem, research, sourceTrustFor } from '../services/research-engine';
import { NewsItem } from '../src/types';

let n = 0;
function news(title: string, summary = '', source = 'Cointelegraph'): NewsItem {
  return {
    id: `item-${n++}`, title, link: 'https://example.com', source, sourceId: 'src',
    publishDate: '2026-06-01T00:00:00.000Z', summary,
  };
}

describe('source trust', () => {
  it('classifies trusted / weak / neutral sources', () => {
    expect(sourceTrustFor('Cointelegraph')).toBe('trusted');
    expect(sourceTrustFor('Some Medium Blog')).toBe('weak');
    expect(sourceTrustFor('Unknown Outlet')).toBe('neutral');
  });
});

describe('classification + priority', () => {
  it('launchpool → HIGH', () => {
    const f = classifyItem(news('Bybit launches new Launchpool campaign'));
    expect(f.category).toBe('launchpool');
    expect(f.priority).toBe('HIGH');
    expect(f.exchanges).toContain('bybit');
    expect(f.humanVerificationRequired).toBe(true);
  });

  it('restriction/sanction → HIGH', () => {
    const f = classifyItem(news('Exchange to suspend services and ban users in the region'));
    expect(f.category).toBe('restriction');
    expect(f.priority).toBe('HIGH');
  });

  it('plain listing → MEDIUM', () => {
    const f = classifyItem(news('OKX will list a new token next week'));
    expect(f.category).toBe('listing');
    expect(f.priority).toBe('MEDIUM');
  });

  it('generic news → LOW', () => {
    const f = classifyItem(news('Weekly bitcoin price analysis and market mood'));
    expect(f.category).toBe('news');
    expect(f.priority).toBe('LOW');
  });

  it('KZ boost raises a MEDIUM regulation finding to HIGH and tags geo', () => {
    const f = classifyItem(news('Kazakhstan introduces new crypto regulation in Astana'));
    expect(f.geos).toContain('KZ');
    expect(f.priority).toBe('HIGH'); // regulation (MEDIUM) bumped by KZ
  });
});

describe('confidence + weak-source downranking', () => {
  it('weak source scores lower than a trusted one for the same story', () => {
    const trusted = classifyItem(news('Bybit launches new Launchpool', '', 'Cointelegraph'));
    const weak = classifyItem(news('Bybit launches new Launchpool', '', 'Random Medium Blog'));
    expect(trusted.confidence).toBeGreaterThan(weak.confidence);
    expect(weak.sourceTrust).toBe('weak');
  });
});

describe('research batch', () => {
  it('de-duplicates by normalized title and sorts HIGH first', () => {
    const items = [
      news('Weekly bitcoin price analysis'),               // LOW
      news('Bybit launches new Launchpool campaign'),      // HIGH
      news('Bybit launches new Launchpool campaign'),      // dup
    ];
    const findings = research(items);
    expect(findings).toHaveLength(2); // dup removed
    expect(findings[0].priority).toBe('HIGH');
  });
});
