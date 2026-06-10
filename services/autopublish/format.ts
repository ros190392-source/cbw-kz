import { AutopublishState } from './index';

/**
 * Telegram HTML formatters for autopublish commands (EPIC 020).
 */

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function shortDate(iso: string | null): string {
  return iso ? iso.slice(0, 16).replace('T', ' ') + ' UTC' : 'never';
}

export function formatAutopublishToggle(state: AutopublishState, action: 'enabled' | 'disabled'): string {
  const icon = action === 'enabled' ? '🟢' : '🔴';
  return [
    `${icon} <b>Autopublish ${action}</b>`,
    '',
    `By: ${esc(state.enabledBy ?? 'unknown')}`,
    `At: ${shortDate(state.enabledAt)}`,
    '',
    action === 'enabled'
      ? 'The scheduler will publish one post per day at the scheduled KZ time.'
      : 'Automatic publishing is OFF. Use /autopublish_on to re-enable.',
    '',
    'Manual /approve_publish still works independently.',
  ].join('\n');
}

export function formatAutopublishStatus(state: AutopublishState): string {
  const icon = state.enabled ? '🟢' : '🔴';
  const lines = [
    `${icon} <b>Autopublish status</b>`,
    '',
    `Enabled: <b>${state.enabled ? 'YES' : 'NO'}</b>`,
    `Set by: ${esc(state.enabledBy ?? '—')}`,
    `Set at: ${shortDate(state.enabledAt)}`,
    '',
    `Last tick: ${shortDate(state.lastTickAt)}`,
    `Last publish: ${shortDate(state.lastPublishAt)}`,
  ];

  if (state.consecutiveFailures > 0) {
    lines.push(`⚠️ Consecutive failures: ${state.consecutiveFailures}`);
  }
  if (state.lastError) {
    lines.push(`Last error: ${esc(state.lastError)}`);
  }

  lines.push(
    '',
    'Commands:',
    '  /autopublish_on — enable',
    '  /autopublish_off — disable',
    '  /autopublish_status — this report',
  );

  return lines.join('\n');
}
