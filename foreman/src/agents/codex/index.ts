import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import spawn from 'cross-spawn';
import { FOREMAN_VERSION, type CodexConfig } from '../../config.js';
import type { Foreman } from '../../foreman.js';
import { killTree } from '../../util/proc.js';
import { TeamBackend } from '../team.js';
import type { AgentRuntime, TurnRequest, TurnStats } from '../runtime.js';
import { isAuthenticationMessage } from '../runtime.js';
import { ToolExecutor } from '../coding-tools.js';
import { startBridge } from './bridge.js';
import { AppServerTransport, object, type RpcObject } from './transport.js';

export type CodexSpawn = (command: string, args: string[], options: SpawnOptions) => ChildProcess;
const defaultSpawn: CodexSpawn = (command, args, options) => spawn(command, args, options);
const disabledFeatures = [
  'shell_tool', 'unified_exec', 'multi_agent', 'multi_agent_v2', 'apps', 'plugins', 'hooks',
  'view_image', 'goals', 'browser_use', 'browser_use_external', 'computer_use', 'image_generation',
  'shell_snapshot', 'shell_zsh_fork', 'default_mode_request_user_input', 'request_permissions_tool',
  'skill_mcp_dependency_install', 'workspace_dependencies', 'code_mode',
  'current_time_reminder', 'send_message_to_user_async', 'token_budget', 'standalone_web_search',
  'deferred_executor', 'sleep_tool',
];

function baseConfig(): RpcObject {
  return {
    approval_policy: 'never', approvals_reviewer: 'user', web_search: 'disabled', notify: [],
    // Feature flags alone do not override a resumed thread's saved multi-agent version.
    'agents.enabled': false,
    ...Object.fromEntries(disabledFeatures.map(feature => [`features.${feature}`, false])),
  };
}

export function codexArgs(): string[] {
  // Prompts, MCP URLs, and credentials travel over stdin/environment, never argv.
  return ['app-server', '--listen', 'stdio://', ...Object.entries(baseConfig()).flatMap(([key, value]) => ['-c', `${key}=${JSON.stringify(value)}`])];
}

/** Resolve inherited MCP entries before starting a thread. TOML tables merge; {} does not clear them. */
export function threadConfig(config: RpcObject, r: TurnRequest, url: string): RpcObject {
  if (config.mcp_servers != null && !object(config.mcp_servers)) throw new Error('Codex returned invalid MCP configuration');
  if (config.features != null && !object(config.features)) throw new Error('Codex returned invalid feature configuration');
  const servers = config.mcp_servers ?? {};
  if (object(servers) && 'agentcraft' in servers) {
    throw new Error('The Codex MCP server name "agentcraft" is reserved for Foreman. Rename that entry in your Codex configuration.');
  }
  const disabled = Object.fromEntries(Object.keys(servers).map(name => [name, { enabled: false }]));
  return {
    ...baseConfig(),
    // No personal feature flags are opted into AgentCraft threads. A nested table preserves
    // literal feature names containing dots; an empty table alone would merge inherited flags.
    features: Object.fromEntries([...Object.keys(config.features ?? {}), ...disabledFeatures].map(name => [name, false])),
    sandbox_mode: r.role === 'lead' ? 'read-only' : 'workspace-write',
    'sandbox_workspace_write.writable_roots': [path.resolve(r.cwd)],
    'sandbox_workspace_write.network_access': false,
    'sandbox_workspace_write.exclude_tmpdir_env_var': true,
    'sandbox_workspace_write.exclude_slash_tmp': true,
    model_reasoning_effort: r.effort,
    // CODEX_API_KEY is an exec-mode convenience. Use an env-backed provider in app-server
    // without logging in or writing the key to the user's authentication/config files.
    ...(r.env.CODEX_API_KEY ? {
      model_provider: 'agentcraft_api_key',
      'model_providers.agentcraft_api_key': { name: 'OpenAI', base_url: 'https://api.openai.com/v1', wire_api: 'responses', env_key: 'CODEX_API_KEY' },
    } : {}),
    mcp_servers: {
      ...disabled,
      agentcraft: {
        url, bearer_token_env_var: 'AGENTCRAFT_MCP_TOKEN', enabled: true, required: true, tool_timeout_sec: 2700,
        tools: Object.fromEntries(new ToolExecutor(r).tools.map(tool => [tool.name, { approval_mode: 'approve' }])),
      },
    },
  };
}

