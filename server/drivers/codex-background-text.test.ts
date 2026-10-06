import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, watch } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CodexDriver } from './codex.ts';
import type { ProviderInstance } from '../contracts.ts';
import { removeTempDir } from '../testing/cleanup.ts';
import { createMemoryUpkeep } from '../memory-upkeep.ts';
import { workspaceDir } from '../workspace.ts';
import { flushMemoryJournal } from '../memory-journal.ts';

const cli = fileURLToPath(new URL('../testing/fake-codex-app-server.ts', import.meta.url));

describe('Codex background text generation (isolated app-server)', () => {
  let scratch: string;
  let instance: ProviderInstance | undefined;
  let dump: string;
  beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), 'omb-codex-background-'));
    dump = join(scratch, 'calls.json');
    mkdirSync(join(scratch, '.codex'));
    chmodSync(cli, 0o755);
  });
  afterEach(async () => { await instance?.dispose(); instance = undefined; await removeTempDir(scratch); });
  const create = async (mode = 'background-text', environment: Record<string, string> = {}) => {
    instance = await CodexDriver.create({
      instanceId: 'background-fixture', displayName: 'Fixture', enabled: true,
      config: { cli, fullAuto: false },
      environment: { HOME: scratch, USERPROFILE: scratch, CODEX_HOME: join(scratch, '.codex'),
        FAKE_CODEX_MODE: mode, FAKE_CODEX_DUMP: dump, ...environment },
    });
    return instance;
  };
  const waitForTurn = () => new Promise<void>((resolve, reject) => {
    const check = () => {
      if (!existsSync(dump)) return;
      try {
        if (JSON.parse(readFileSync(dump, 'utf8')).calls.some((call: {method: string}) => call.method === 'turn/start')) {
          watcher.close(); clearTimeout(timer); resolve();
        }
      } catch { /* Atomic replacement may briefly be unavailable on Windows. */ }
    };
    const watcher = watch(dirname(dump), check);
    const timer = setTimeout(() => { watcher.close(); reject(new Error('Fixture turn did not start')); }, 10000);
    check();
  });

  it('extracts text without publishing helper events and books actual usage', async () => {
    const engine = await create();
    const listener = vi.fn(); engine.adapter.onEvent(listener);
    const onUsage = vi.fn();
    expect(await engine.generateText!('Extract a preference', {onUsage})).toBe('background result');
    expect(listener).not.toHaveBeenCalled();
    expect(onUsage).toHaveBeenCalledExactlyOnceWith({ model: 'gpt-fake-default', input: 7, output: 3, cachedInput: 2 });
    const seen = JSON.parse(readFileSync(dump, 'utf8'));
    const start = seen.calls.find((call: {method: string}) => call.method === 'thread/start');
    expect(start.params).toMatchObject({ ephemeral: true, sandbox: 'read-only', approvalPolicy: 'never', modelProvider: 'openai' });
    expect(start.params.config['mcp_servers."harmless_name".enabled']).toBe(false);
    expect(seen.argv).toContain('features.shell_tool=false');
    expect(seen.argv.join(' ')).not.toContain('Extract a preference');
    expect(engine.reviewPermission).toBeUndefined();
  });
  it.each(['background-text-tool', 'background-text-approval'])('rejects tool/approval requests in %s', async mode => {
    const engine = await create(mode);
    await expect(engine.generateText!('Only text')).rejects.toThrow(/non-text action|tool or approval/);
  });
  it('fails closed when the requested sandbox was not applied', async () => {
    const engine = await create('background-text', {FAKE_CODEX_RESOLVED_SANDBOX: '{"type":"dangerFullAccess"}'});
    await expect(engine.generateText!('Do not run')).rejects.toThrow(/read-only sandbox/);
    const seen = JSON.parse(readFileSync(dump, 'utf8'));
    expect(seen.calls.some((call: {method: string}) => call.method === 'turn/start')).toBe(false);
  });
  it('honors cancellation before launching', async () => {
    const engine = await create();
    const controller = new AbortController(); controller.abort();
    await expect(engine.generateText!('Do not run', {signal: controller.signal})).rejects.toThrow(/aborted/);
  });
  it('captures a preference into memory and About me through the real upkeep pipeline', async () => {
    const engine = await create('background-text', {FAKE_CODEX_TEXT_REPLY: JSON.stringify([
      {text: 'The person prefers tea.', kind: 'preference', aboutUser: true, confidence: 0.95},
    ])});
    const bot = {id: 'codex-memory-fixture', name: 'Fixture'};
    const aboutMe: string[] = [];
    const upkeep = createMemoryUpkeep({
      bots: () => [bot], bot: () => bot, engine: () => engine, busy: () => false,
      addToAboutMe: (_from, facts) => {aboutMe.push(...facts); return facts.length;},
      sourceLabel: () => 'chat "Fixture"', quietMs: () => 60000, tidyHour: () => 3,
    });
    try {
      expect(upkeep.status(bot.id).modelSteps).toBe(true);
      const report = await upkeep.capture({botId: bot.id, threadId: 'fixture-chat', turns: [{person: 'I prefer tea.', bot: 'Understood.'}]});
      expect(report).toMatchObject({added: 1, aboutMe: 1});
      expect(readFileSync(join(workspaceDir(bot.id), 'MEMORY.md'), 'utf8')).toContain('The person prefers tea.');
      expect(aboutMe).toEqual(['The person prefers tea.']);
    } finally { upkeep.stop(); await upkeep.idle(); await flushMemoryJournal(bot.id); }
  });
  it.each(['abort', 'dispose'] as const)('terminates a pending helper on %s', async action => {
    const engine = await create('background-text-hang');
    const controller = new AbortController();
    const started = waitForTurn();
    const result = engine.generateText!('Wait', {signal: controller.signal});
    const rejected = expect(result).rejects.toThrow(/aborted/);
    await started;
    if (action === 'abort') controller.abort(); else await engine.dispose();
    await rejected;
  });
});
