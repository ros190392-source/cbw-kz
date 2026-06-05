import { AdminAlert, AlertType } from '../../src/types';
import { logger } from '../../src/logger';

/**
 * Admin alerts (EPIC 011 · Phase 4).
 *
 * Notification-ONLY. Sends operational alerts (startup, shutdown, health red,
 * pipeline error, publish failure, stale data) to the moderation/admin chat.
 * It performs NO actions — it never publishes, approves, restarts, or mutates
 * anything. The Telegram send function is injected so this is fully testable and
 * decoupled from the bot.
 */

const SEVERITY: Record<AlertType, AdminAlert['severity']> = {
  startup: 'info',
  shutdown: 'info',
  health_red: 'error',
  pipeline_error: 'error',
  publish_failure: 'error',
  stale_data: 'warn',
};

const ICON: Record<AdminAlert['severity'], string> = { info: 'ℹ️', warn: '⚠️', error: '🚨' };

const esc = (s: string) =>
  (s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function makeAlert(
  type: AlertType,
  message: string,
  data: Record<string, unknown> = {},
  now = new Date().toISOString(),
): AdminAlert {
  return { type, severity: SEVERITY[type], message, data, at: now };
}

export function formatAlert(alert: AdminAlert): string {
  const lines = [
    `${ICON[alert.severity]} <b>CBW KZ alert — ${esc(alert.type)}</b>`,
    esc(alert.message),
  ];
  const entries = Object.entries(alert.data ?? {});
  if (entries.length) {
    lines.push('', ...entries.map(([k, v]) => `• ${esc(k)}: ${esc(String(v))}`));
  }
  lines.push('', `<i>${esc(alert.at)} · notification only — no action taken.</i>`);
  return lines.join('\n');
}

export type AlertSender = (text: string) => Promise<void>;

export class AdminAlerts {
  constructor(private enabled: boolean, private sender?: AlertSender) {}

  /**
   * Deliver an alert. Always logs an audit line; sends to Telegram only when
   * alerts are enabled AND a sender is wired. Never throws (alerting must not
   * crash the runtime).
   */
  async send(type: AlertType, message: string, data: Record<string, unknown> = {}): Promise<AdminAlert> {
    const alert = makeAlert(type, message, data);
    logger.audit(`alert_${type}`, message, data);
    if (this.enabled && this.sender) {
      try {
        await this.sender(formatAlert(alert));
      } catch (err) {
        logger.error('alerts', `Failed to deliver alert (${type}): ${(err as Error).message}`);
      }
    }
    return alert;
  }

  isEnabled(): boolean {
    return this.enabled;
  }
}