function sandboxPolicy(r: TurnRequest): RpcObject {
  return r.role === 'lead' ? { type: 'readOnly', networkAccess: false }
    : { type: 'workspaceWrite', writableRoots: [path.resolve(r.cwd)], networkAccess: false, excludeTmpdirEnvVar: true, excludeSlashTmp: true };
}

function verifyThread(result: RpcObject, r: TurnRequest): string {
  const sandbox = result.sandbox;
  if (result.approvalPolicy !== 'never' || !object(sandbox) || sandbox.networkAccess !== false
    || sandbox.type !== (r.role === 'lead' ? 'readOnly' : 'workspaceWrite')) throw new Error('Codex did not confirm the requested sandbox and approval policy');
  if (r.role === 'worker' && (!Array.isArray(sandbox.writableRoots)
    || sandbox.writableRoots.some(root => typeof root !== 'string' || path.resolve(root) !== path.resolve(r.cwd))
    || sandbox.excludeTmpdirEnvVar !== true || sandbox.excludeSlashTmp !== true)) throw new Error('Codex returned broader workspace access than requested');
  if (typeof result.cwd !== 'string' || path.resolve(result.cwd) !== path.resolve(r.cwd)) throw new Error('Codex returned a different working directory');
  if (!object(result.thread) || typeof result.thread.id !== 'string' || !result.thread.id) throw new Error('Codex returned no thread ID');
  if (r.resume && r.resume !== result.thread.id) throw new Error('Codex resumed a different thread');
  return result.thread.id;
}

async function probe(command: string, args: string[], spawnFn: CodexSpawn): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawnFn(command, args, { stdio: 'ignore', windowsHide: true });
    const timer = setTimeout(() => { killTree(child); reject(new Error('Codex CLI check timed out')); }, 10_000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => { clearTimeout(timer); resolve(code ?? 1); });
  });
}

async function waitForExit(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>(resolve => {
    const done = () => { clearTimeout(timer); child.removeListener('exit', done); resolve(); };
    const timer = setTimeout(done, timeoutMs);
    child.once('exit', done);
  });
}

export class CodexRuntime implements AgentRuntime {
  readonly name = 'codex' as const;
  readonly label = 'Codex';
  constructor(private cfg: CodexConfig, private spawnFn: CodexSpawn = defaultSpawn) {}

  async checkAuth(): Promise<string> {
    try {
      if (await probe(this.cfg.command, ['--version'], this.spawnFn) !== 0) throw new Error('version check failed');
    } catch (e) {
      throw new Error(`Codex CLI unavailable: ${(e as Error).message}. Install @openai/codex or set --codex-command.`);
    }
    if (await probe(this.cfg.command, ['app-server', '--help'], this.spawnFn) !== 0) {
      throw new Error('Codex CLI does not support app-server. Update Codex or set --codex-command to a compatible CLI.');
    }
    if (process.env.CODEX_API_KEY) return 'CODEX_API_KEY';
    if (await probe(this.cfg.command, ['login', 'status'], this.spawnFn) !== 0) throw new Error('Codex is not logged in. Run `codex login`, or set CODEX_API_KEY, then restart the Foreman.');
    return 'Codex CLI login';
  }

