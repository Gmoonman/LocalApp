import fs from 'node:fs/promises';
import path from 'node:path';
import Fastify from 'fastify';
import { expect, it } from 'vitest';
import { createDevelopmentRoutesHost } from '../../routes/development.js';
import { createAgentRoutesHost } from '../../routes/agent.js';
import { initMetaDb, closeMetaDb } from '../meta-sqlite.js';
import { loadConfig } from '../config.js';
import type { DeepSeekHarness } from '../deepseek-harness.mjs';

it.each(['development', 'application'])('admits only the configured public host through the real %s native transport', async kind => {
  const parent = path.resolve(import.meta.dirname, '../../../../../tmp/native-public-host');
  await fs.mkdir(parent, { recursive: true });
  const directory = await fs.mkdtemp(path.join(parent, 'case-'));
  await initMetaDb(directory);
  const app = Fastify();
  app.decorate('config', await loadConfig({ DATA_DIR: directory, PUBLIC_URL: 'https://apps.example:60004' }));
  const settings = { createStore: () => ({}), registerRoutes() {} };
  let harness: DeepSeekHarness | undefined;
  try {
    const host = kind === 'development'
      ? await createDevelopmentRoutesHost(app, {} as never, settings as never)
      : await createAgentRoutesHost(app, { localappAgentSettings: settings, localappAgentRuntime: {} } as never);
    harness = host.createHarness({ ownerId: 'owner', root: directory, capabilities: [], llmApiKey: '', llmBaseUrl: 'http://127.0.0.1:9', llmModel: 'test-model' });
    const native = await harness.nativeApi();
    app.addHook('onRequest', async (req, reply) => {
      reply.hijack();
      await native.transport.http('owner', req.raw, reply.raw);
    });
    app.post('/api/settings/describe', async () => {});
    const request = (host: string, origin = `https://${host}`) => app.inject({
      method: 'POST', url: '/api/settings/describe', headers: { host, origin },
      payload: { type: 'client-request', rpcId: 'settings', method: 'settings/describe', payload: { args: {} } },
    });
    const response = await request('apps.example:60004');
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().result.ok, response.body).toBe(true);
    expect(response.body).toContain('test-model');
    expect((await request('attacker.example:60004')).statusCode).toBe(403);
    expect((await request('apps.example:60005')).statusCode).toBe(403);
    expect((await request('apps.example:60004', 'https://attacker.example')).statusCode).toBe(403);
  } finally {
    await app.close();
    await harness?.close();
    closeMetaDb();
    await fs.rm(directory, { recursive: true, force: true });
  }
});
