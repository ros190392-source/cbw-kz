import { LocaleDefinition } from '../../src/types';
import { GeoProfile } from '../geo-engine';
import { allLocales, getLocale, preferredLocales } from './index';

/**
 * Telegram formatters for the locale / GEO-expansion commands (EPIC 004 ·
 * Phase 6): /locales and an enriched /geo <country>. Pure string builders.
 */

const esc = (s: string) =>
  (s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const yn = (b: boolean) => (b ? '✅' : '❌');
const trustIcon = (t: GeoProfile['trustLevel']) =>
  t === 'high' ? '🟢' : t === 'medium' ? '🟡' : '🔴';

function localeLine(l: LocaleDefinition): string {
  return (
    `<b>${esc(l.code)}</b> (${esc(l.languageName)}) · ${esc(l.country)} · ${esc(l.defaultCurrency)} · ` +
    `↩ ${esc(l.fallback ?? 'none')}`
  );
}

/** /locales — every configured locale + its monetization defaults. */
export function formatLocales(): string {
  const rows = allLocales().map((l) =>
    [
      `${localeLine(l)}`,
      `   exchanges: ${esc(l.preferredExchanges.join(', '))}`,
      `   pay: ${esc(l.localPaymentMethods.join(', '))}`,
    ].join('\n'),
  );
  return ['🌐 <b>Locales</b>', '', ...rows].join('\n');
}

/**
 * /geo <country> — supported locales, preferred exchanges (with availability +
 * trust), and local payment/fiat support. `profiles` come from the GEO engine
 * (already availability-filtered + trust-sorted).
 */
export function formatGeoExpansion(country: string, profiles: GeoProfile[]): string {
  const cc = country.toUpperCase();
  const codes = preferredLocales(cc);
  const locales = codes.map(getLocale).filter((l): l is LocaleDefinition => !!l);

  const lines: string[] = [`🌍 <b>GEO expansion — ${esc(cc)}</b>`, ''];

  lines.push('<b>Locales</b> (preferred → fallback):');
  if (locales.length) {
    for (const l of locales) lines.push(`  • ${localeLine(l)}`);
  } else {
    lines.push('  • (none configured)');
  }

  // Union of local payment rails across this country's locales.
  const pay = [...new Set(locales.flatMap((l) => l.localPaymentMethods))];
  if (pay.length) lines.push('', `💳 Payments/fiat: ${esc(pay.join(', '))}`);

  lines.push('', '<b>Preferred exchanges</b> (available here):');
  if (profiles.length) {
    for (const p of profiles) {
      lines.push(
        `  ${trustIcon(p.trustLevel)} <b>${esc(p.name)}</b> — P2P: ${yn(p.p2p)} · KYC: ${esc(
          p.kyc,
        )} · trust: ${esc(p.trustLevel)}`,
      );
    }
  } else {
    lines.push('  • No available exchanges on record.');
  }

  lines.push('', '<i>Availability is a baseline — confirm with /verify &lt;exchange&gt;.</i>');
  return lines.join('\n');
}
