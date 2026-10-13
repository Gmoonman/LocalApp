import { Context } from '@deepseek-ai/cordis';
import * as PiAi from '@deepseek-ai/dsh-llm-pi-ai';
import Llm from '@deepseek-ai/dsh-llm';
import SettingsController from '@deepseek-ai/dsh-api-settings-controller';
import { TYPERT } from '@deepseek-ai/dsh-api-settings-controller/typert';
import TypertRegistry from '@deepseek-ai/dsh-typert-registry';
import Gateway from '@deepseek-ai/dsh-api-gateway';
import * as Remotes from '@deepseek-ai/dsh-api-remotes';
import { UserModelStore } from './storage.cjs';

const reference = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const reserved = new Set(['__proto__', 'constructor', 'prototype']);
/** dsh owns the schema, directory, discovery and wire APIs; this adapter supplies user storage. */
export async function mountUserModels(ctx: Context, user: string, store: UserModelStore) {
  ctx.provide('credentials', {
    resolve: async (ref: string) => { const value = store.read(user).credentials[ref]; return value ? { value } : undefined; },
    describe: async (ref: string) => ({ configured: !!store.read(user).credentials[ref], writable: true, source: 'localapp-user' }),
    set: async (ref: string, value: string) => {
      if (!reference.test(ref) || !value || value.length > 16384) throw new Error('Invalid credential');
      const doc = store.read(user); doc.credentials[ref] = value; store.save(user, doc);
      ctx.emit('credentials/reference-updated', ref as never);
    },
    unset: async (ref: string) => {
      if (!reference.test(ref)) throw new Error('Invalid credential');
      const doc = store.read(user); delete doc.credentials[ref]; store.save(user, doc);
      ctx.emit('credentials/reference-updated', ref as never);
    },
    readRecord: async () => undefined,
    listRecords: async () => [],
  } as never);
  // Never inherit another user's or the Server process's model credentials.
  ctx.provide('launchEnvironment', { get: () => undefined } as never);
  await ctx.plugin(TypertRegistry);
  ctx.typert.register(TYPERT as Parameters<typeof ctx.typert.register>[0]);
  await ctx.plugin(Llm);
  const schema = JSON.parse(JSON.stringify(PiAi.Config.toJSON()));
  let adapter: Awaited<ReturnType<typeof ctx.plugin>> | undefined;
  async function refresh() {
    if (adapter) await adapter.dispose();
    const doc = store.read(user);
    for (const [id, profile] of Object.entries(doc.providers)) profile.apiKeyEnv ??= store.keyRef(id);
    store.save(user, doc);
    adapter = await ctx.plugin(PiAi, { providers: doc.providers });
    const catalog: NonNullable<typeof doc.catalog> = {};
    for (const route of Object.keys(doc.providers)) {
      try { catalog[route] = await ctx.llm.listModels(route); } catch { catalog[route] = []; }
    }
    // A credential write may have completed during catalog resolution.
    const latest = store.read(user); latest.catalog = catalog; store.save(user, latest);
  }
  class UserSettingsController extends SettingsController {
    private queue: Promise<unknown> = Promise.resolve();
    override describe() {
      const doc = store.read(user);
      return { writable: true, hasDocument: false, namespaces: [{ ns: 'llm-pi-ai', schema, autoGenerate: false,
        value: { providers: doc.providers }, base: { providers: {} }, user: { providers: doc.providers },
        applies: 'live' as const, secrets: [], revision: doc.revision }] };
    }
    override mutate(ns: string, ops: any[], revision?: number): ReturnType<SettingsController['mutate']> {
      const result = this.queue.then(async () => {
        if (ns !== 'llm-pi-ai' || !Array.isArray(ops) || ops.length > 100) throw new Error('Invalid model settings operation');
        const doc = store.read(user);
        if (revision !== undefined && revision !== doc.revision) throw new Error('Settings changed; reload before saving');
        const value: any = { providers: structuredClone(doc.providers) };
        for (const op of ops) {
          if (!Array.isArray(op.path) || op.path[0] !== 'providers' || op.path.length > 12 || op.path.some((s: unknown) => typeof s !== 'string' || reserved.has(s))) throw new Error('Invalid settings path');
          let target = value;
          for (const key of op.path.slice(0, -1)) { target[key] ??= {}; target = target[key]; }
          const last = op.path.at(-1);
          if (op.op === 'set') target[last] = structuredClone(op.value);
          else if (op.op === 'unset') { if (Array.isArray(target)) target.splice(Number(last), 1); else delete target[last]; }
          else throw new Error('Invalid settings operation');
        }
        PiAi.Config(value);
        const ids = Object.keys(value.providers);
        if (ids.length > 20 || ids.some(id => !/^[a-zA-Z0-9_-]{1,64}$/.test(id) || reserved.has(id))) throw new Error('Invalid model provider IDs');
        const previous=structuredClone(doc);
        doc.providers = value.providers; doc.revision++;
        store.save(user, doc);
        try { await refresh(); }
        catch (error) { const latest = store.read(user); store.save(user, { ...previous, credentials: latest.credentials }); await refresh(); throw error; }
        const updated=store.read(user),available=store.providers(user);
        if(!available.some(p=>p.id===updated.defaultProviderId)){updated.defaultProviderId=available[0]?.id??'';store.save(user,updated);}
        (ctx.emit as any)('settings/document-updated', ns, doc.revision);
        return this.describe().namespaces[0] as never;
      });
      this.queue = result.catch(() => {});
      return result;
    }
    override replace(ns: string, section: any, revision?: number) {
      return this.mutate(ns, [{ op: 'set', path: ['providers'], value: section.providers }], revision);
    }
  }
  await ctx.plugin(UserSettingsController);
  await refresh();
  await ctx.plugin(Gateway); await ctx.plugin(Remotes);
  return ctx;
}
