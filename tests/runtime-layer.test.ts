import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { checkRuntimeHealth, HealthInputs } from '../services/runtime-health';
import { AdminAlerts, formatAlert, makeAlert } from '../services/admin-alerts';
import { BackupEngine } from '../services/backup-engine';

const NOW = new Date('2026-06-10T12:00:00.000Z');

const tmpDirs: string[] = [];
function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cbw-rt-'));
  tmpDirs.push(d);
  return d;
}
afterEach(() => {
  while (tmpDirs.length) {
    const d = tmpDirs.pop()!;
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

function inputs(over: Partial<HealthInputs> = {}): HealthInputs {
  return {
    botToken: over.botToken ?? 'token',
    moderationChatId: over.moderationChatId ?? '-100',
    channelId: over.channelId ?? '-200',
    adminIds: over.adminIds ?? [123],
    dataDir: over.dataDir ?? tmp(),
    logsDir: over.logsDir ?? tmp(),
    lastPipelineRun: 'lastPipelineRun' in over ? over.lastPipelineRun! : NOW.toISOString(),
    lastError: 'lastError' in over ? over.lastError! : null,
    now: NOW,
  };
}

describe('runtime health checks', () => {
  it('is green when config + dirs + stores are all healthy', () => {
    expect(checkRuntimeHealth(inputs()).status).toBe('green');
  });

  it('is RED when a critical config item is missing', () => {
    const r = checkRuntimeHealth(inputs({ botToken: '' }));
    expect(r.status).toBe('red');
    expect(r.checks.find((c) => c.name === 'bot_token')!.ok).toBe(false);
  });

  it('is AMBER when only warnings fail (no channel / no admins)', () => {
    const r = checkRuntimeHealth(inputs({ channelId: '', adminIds: [] }));
    expect(r.status).toBe('amber');
    expect(r.checks.find((c) => c.name === 'publish_channel')!.ok).toBe(false);
    expect(r.checks.find((c) => c.name === 'admin_ids')!.ok).toBe(false);
  });

  it('flags a corrupt JSON store as a warning (amber)', () => {
    const dataDir = tmp();
    fs.writeFileSync(path.join(dataDir, 'processed.json'), '{ not json');
    const r = checkRuntimeHealth(inputs({ dataDir }));
    expect(r.status).toBe('amber');
    expect(r.checks.find((c) => c.name === 'processed_store')!.ok).toBe(false);
  });

  it('warns when a recent pipeline error is present', () => {
    const r = checkRuntimeHealth(inputs({ lastError: 'boom' }));
    expect(r.checks.find((c) => c.name === 'last_error')!.ok).toBe(false);
    expect(r.status).toBe('amber');
  });
});

describe('admin alerts (notification-only)', () => {
  it('maps severity and formats with a no-action note', () => {
    expect(makeAlert('startup', 'up').severity).toBe('info');
    expect(makeAlert('publish_failure', 'x').severity).toBe('error');
    const text = formatAlert(makeAlert('health_red', 'red!', { failing: 'bot_token' }));
    expect(text).toContain('health_red');
    expect(text).toContain('notification only');
    expect(text).toContain('failing');
  });

  it('does not call the sender when disabled', async () => {
    let called = 0;
    const a = new AdminAlerts(false, async () => { called++; });
    await a.send('startup', 'hi');
    expect(called).toBe(0);
    expect(a.isEnabled()).toBe(false);
  });

  it('calls the injected sender when enabled', async () => {
    let payload = '';
    const a = new AdminAlerts(true, async (t) => { payload = t; });
    await a.send('pipeline_error', 'failed', { error: 'e' });
    expect(payload).toContain('pipeline_error');
  });

  it('never throws when the sender fails', async () => {
    const a = new AdminAlerts(true, async () => { throw new Error('telegram down'); });
    await expect(a.send('shutdown', 'bye')).resolves.toBeDefined();
  });
});

describe('backup engine', () => {
  function seedData(): string {
    const d = tmp();
    fs.writeFileSync(path.join(d, 'processed.json'), '{"a":1}');
    fs.writeFileSync(path.join(d, 'drafts.json'), '{}');
    fs.writeFileSync(path.join(d, 'notes.txt'), 'ignored'); // non-json must be skipped
    return d;
  }

  it('creates a timestamped backup of data JSON only', () => {
    const data = seedData();
    const engine = new BackupEngine(data, tmp(), tmp(), 7);
    const res = engine.createBackup(false, NOW);
    expect(res.ok).toBe(true);
    expect(res.backup!.files).toBe(2); // 2 json, txt skipped
    expect(res.backup!.name).toMatch(/^backup-\d{8}-\d{6}$/);
    expect(fs.existsSync(path.join(res.backup!.path, 'processed.json'))).toBe(true);
    expect(fs.existsSync(path.join(res.backup!.path, 'notes.txt'))).toBe(false);
  });

  it('applies retention, keeping only the newest N', () => {
    const data = seedData();
    const backupDir = tmp();
    const engine = new BackupEngine(data, backupDir, tmp(), 3);
    for (let i = 0; i < 6; i++) engine.createBackup(false, new Date(NOW.getTime() + i * 1000));
    expect(engine.listBackups().length).toBe(6);
    const removed = engine.applyRetention();
    expect(removed.length).toBe(3);
    expect(engine.listBackups().length).toBe(3);
  });
});