  async run(r: TurnRequest): Promise<TurnStats> {
    const signal = r.abortController.signal;
    signal.throwIfAborted();
    let child: ChildProcess | undefined;
    let rpc: AppServerTransport | undefined;
    let threadId = '', turnId = '';
    let terminal = false, limitReached = false;
    const toolEnv = { ...r.env };
    delete toolEnv.CODEX_API_KEY;
    delete toolEnv.OPENAI_API_KEY;
    delete toolEnv.AGENTCRAFT_MCP_TOKEN;
    const bridge = await startBridge({ ...r, env: toolEnv }, () => { limitReached = true; r.abortController.abort(); });
    const credentials = [bridge.token, ...Object.entries(r.env)
      .filter(([name]) => /(?:^|_)(?:KEY|TOKEN|SECRET|PASSWORD)$/.test(name)).map(([, value]) => value)]
      .filter((key): key is string => !!key);
    const redact = (text: string) => credentials.reduce((out, key) => out.replaceAll(key, '[redacted]'), text);
    let complete!: (turn: RpcObject) => void;
    const completed = new Promise<RpcObject>(resolve => { complete = resolve; });
    let stop!: () => void;
    const stopped = new Promise<undefined>(resolve => { stop = () => resolve(undefined); });
    const onAbort = () => {
      if (threadId && turnId && !terminal) void rpc?.request('turn/interrupt', { threadId, turnId }, 1000).catch(() => {});
      stop();
    };
    const request = async (method: string, params: RpcObject): Promise<RpcObject> => {
      signal.throwIfAborted();
      const result = await Promise.race([rpc!.request(method, params), stopped]);
      if (!result) throw new Error('Codex turn was stopped');
      return result;
    };
    let resultText = '';
    let providerError: string | undefined;
    let stderr = '';
    const deliveries = new Map<string, (consumed: boolean) => void>();
    const settleDelivery = (id: string, consumed: boolean) => {
      deliveries.get(id)?.(consumed);
      deliveries.delete(id);
    };
    const messages = new Map<string, { pending: string; received: number }>();
    const flushText = (final = false) => {
      for (const message of messages.values()) {
        message.pending = redact(message.pending);
        // A credential can straddle streamed deltas. Retain a matching suffix until the
        // following delta arrives, rather than exposing its pieces in separate log entries.
        let keep = 0;
        if (!final) for (const key of credentials) {
          for (let n = 1; n < key.length && n <= message.pending.length; n++) {
            if (message.pending.endsWith(key.slice(0, n))) keep = Math.max(keep, n);
          }
        }
        const end = message.pending.length - keep;
        const text = message.pending.slice(0, end);
        if (text.trim()) r.reporter.text(text);
        message.pending = message.pending.slice(end);
      }
    };
    let flushTimer: NodeJS.Timeout | undefined;
    const queueText = (id: string, delta: string) => {
      const message = messages.get(id) ?? { pending: '', received: 0 };
      message.received += delta.length;
      message.pending += delta;
      messages.set(id, message);
      if (message.pending.length >= 1000) flushText();
      else if (!flushTimer) flushTimer = setTimeout(() => { flushTimer = undefined; flushText(); }, 500);
    };
    try {
      signal.throwIfAborted();
      child = this.spawnFn(this.cfg.command, codexArgs(), {
        cwd: r.cwd, env: { ...r.env, AGENTCRAFT_MCP_TOKEN: bridge.token },
        stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32',
      });
      rpc = new AppServerTransport(child);
      child.stderr?.setEncoding('utf8');
      child.stderr?.on('data', (chunk: string) => {
        stderr += chunk;
        if (stderr.length > 16_384) {
          // Drop a whole leading line, so truncation never leaves an unredactable key suffix.
          const newline = stderr.indexOf('\n', stderr.length - 16_384);
          stderr = newline === -1 ? '' : stderr.slice(newline + 1);
        }
      });
      r.onSpawn(child);
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) onAbort();
      rpc.onRequest = method => {
        // All coding and questions go through our MCP policy, never native approval escalation.
        if (method === 'item/commandExecution/requestApproval' || method === 'item/fileChange/requestApproval') return { decision: 'decline' };
        if (method === 'item/permissions/requestApproval') return { permissions: {}, scope: 'turn' };
        if (method === 'mcpServer/elicitation/request') return { action: 'decline', content: null };
        throw new Error(`Unsupported Codex request: ${method}. Use the AgentCraft MCP tools.`);
      };
      rpc.onNotification = (method, params) => {
        if (!threadId || params.threadId !== threadId) return;
        // A steer acknowledgment only queues input. The completed userMessage is emitted
        // when Codex consumes it, and its stable client ID correlates it with our reservation.
        if (method === 'item/completed' && params.turnId === turnId && object(params.item)
          && params.item.type === 'userMessage' && typeof params.item.clientId === 'string') {
          settleDelivery(params.item.clientId, true);
          return;
        }
        if (terminal) return;
        if (method === 'turn/started' && object(params.turn) && typeof params.turn.id === 'string') {
          if (turnId && turnId !== params.turn.id) throw new Error('Unexpected Codex turn');
          turnId = params.turn.id;
          return;
        }
        if (method === 'turn/completed') {
          if (!object(params.turn) || !turnId || params.turn.id !== turnId) return;
          terminal = true;
          complete(params.turn);
          return;
        }
        if (signal.aborted || !turnId || params.turnId !== turnId) return;
        if (method === 'item/agentMessage/delta' && typeof params.itemId === 'string' && typeof params.delta === 'string') queueText(params.itemId, params.delta);
        else if (method === 'item/completed' && object(params.item) && params.item.type === 'agentMessage' && typeof params.item.text === 'string') {
          const item = params.item;
          const text = item.text as string;
          const previous = typeof item.id === 'string' ? messages.get(item.id) : undefined;
          if (previous) {
            previous.pending += text.slice(previous.received);
            previous.received = text.length;
          } else if (typeof item.id === 'string') messages.set(item.id, { pending: text, received: text.length });
          if (item.phase === 'final_answer' || !item.phase) resultText = text;
          flushText(true);
        } else if (method === 'error' && object(params.error) && typeof params.error.message === 'string' && params.willRetry !== true) providerError = params.error.message;
      };
      await request('initialize', { clientInfo: { name: 'agentcraft_foreman', title: 'AgentCraft Foreman', version: FOREMAN_VERSION }, capabilities: { experimentalApi: false, requestAttestation: false } });
      rpc.notify('initialized');
      const read = await request('config/read', { cwd: r.cwd, includeLayers: false });
      if (!object(read.config)) throw new Error('Codex returned no effective configuration');
      if (object(read.config.model_providers)) for (const provider of Object.values(read.config.model_providers)) {
        if (object(provider) && typeof provider.env_key === 'string') {
          const key = r.env[provider.env_key];
          if (key) credentials.push(key);
          delete toolEnv[provider.env_key];
        }
      }
      const coding = r.role === 'lead' ? 'Read, Glob, Grep' : 'Read, Glob, Grep, Edit, Write, Bash';
      const permissions = r.role === 'lead' ? 'You are read-only; assign changes and dependency setup to workers.'
        : 'Edit files and run commands through AgentCraft Edit, Write and Bash. Attempt missing dependency installs through Bash; AgentCraft asks the user when approval is needed.';
      const instructions = `${r.systemPrompt}\n\nUse the agentcraft MCP tools for ALL repository operations (${coding}) and team coordination. ${permissions} Ask questions only through agentcraft ask_user. Native shell, image, goal, subagent, and web tools are disabled.`;
      const thread = await request(r.resume ? 'thread/resume' : 'thread/start', {
        ...(r.resume ? { threadId: r.resume, excludeTurns: true } : {}), cwd: r.cwd,
        approvalPolicy: 'never', approvalsReviewer: 'user', sandbox: r.role === 'lead' ? 'read-only' : 'workspace-write',
        config: threadConfig(read.config, r, bridge.url), developerInstructions: instructions,
        ...(r.model ? { model: r.model } : {}),
      });
      threadId = verifyThread(thread, r);
      r.reporter.session(threadId);
      r.onSession(threadId);
      const begun = await request('turn/start', {
        threadId, input: [{ type: 'text', text: r.prompt, text_elements: [] }], cwd: r.cwd,
        approvalPolicy: 'never', approvalsReviewer: 'user', sandboxPolicy: sandboxPolicy(r), effort: r.effort,
        ...(r.model ? { model: r.model } : {}),
      });
      if (!object(begun.turn) || typeof begun.turn.id !== 'string' || !begun.turn.id) throw new Error('Codex returned no turn ID');
      if (turnId && begun.turn.id !== turnId) throw new Error('Codex turn ID mismatch');
      turnId = begun.turn.id;
      r.onSteerReady?.(text => {
        if (terminal || signal.aborted) return Promise.resolve(false);
        const clientUserMessageId = randomUUID();
        const delivered = new Promise<boolean>(resolve => { deliveries.set(clientUserMessageId, resolve); });
        void rpc!.request('turn/steer', { threadId, expectedTurnId: turnId, clientUserMessageId,
          input: [{ type: 'text', text, text_elements: [] }] }).then(result => {
          if (result.turnId !== turnId) settleDelivery(clientUserMessageId, false);
        }, () => settleDelivery(clientUserMessageId, false));
        return delivered;
      });
      const outcome = await Promise.race([completed, rpc.closed, stopped]);
      if (outcome instanceof Error) throw outcome;
      if (!outcome) {
        // Give the server a bounded opportunity to acknowledge interruption. Tool access is
        // already revoked by the same signal, including pending permissions and shell work.
        await Promise.race([completed, rpc.closed, new Promise(resolve => setTimeout(resolve, 1000))]);
      } else if (!['completed', 'failed', 'interrupted'].includes(String(outcome.status))) throw new Error('Codex returned an unknown turn status');
      const failure = outcome?.status === 'completed' ? undefined
        : outcome && object(outcome.error) && typeof outcome.error.message === 'string' ? outcome.error.message : providerError;
      const errors = limitReached ? [`Reached the ${r.maxTurns} tool call limit`]
        : failure ? [redact(failure)] : outcome?.status === 'failed' ? ['Codex turn failed'] : [];
      flushText(true);
      return r.reporter.complete({ isError: limitReached || signal.aborted || outcome?.status !== 'completed', errors,
        resultText: redact(resultText), numTurns: 1,
        subtype: limitReached ? 'error_max_turns' : signal.aborted ? 'interrupted' : String(outcome?.status === 'completed' ? 'success' : outcome?.status ?? 'error'),
        ...(!signal.aborted && outcome?.status === 'failed' && failure && isAuthenticationMessage(failure) ? { authFailed: 'Check Codex CLI authentication' } : {}),
      });
    } catch (error) {
      const message = (error as Error).message;
      const diagnostic = !threadId || /^Codex app-server (?:exited|closed)/.test(message) ? redact(stderr).trim().slice(-4000) : '';
      const errors = limitReached ? [`Reached the ${r.maxTurns} tool call limit`] : signal.aborted ? []
        : [redact(message) + (diagnostic ? `\n${diagnostic}` : '')];
      return r.reporter.complete({ isError: true, subtype: limitReached ? 'error_max_turns' : signal.aborted ? 'interrupted' : 'error', errors, numTurns: 1 });
    } finally {
      terminal = true;
      // Unconsumed input must return to the inbox before the scheduler resumes or follows up.
      for (const id of deliveries.keys()) settleDelivery(id, false);
      if (flushTimer) clearTimeout(flushTimer);
      signal.removeEventListener('abort', onAbort);
      r.abortController.abort();
      await bridge.close();
      rpc?.close();
      if (child) {
        await waitForExit(child, 500);
        killTree(child);
        await waitForExit(child, 1000);
        child.stdout?.destroy();
        child.stderr?.destroy();
      }
    }
  }
}

export class CodexBackend extends TeamBackend {
  constructor(fm: Foreman, cfg: CodexConfig, spawnFn?: CodexSpawn) { super(fm, cfg, new CodexRuntime(cfg, spawnFn)); }
}
