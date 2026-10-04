import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, describe, expect, it } from 'vitest';
import { CodexBackend, CodexRuntime, codexArgs, threadConfig, type CodexSpawn } from '../src/agents/codex/index.js';
import { startBridge } from '../src/agents/codex/bridge.js';
import { demoRepo, makeForeman, tempDir, rmrf, until, type Harness } from './helpers.js';
import { turnRequest } from './provider-helpers.js';
import { TeamPermissions } from '../src/permissions.js';
import { buildTeamTools } from '../src/agents/tools.js';

const fixture = fileURLToPath(new URL('./fixtures/fake-codex.mjs', import.meta.url));
const fakeSpawn: CodexSpawn = (_command, args, opts) => spawn(process.execPath, [fixture, ...args], opts);
let h: Harness;
let dir: string;
afterEach(async () => { await h?.fm.close(); if (dir) rmrf(dir); });
function setup() { dir = tempDir(); h = makeForeman(dir, ['--backend', 'codex']); }

describe('Codex app-server integration', () => {
  it('keeps prompts/tokens off argv and disables inherited integrations while retaining our MCP tools', () => {
    setup();
    const r = turnRequest(h, dir, { prompt: 'PRIVATE PROMPT', resume: 'explicit-session' });
    const args = codexArgs();
    expect(args.slice(0, 3)).toEqual(['app-server', '--listen', 'stdio://']);
    const config = threadConfig({ features: { future_native_tool: true, 'name.with.dots': true }, mcp_servers: { personal: { command: 'must-not-run' }, 'name.with.dots': { url: 'http://invalid' } } }, r, 'http://127.0.0.1:9999/mcp');
    expect(config.sandbox_mode).toBe('workspace-write');
    expect(config.mcp_servers).toMatchObject({ personal: { enabled: false }, 'name.with.dots': { enabled: false }, agentcraft: { required: true, enabled: true } });
    expect(threadConfig({}, { ...r, role: 'lead' }, 'http://127.0.0.1:9999/mcp').sandbox_mode).toBe('read-only');
    expect(() => threadConfig({ mcp_servers: { agentcraft: { command: 'collision' } } }, r, 'http://127.0.0.1:9999/mcp')).toThrow(/reserved/);
    expect(args).toContain('features.shell_tool=false');
    expect(args).toContain('features.plugins=false');
    expect(args).toContain('notify=[]');
    expect(args).toContain('agents.enabled=false');
    expect(config['agents.enabled']).toBe(false);
    expect(config.features).toMatchObject({ future_native_tool: false, 'name.with.dots': false });
    expect(args.join(' ')).not.toContain('PRIVATE PROMPT');
    expect(args.join(' ')).not.toContain('127.0.0.1');
    expect(args.join(' ')).not.toContain('dangerously-bypass');
  });

  it('checks CLI readiness, performs real MCP writes, and resumes the same session', async () => {
    setup();
    const runtime = new CodexRuntime(h.cfg.codex, fakeSpawn);
    expect(await runtime.checkAuth()).toMatch(/login|CODEX_API_KEY/);
    const stats = await runtime.run(turnRequest(h, dir));
    expect(stats).toMatchObject({ sessionId: 'test-codex-session', isError: false, resultText: 'Finished via AgentCraft MCP.' });
    expect(fs.readFileSync(path.join(dir, 'from-codex.txt'), 'utf8')).toBe('MCP write\n');
    const resumed = await runtime.run(turnRequest(h, dir, { resume: stats.sessionId, role: 'lead', prompt: '[lead]' }));
    expect(resumed).toMatchObject({ sessionId: 'test-codex-session', isError: false });
  });

  it.each(['[failure]', '[malformed]', '[no-complete]'])('reports %s as a failure', async prompt => {
    setup();
    expect((await new CodexRuntime(h.cfg.codex, fakeSpawn).run(turnRequest(h, dir, { prompt }))).isError).toBe(true);
  });

  it('shows the provider refusal in monitor logs, with credentials redacted', async () => {
    setup();
    const stats = await new CodexRuntime(h.cfg.codex, fakeSpawn).run(turnRequest(h, dir, { prompt: '[policy-failure]', env: { ...process.env, CODEX_API_KEY: 'test-private-key' } }));
    expect(stats.isError).toBe(true);
    const log = h.fm.store.logTail('kit').map(e => e.text).join('\n');
    expect(log).toContain('flagged for possible cybersecurity risk');
    expect(log).not.toContain('test-private-key');
    expect(log).toContain('[redacted]');
  });

  it('enforces the tool-call limit before the next side effect', async () => {
    setup();
    const stats = await new CodexRuntime(h.cfg.codex, fakeSpawn).run(turnRequest(h, dir, { prompt: '[limit]', maxTurns: 1 }));
    expect(stats).toMatchObject({ isError: true, subtype: 'error_max_turns' });
    expect(fs.existsSync(path.join(dir, 'from-codex.txt'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'over-limit.txt'))).toBe(false);
  });

  it('redacts configured provider credentials split across streamed text flushes', async () => {
    setup();
    const key = 'test-secret-split-across-deltas';
    const r = turnRequest(h, dir, { prompt: '[split-secret]', env: { ...process.env, AGENTCRAFT_TEST_PROVIDER_KEY: key } });
    const stats = await new CodexRuntime(h.cfg.codex, fakeSpawn).run(r);
    expect(stats).toMatchObject({ isError: false, resultText: 'Credential: [redacted] hidden.' });
    const log = h.fm.store.logTail('kit').map(e => e.text).join('');
    expect(log).toContain('[redacted]');
    expect(log).not.toContain(key.slice(0, Math.floor(key.length / 2)));
    expect(log).not.toContain(key.slice(Math.floor(key.length / 2)));
  });

  it('terminates the child and bridge on cancellation', async () => {
    setup();
    let started = false;
    const r = turnRequest(h, dir, { prompt: '[hang]', onSession: () => { started = true; } });
    const run = new CodexRuntime(h.cfg.codex, fakeSpawn).run(r);
    await until(() => started);
    r.abortController.abort();
    expect((await run).isError).toBe(true);
    expect(fs.existsSync(path.join(dir, 'from-codex.txt'))).toBe(false);
  });

  it('streams progress before completion and delivers new instructions to the active turn', async () => {
    setup();
    let steer: ((text: string) => Promise<boolean>) | undefined;
    const trace = path.join(dir, 'rpc.jsonl');
    const r = turnRequest(h, dir, { prompt: '[steer]', onSteerReady: ready => { steer = ready; }, env: { ...process.env, AGENTCRAFT_TEST_TRACE: trace } });
    const run = new CodexRuntime(h.cfg.codex, fakeSpawn).run(r);
    await until(() => h.fm.store.logTail('kit').some(e => e.text.includes('Working on the original task.')));
    expect(await steer!('Focus on the failing test.')).toBe(true);
    expect(await run).toMatchObject({ isError: false, resultText: 'Accepted new instructions.' });
    const requests = fs.readFileSync(trace, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(requests.find(request => request.method === 'turn/steer').params).toMatchObject({
      threadId: 'test-codex-session', expectedTurnId: 'test-turn', input: [{ text: 'Focus on the failing test.' }],
    });
    expect(await steer!('Too late')).toBe(false);
  });

  it('requests interruption of the current turn and ignores late steering', async () => {
    setup();
    let steer: ((text: string) => Promise<boolean>) | undefined;
    const trace = path.join(dir, 'rpc.jsonl');
    const r = turnRequest(h, dir, { prompt: '[hang]', onSteerReady: ready => { steer = ready; }, env: { ...process.env, AGENTCRAFT_TEST_TRACE: trace } });
    const run = new CodexRuntime(h.cfg.codex, fakeSpawn).run(r);
    await until(() => !!steer);
    r.abortController.abort();
    expect(await run).toMatchObject({ isError: true, subtype: 'interrupted' });
    expect(await steer!('Must not run')).toBe(false);
    const requests = fs.readFileSync(trace, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(requests.some(request => request.method === 'turn/interrupt' && request.params.turnId === 'test-turn')).toBe(true);
  });

  it('retains queued steering until consumption, and returns it on interruption', async () => {
    setup();
    let steer: ((text: string) => Promise<boolean>) | undefined;
    const trace = path.join(dir, 'queued.jsonl');
    const r = turnRequest(h, dir, { prompt: '[queued-steer]', onSteerReady: ready => { steer = ready; }, env: { ...process.env, AGENTCRAFT_TEST_TRACE: trace } });
    const run = new CodexRuntime(h.cfg.codex, fakeSpawn).run(r);
    await until(() => !!steer);
    let delivered = false;
    const delivery = steer!('Keep this instruction').then(value => { delivered = true; return value; });
    await until(() => fs.readFileSync(trace, 'utf8').includes('turn/steer'));
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(delivered).toBe(false);
    r.abortController.abort();
    expect(await run).toMatchObject({ isError: true, subtype: 'interrupted' });
    expect(await delivery).toBe(false);
  });

  it.each(['[consumed-steer-hang]', '[late-steer-ack]'])('confirms consumed steering without relying on an RPC acknowledgment: %s', async prompt => {
    setup();
    let steer: ((text: string) => Promise<boolean>) | undefined;
    const r = turnRequest(h, dir, { prompt, onSteerReady: ready => { steer = ready; } });
    const run = new CodexRuntime(h.cfg.codex, fakeSpawn).run(r);
    await until(() => !!steer);
    expect(await steer!('Consume once')).toBe(true);
    if (prompt === '[consumed-steer-hang]') r.abortController.abort();
    await run;
  });

  it.each(['[fail-after-steer]', '[complete-after-steer]'])('returns unconsumed steering when the turn ends: %s', async ending => {
    setup();
    let steer: ((text: string) => Promise<boolean>) | undefined;
    const r = turnRequest(h, dir, { prompt: `[queued-steer] ${ending}`, onSteerReady: ready => { steer = ready; } });
    const run = new CodexRuntime(h.cfg.codex, fakeSpawn).run(r);
    await until(() => !!steer);
    expect(await steer!('Must remain deliverable')).toBe(false);
    await run;
  });

  it('classifies authentication only from explicit provider failures', async () => {
    setup();
    const runtime = new CodexRuntime(h.cfg.codex, fakeSpawn);
    expect((await runtime.run(turnRequest(h, dir, { prompt: '[false-auth]' }))).authFailed).toBeUndefined();
    expect((await runtime.run(turnRequest(h, dir, { prompt: '[auth-failure]' }))).authFailed).toBeDefined();
    const recovered = await runtime.run(turnRequest(h, dir, { prompt: '[recovered-auth-error]' }));
    expect(recovered).toMatchObject({ isError: false, errors: [] });
    expect(recovered.authFailed).toBeUndefined();
  });

  it('reports startup stderr with provider credentials redacted', async () => {
    setup();
    const env = { ...process.env, CODEX_API_KEY: 'private-startup-key', AGENTCRAFT_TEST_STARTUP_ERROR: 'bad option private-startup-key' };
    const stats = await new CodexRuntime(h.cfg.codex, fakeSpawn).run(turnRequest(h, dir, { env }));
    expect(stats.isError).toBe(true);
    expect(stats.errors.join('\n')).toContain('startup configuration rejected: bad option [redacted]');
    expect(stats.errors.join('\n')).not.toContain('private-startup-key');
  });

  it('rejects a CLI without app-server support during readiness checks', async () => {
    setup();
    const legacySpawn: CodexSpawn = (_command, args, opts) => spawn(process.execPath, ['-e', `process.exit(${args.includes('app-server') ? 1 : 0})`], opts);
    await expect(new CodexRuntime(h.cfg.codex, legacySpawn).checkAuth()).rejects.toThrow('does not support app-server');
  });

  it('keeps provider keys in the CLI but out of bridge shell commands', async () => {
    setup();
    const r = turnRequest(h, dir, { prompt: '[env]', canUseTool: async (_name, input) => ({ behavior: 'allow', updatedInput: input }) });
    r.env = { ...r.env, CODEX_API_KEY: 'test-codex-key', OPENAI_API_KEY: 'test-openai-key', AGENTCRAFT_TEST_PROVIDER_KEY: 'custom-provider-key' };
    expect((await new CodexRuntime(h.cfg.codex, fakeSpawn).run(r)).isError).toBe(false);
  });

  it('drains in-flight bridge handlers before closing the turn', async () => {
    setup();
    const r = turnRequest(h, dir);
    let started = false;
    let finished = false;
    r.tools = [{ name: 'slow', description: 'test cleanup', inputSchema: {}, handler: async () => {
      started = true;
      await new Promise<void>(resolve => r.abortController.signal.addEventListener('abort', () => { setTimeout(resolve, 100); }, { once: true }));
      finished = true;
      return { content: [{ type: 'text', text: 'done' }] };
    } }];
    const bridge = await startBridge(r, () => undefined);
    const client = new Client({ name: 'test', version: '1.0' });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(bridge.url), { requestInit: { headers: { Authorization: `Bearer ${bridge.token}` } } }));
      const call = client.callTool({ name: 'slow', arguments: {} }).catch(() => undefined);
      await until(() => started);
      await bridge.close();
      expect(finished).toBe(true);
      await call;
    } finally { await client.close(); }
  });

  it.each(['permission', 'question'] as const)('cancels a pending MCP %s request without blocking later tools or ending the turn', async kind => {
    setup();
    fs.writeFileSync(path.join(dir, 'readable.txt'), 'the queue is clear');
    const r = turnRequest(h, dir);
    const turn = { signal: r.abortController.signal, reason: () => undefined };
    r.canUseTool = new TeamPermissions(h.fm, []).canUseTool('kit', 'worker', dir, 'demo', turn);
    let waiting = false;
    r.tools = buildTeamTools(h.fm, 'kit', 'worker', {
      onReview() {}, onChangesRequested() {}, onTasksChanged() {}, onMergeRequested() {},
      onWaiting(_id, value) { waiting = value; },
    }, turn);
    const bridge = await startBridge(r, () => undefined);
    const client = new Client({ name: 'test', version: '1.0' });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(bridge.url), { requestInit: { headers: { Authorization: `Bearer ${bridge.token}` } } }));
      const request = new AbortController();
      const pending = client.callTool(kind === 'permission'
        ? { name: 'Bash', arguments: { command: 'npm install should-not-run' } }
        : { name: 'ask_user', arguments: { question: 'Continue?' } }, undefined, { signal: request.signal }).catch(() => undefined);
      await until(() => h.fm.decisions.open().some(d => d.kind === kind));
      const decision = h.fm.decisions.open().find(d => d.kind === kind)!;
      request.abort();
      await pending;
      const next = await client.callTool({ name: 'Read', arguments: { file_path: 'readable.txt' } }, undefined, { timeout: 1500 });
      expect(next.content).toEqual([{ type: 'text', text: '1\tthe queue is clear' }]);
      expect(h.fm.decisions.get(decision.id)!.status).toBe('cancelled');
      expect(h.fm.decisions.hasWaiters(decision.id)).toBe(false);
      expect(waiting).toBe(false);
      expect(h.fm.agent('kit')!.state).not.toBe('waiting_user');
      expect(r.abortController.signal.aborted).toBe(false);
      expect(fs.existsSync(path.join(dir, 'node_modules'))).toBe(false);
    } finally { await bridge.close(); await client.close(); }
  });

  it('cancels one running MCP shell and drains it before the next tool without aborting the turn', async () => {
    setup();
    const r = turnRequest(h, dir, { canUseTool: async (_name, input) => ({ behavior: 'allow', updatedInput: input }) });
    const bridge = await startBridge(r, () => undefined);
    const client = new Client({ name: 'test', version: '1.0' });
    let pid: number | undefined;
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(bridge.url), { requestInit: { headers: { Authorization: `Bearer ${bridge.token}` } } }));
      const request = new AbortController();
      const pending = client.callTool({ name: 'Bash', arguments: {
        command: `node -e "require('fs').writeFileSync('request-pid.txt',String(process.pid));setTimeout(()=>require('fs').writeFileSync('late-write.txt','should not run'),10000)"`,
      } }, undefined, { signal: request.signal }).catch(() => undefined);
      await until(() => fs.existsSync(path.join(dir, 'request-pid.txt')));
      pid = Number(fs.readFileSync(path.join(dir, 'request-pid.txt'), 'utf8'));
      request.abort();
      await pending;
      const next = await client.callTool({ name: 'Read', arguments: { file_path: 'request-pid.txt' } }, undefined, { timeout: 3000 });
      expect(next.isError).not.toBe(true);
      expect(() => process.kill(pid!, 0)).toThrow();
      expect(r.abortController.signal.aborted).toBe(false);
      expect(fs.existsSync(path.join(dir, 'late-write.txt'))).toBe(false);
    } finally {
      await bridge.close(); await client.close();
      if (pid) { try { process.kill(pid, 'SIGKILL'); } catch { /* already stopped */ } }
    }
  });

  it('waits for a running bridge shell to exit when Codex is cancelled', async () => {
    setup();
    const r = turnRequest(h, dir, { prompt: '[hang-tool]', canUseTool: async (_name, input) => ({ behavior: 'allow', updatedInput: input }) });
    const run = new CodexRuntime(h.cfg.codex, fakeSpawn).run(r);
    const marker = path.join(dir, 'shell-pid.txt');
    await until(() => fs.existsSync(marker));
    const pid = Number(fs.readFileSync(marker, 'utf8'));
    r.abortController.abort();
    await run;
    expect(() => process.kill(pid, 0)).toThrow();
  });

  it('shuts down a pending question promptly, persists it, and resumes on its answer after restart', async () => {
    setup();
    const repo = await demoRepo();
    try {
      await h.fm.repos.add(repo);
      await h.fm.start(new CodexBackend(h.fm, h.cfg.codex, fakeSpawn));
      await h.fm.submitGoal('[ask] Decide the next step.');
      await until(() => h.fm.decisions.open().some(d => d.kind === 'question'));
      const question = h.fm.decisions.open()[0]!;
      const start = Date.now();
      await h.fm.close();
      expect(Date.now() - start).toBeLessThan(3000);
      expect(h.fm.decisions.hasWaiters(question.id)).toBe(false);
      expect(h.fm.decisions.get(question.id)!.status).toBe('open');
      h = makeForeman(dir, ['--backend', 'codex']);
      const trace = path.join(dir, 'resume.jsonl');
      await h.fm.start(new CodexBackend(h.fm, h.cfg.codex, (cmd, args, options) => fakeSpawn(cmd, args, { ...options, env: { ...options.env, AGENTCRAFT_TEST_TRACE: trace } })));
      expect(h.fm.decisions.get(question.id)!.status).toBe('open');
      await h.fm.answerDecision(question.id, 'Yes');
      await until(() => fs.existsSync(trace) && fs.readFileSync(trace, 'utf8').includes('thread/resume'));
      const resumed = fs.readFileSync(trace, 'utf8').trim().split('\n').map(line => JSON.parse(line)).find(request => request.method === 'thread/resume');
      expect(resumed.params.threadId).toBe('test-codex-session');
    } finally { await h.fm.close(); rmrf(path.dirname(repo)); }
  });

  it('ends a cancelled Codex turn despite a reparented process holding a bridge tool pipe', async () => {
    setup();
    fs.writeFileSync(path.join(dir, 'detach.cjs'), `const fs = require('fs'); const p = require('child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], {detached: true, stdio: ['ignore', 'inherit', 'inherit']}); fs.writeFileSync('daemon-pid.txt', String(p.pid)); p.unref();`);
    const r = turnRequest(h, dir, { prompt: '[hang-escaped-tool]', canUseTool: async (_name, input) => ({ behavior: 'allow', updatedInput: input }) });
    const run = new CodexRuntime(h.cfg.codex, fakeSpawn).run(r);
    const marker = path.join(dir, 'daemon-pid.txt');
    await until(() => fs.existsSync(marker));
    const pid = Number(fs.readFileSync(marker, 'utf8'));
    try {
      const start = Date.now();
      r.abortController.abort();
      await run;
      expect(Date.now() - start).toBeLessThan(process.platform === 'win32' ? 10_000 : 3000);
    } finally { try { process.kill(pid, 'SIGKILL'); } catch { /* already reaped */ } }
  });

  it('protects the per-turn MCP bridge from unauthenticated and browser requests', async () => {
    setup();
    const r = turnRequest(h, dir, { role: 'lead' });
    const bridge = await startBridge(r, () => undefined);
    const client = new Client({ name: 'test', version: '1.0' });
    try {
      expect((await fetch(bridge.url, { method: 'POST' })).status).toBe(403);
      expect((await fetch(bridge.url, { method: 'POST', headers: { Authorization: `Bearer ${bridge.token}`, Origin: 'https://example.com' } })).status).toBe(403);
      await client.connect(new StreamableHTTPClientTransport(new URL(bridge.url), { requestInit: { headers: { Authorization: `Bearer ${bridge.token}` } } }));
      const { tools } = await client.listTools();
      expect(tools.map(t => t.name)).toEqual(['Read', 'Glob', 'Grep']);
    } finally { await client.close(); await bridge.close(); }
    await expect(fetch(bridge.url)).rejects.toThrow();
  });
});
