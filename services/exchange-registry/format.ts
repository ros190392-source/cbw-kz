import { BonusRecord, ExchangeRecord } from '../../src/types';
import { GeoProfile } from '../geo-engine';
import { effectiveVerification, isBonusActive } from './index';

/**
 * Telegram formatters for the monetization commands (EPIC 002 · Phase 6):
 * /exchanges, /bonuses, /launchpool, /geo. Pure string builders — the bot just
 * delivers them. Output is moderation-oriented: it always surfaces trust +
 * verification so a moderator can judge accuracy at a glance.
 */

const esc = (s: string) =>
  (s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const yn = (b: boolean) => (b ? '✅' : '❌');
const trustIcon = (t: ExchangeRecord['trustLevel']) =>
  t === 'high' ? '🟢' : t === 'medium' ? '🟡' : '🔴';
const verIcon = (s: string) =>
  s === 'verified' ? '✅' : s === 'outdated' ? '🕒' : '⚠️';

export function formatExchanges(exchanges: ExchangeRecord[]): string {
  if (!exchanges.length) return '🏦 <b>Exchanges</b>\n\nRegistry is empty.';
  const rows = exchanges.map((e) => {
    const kz = e.kazakhstan;
    return [
      `${trustIcon(e.trustLevel)} <b>${esc(e.name)}</b> <code>${esc(e.slug)}</code>`,
      `   KZ: ${yn(kz.available)} · P2P: ${yn(kz.p2p)} · KYC: ${esc(kz.kyc)} · fiat: ${esc(
        kz.fiat.join(', ') || '—',
      )}`,
    ].join('\n');
  });
  return ['🏦 <b>Exchange registry</b> (KZ view)', '', ...rows].join('\n');
}

export function formatBonuses(
  bonuses: BonusRecord[],
  exchanges: ExchangeRecord[],
  now: Date = new Date(),
): string {
  if (!bonuses.length) return '🎁 <b>Bonuses</b>\n\nNo bonuses tracked.';
  const nameFor = (slug: string) => exchanges.find((e) => e.slug === slug)?.name ?? slug;
  const rows = bonuses.map((b) => {
    const status = effectiveVerification(b, now);
    const active = isBonusActive(b, now) ? 'active' : 'inactive';
    return [
      `${verIcon(status)} <b>${esc(nameFor(b.exchangeSlug))}</b> · ${esc(b.type)} · ${active}`,
      `   ${esc(b.title)}${b.value ? ` — ${esc(b.value)}` : ''}`,
      `   status: ${esc(status)} · 🔗 <a href="${esc(b.sourceUrl)}">source</a>`,
    ].join('\n');
  });
  return [
    '🎁 <b>Bonuses</b>',
    '<i>⚠️ = unverified, 🕒 = outdated, ✅ = verified. Verify before publishing.</i>',
    '',
    ...rows,
  ].join('\n');
}

export function formatLaunchpools(
  bonuses: BonusRecord[],
  exchanges: ExchangeRecord[],
  now: Date = new Date(),
): string {
  const pools = bonuses.filter(
    (b) => (b.type === 'launchpool' || b.type === 'launchpad') && isBonusActive(b, now),
  );
  if (!pools.length) return '🚀 <b>Launchpools</b>\n\nNo active launchpools tracked.';
  return formatBonuses(pools, exchanges, now).replace('🎁 <b>Bonuses</b>', '🚀 <b>Launchpools</b>');
}

export function formatGeo(profiles: GeoProfile[], country: string): string {
  if (!profiles.length) {
    return `🌍 <b>GEO: ${esc(country)}</b>\n\nNo available exchanges on record.`;
  }
  const rows = profiles.map(
    (p) =>
      `• <b>${esc(p.name)}</b> — P2P: ${yn(p.p2p)} · KYC: ${esc(p.kyc)} · fiat: ${esc(
        p.fiat.join(', ') || '—',
      )}`,
  );
  return [`🌍 <b>GEO compatibility — ${esc(country)}</b>`, '', ...rows].join('\n');
}
