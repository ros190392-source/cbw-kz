import { DraftContent, LocalizedDraft } from '../../src/types';

/**
 * Telegram formatters for the content-generation commands (EPIC 009): /draft,
 * /outline, /seo, /localized. Pure, READ-ONLY PREVIEW builders. Every preview is
 * stamped machine-generated + human-review-required and shows the verification
 * warnings — nothing here is publishable as-is.
 */

const esc = (s: string) =>
  (s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const confIcon = (c: number) => (c >= 60 ? '🟢' : c >= 25 ? '🟡' : '🔴');
const stamp = '🤖 machine-generated · 👤 human review required';

function header(d: DraftContent): string {
  return `🧾 <b>${esc(d.type)} preview</b> · ${esc(d.tone)} · ${esc(d.locale)}/${esc(d.geo ?? '—')}\n${stamp}`;
}

function citationsBlock(d: DraftContent): string[] {
  if (!d.citations.length) return [];
  const lines = ['', '<b>Verification</b>:'];
  for (const c of d.citations) {
    lines.push(`  ${confIcon(c.confidence)} ${esc(c.target)} — ${esc(c.note)} · conf ${c.confidence} · ${esc(c.freshness)}${c.reliable ? '' : ' ⚠️'}`);
  }
  return lines;
}

function warningsBlock(d: DraftContent): string[] {
  if (!d.warnings.length) return [];
  return ['', '<b>⚠️ Warnings</b>:', ...d.warnings.map((w) => `  • ${esc(w)}`)];
}

export function formatDraft(d: DraftContent): string {
  return [
    header(d),
    '',
    `<b>${esc(d.title)}</b>`,
    '',
    `<pre>${esc(d.body)}</pre>`,
    ...citationsBlock(d),
    ...warningsBlock(d),
    '',
    `<i>${esc(d.confidenceNote)}</i>`,
  ].join('\n');
}

export function formatOutline(d: DraftContent): string {
  const lines = [header(d), '', `<b>${esc(d.title)}</b>`, '', `<pre>${esc(d.body)}</pre>`];
  if (d.seo) lines.push('', `🔍 SEO title: ${esc(d.seo.title)}`);
  lines.push(...warningsBlock(d), '', `<i>${esc(d.confidenceNote)}</i>`);
  return lines.join('\n');
}

export function formatSeo(d: DraftContent): string {
  if (!d.seo) return formatDraft(d);
  const s = d.seo;
  const lines = [
    header(d),
    '',
    `🔍 <b>Title</b>: ${esc(s.title)} (${s.title.length} chars)`,
    `📝 <b>Meta</b>: ${esc(s.metaDescription)} (${s.metaDescription.length}/160)`,
    '',
    '<b>Keyword clusters</b> (no stuffing):',
    ...s.keywordClusters.map((c, i) => `  ${i + 1}. ${esc(c.join(', '))}`),
    '',
    '<b>FAQ ideas</b>:',
    ...s.faqIdeas.map((q) => `  • ${esc(q)}`),
    '',
    `CTA: <code>${esc(s.ctaPlaceholder)}</code> (placeholder — never auto-injected)`,
    ...warningsBlock(d),
  ];
  return lines.join('\n');
}

export function formatLocalized(loc: LocalizedDraft): string {
  const lines = [
    `🌐 <b>Localized draft scaffolds</b> · base ${esc(loc.baseLocale)}`,
    '🤖 machine-generated · 👤 human translation + review required',
    '',
  ];
  for (const v of loc.variants) {
    lines.push(`<b>${esc(v.locale)}</b> — ${esc(v.title)}`);
    lines.push(`   <i>${esc(v.note)}</i>`);
  }
  lines.push('', '<i>Not auto-translated — these are scaffolds for a human translator.</i>');
  return lines.join('\n');
}
