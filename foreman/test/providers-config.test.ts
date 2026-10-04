import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { BackendName, ForemanStatus } from '../src/protocol.js';
import { tempDir, rmrf } from './helpers.js';

let home = '';
afterEach(() => { if (home) rmrf(home); });
function load(args: string[], env: NodeJS.ProcessEnv = {}) {
  home ||= tempDir();
  fs.mkdirSync(home, { recursive: true });
  return loadConfig(['--home', home, ...args], env);
}

describe('provider configuration', () => {
  it('supports the new backends without changing Claude defaults', () => {
    expect(load([]).claude.leadModel).toBe('opus');
    for (const backend of ['codex', 'openai']) {
      const cfg = load(['--backend', backend, '--model', 'my-model']);
      expect(cfg.profile).toBe(backend);
      expect(cfg.notify).toBe(true);
      expect(cfg.signMerges).toBe(true);
      expect(BackendName.parse(backend)).toBe(backend);
      expect(ForemanStatus.parse({ version: '0.1.0', backend, auth: 'ok' }).backend).toBe(backend);
    }
    expect(load(['--backend', 'codex']).codex.leadModel).toBe('');
  });

  it('keeps provider settings separate with flags > env > provider config', () => {
    load([]);
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({
      backend: 'openai', claude: { leadModel: 'opus', workers: ['wren'] },
      openai: { leadModel: 'file-lead', workerModel: 'file-worker', workers: ['kit'], baseUrl: 'http://localhost:1234/v1', apiKeyEnv: 'LOCAL_TOKEN', api: 'responses' },
    }));
    const cfg = load(['--lead-model', 'cli-lead', '--base-url', 'http://localhost:2345/custom/v1/'], { AGENTCRAFT_LEAD_MODEL: 'env-lead', AGENTCRAFT_WORKER_MODEL: 'env-worker', LOCAL_TOKEN: 'test-secret' });
    expect(cfg.openai).toMatchObject({ leadModel: 'cli-lead', workerModel: 'env-worker', workers: ['kit'], baseUrl: 'http://localhost:2345/custom/v1', apiKey: 'test-secret', api: 'responses' });
    expect(cfg.claude.workers).toEqual(['wren']);
  });

  it('accepts local endpoints without a key, and requires an explicit API model', () => {
    expect(load(['--backend', 'openai', '--base-url', 'http://localhost:11434/v1'], { OPENAI_MODEL: 'local-model' }).openai.apiKey).toBeUndefined();
    expect(() => load(['--backend', 'openai'])).toThrow(/require --model/);
    expect(() => load(['--backend', 'openai', '--model', 'm', '--base-url', 'https://key:secret@example.com/v1'])).toThrow(/without credentials/);
    expect(() => load(['--backend', 'openai', '--model', 'm', '--base-url', 'file:///tmp'])).toThrow(/HTTP/);
    expect(() => load(['--backend', 'openai', '--model', 'm', '--max-budget', '1'])).toThrow(/only by Claude/);
    expect(() => load(['--backend', 'codex', '--max-turns', '0'])).toThrow(/positive integer/);
    expect(() => load(['--backend', 'openai', '--model', 'm', '--request-timeout', '-1'])).toThrow(/request-timeout/);
    expect(() => load(['--backend', 'codex', '--effort', 'max'])).toThrow(/Codex effort/);
  });

  it('applies OPENAI_MODEL above file settings and below role-specific environment and CLI flags', () => {
    load([]);
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({
      backend: 'openai', openai: { leadModel: 'file-lead', workerModel: 'file-worker' },
    }));
    expect(load([], { OPENAI_MODEL: 'env-default' }).openai).toMatchObject({ leadModel: 'env-default', workerModel: 'env-default' });
    expect(load(['--worker-model', 'cli-worker'], { OPENAI_MODEL: 'env-default', AGENTCRAFT_LEAD_MODEL: 'env-lead' }).openai)
      .toMatchObject({ leadModel: 'env-lead', workerModel: 'cli-worker' });
  });

  it('ignores API dialect settings for other backends', () => {
    expect(load(['--backend', 'sim'], { AGENTCRAFT_OPENAI_API: 'unrelated-value' }).backend).toBe('sim');
    expect(() => load(['--backend', 'openai', '--model', 'm'], { AGENTCRAFT_OPENAI_API: 'bad' })).toThrow('unknown API');
  });
});
