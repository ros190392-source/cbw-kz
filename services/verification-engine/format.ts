import { ExchangeRecord, KzGeoSnapshot, VerificationClaim } from '../../src/types';
import {
  buildKzSnapshot,
  claimFreshness,
  computeConfidence,
  confidenceBand,
  verdictFor,
} from './index';

/**
 * Telegram formatters for the verification commands (EPIC 003 · Phase 6):
 * /verify <slug>, /confidence, /stale, /evidence. Pure string builders. Output
 * always foregrounds confidence + freshness so a moderator can see how much to
 * trust the data — low-confidence items are clearly flagged, never hidden.
 */

const esc = (s: string) =>
  (s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const confIcon = (c: number) => {
  const b = confidenceBand(c);
  return b === 'high' ? '🟢' : b === 'medium' ? '🟡' : b === 'low' ? '🟠' : '🔴';
};
const freshIcon = (f: string) =>
  f === 'fresh' ? '🟢' : f === 'aging' ? '🟡' : f === 'stale' ? '🟠' : '🔴';

const yn = (b: boolean) => (b ? '✅' : '❌');

export function formatSnapshot(snap: KzGeoSnapshot, claims: VerificationClaim[], now = new Date()): string {
  const head = [
    `🔎 <b>Verify — ${esc(snap.name)}</b> (${esc(snap.country)})`,
    `${confIcon(snap.confidence)} Confidence: <b>${snap.confidence}/100</b> (${confidenceBand(
      snap.confidence,
    )}) · ${freshIcon(snap.freshness)} ${esc(snap.freshness)}`,
    `Reliable: ${snap.reliable ? '✅ yes' : '⚠️ NO — prefer uncertainty'}`,
    '',
    `KYC: ${esc(snap.kyc)} · P2P: ${yn(snap.p2p)} · KZT: ${yn(snap.kzt)}`,
    `Local banks: ${esc(snap.localBanks.join(', ') || '—')}`,
    `📝 ${esc(snap.notes)}`,
  ];
  const verdicts = claims
    .filter((c) => c.exchangeSlug === snap.exchangeSlug && c.country.toUpperCase() === 'KZ')
    .map((c) => verdictFor(c, now))
    .sort((a, b) => b.confidence - a.confidence);
  if (verdicts.length) {
    head.push('', '<b>Claims:</b>');
    for (const v of verdicts) {
      head.push(
        `  ${confIcon(v.confidence)} ${esc(v.type)} = <code>${esc(v.assertion)}</code> · ` +
          `${v.confidence}/100 · ${freshIcon(v.freshness)}${v.reliable ? '' : ' ⚠️'} · ${v.evidenceCount} ev`,
      );
    }
  }
  return head.join('\n');
}

/** /verify <slug> */
export function formatVerify(
  ex: ExchangeRecord | undefined,
  claims: VerificationClaim[],
  now = new Date(),
): string {
  if (!ex) return '🔎 <b>Verify</b>\n\nUnknown exchange. Try e.g. <code>/verify bybit</code>.';
  return formatSnapshot(buildKzSnapshot(ex, claims, now), claims, now);
}

/** /confidence — aggregate KZ confidence per exchange. */
export function formatConfidence(
  exchanges: ExchangeRecord[],
  claims: VerificationClaim[],
  now = new Date(),
): string {
  if (!exchanges.length) return '📊 <b>Confidence</b>\n\nNo exchanges.';
  const rows = exchanges
    .map((ex) => buildKzSnapshot(ex, claims, now))
    .sort((a, b) => b.confidence - a.confidence)
    .map(
      (s) =>
        `${confIcon(s.confidence)} <b>${esc(s.name)}</b> — ${s.confidence}/100 · ${freshIcon(
          s.freshness,
        )} ${esc(s.freshness)}${s.reliable ? '' : ' ⚠️'}`,
    );
  return ['📊 <b>KZ verification confidence</b>', '', ...rows].join('\n');
}

/** /stale — claims that need a recheck. */
export function formatStale(stale: VerificationClaim[], now = new Date()): string {
  if (!stale.length) return '✅ <b>Stale check</b>\n\nNo claims need a recheck right now.';
  const rows = stale
    .map((c) => ({ c, f: claimFreshness(c, now) }))
    .sort((a, b) => (a.f === 'expired' ? -1 : 1))
    .map(
      ({ c, f }) =>
        `${freshIcon(f)} <code>${esc(c.id)}</code> · ${esc(f)} · last: ${
          c.lastCheckedAt ? esc(c.lastCheckedAt.slice(0, 10)) : 'never'
        }`,
    );
  return ['🕒 <b>Stale claims — recheck required</b>', '', ...rows].join('\n');
}

/** /evidence <slug> — evidence behind each claim. */
export function formatEvidence(
  slug: string,
  claims: VerificationClaim[],
  now = new Date(),
): string {
  const forEx = claims.filter((c) => c.exchangeSlug === slug.toLowerCase());
  if (!forEx.length) return `🧾 <b>Evidence</b>\n\nNo claims for <code>${esc(slug)}</code>.`;
  const lines: string[] = [`🧾 <b>Evidence — ${esc(slug)}</b>`];
  for (const c of forEx) {
    lines.push('', `<b>${esc(c.type)}</b> = <code>${esc(c.assertion)}</code> · ${computeConfidence(c, now)}/100`);
    if (!c.evidence.length) lines.push('   (no evidence)');
    for (const e of c.evidence) {
      const src = e.sourceUrl ? `<a href="${esc(e.sourceUrl)}">src</a>` : 'no-src';
      lines.push(
        `   • ${esc(e.type)} · ${esc(e.status)} · ${esc(e.reviewer)} · ${esc(
          e.verifiedAt.slice(0, 10),
        )} · ${src}`,
      );
    }
  }
  return lines.join('\n');
}
