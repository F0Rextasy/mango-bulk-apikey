#!/usr/bin/env node
'use strict';

/**
 * Connect Mango to a 9Router instance.
 *
 * Mango ships an OpenAI-compatible endpoint (https://api.mangoboost.io/v1), so a single
 * connection is enough: register one `openai-compatible` provider-node with
 * prefix `mango`, then attach a connection that carries one of your
 * Mango API keys. Rotate keys by calling this again with a different
 * --api-key — the node stays, every key becomes another connection.
 *
 * Usage:
 *   node src/connect-9router.js \
 *     --base http://localhost:20128 --password 123456 \
 *     --api-key mango_xxxxxxxx [--name "Mango"] [--prefix mango]
 *
 * Options:
 *   --base <url>       9Router base URL (default http://localhost:20128)
 *   --password <pw>    9Router admin password (default 123456)
 *   --api-key <key>    Mango API key (or env NINEROUTER_API_KEY)
 *   --name <label>     connection label (default Mango)
 *   --prefix <slug>    9Router model prefix (default mango)
 *   --base-url <url>   upstream base URL (default https://api.mangoboost.io/v1)
 *   --model <id>       default model (default deepseek-ai/DeepSeek-V4-Pro-0813)
 *   --help             this text
 *
 * Zero dependencies. Node.js >= 18.
 */

const UA = 'mango-bulk-apikey-9router-connector/1.0';

const DEFAULTS = {
  base: 'http://localhost:20128',
  password: '123456',
  name: 'Mango',
  prefix: 'mango',
  baseUrl: 'https://api.mangoboost.io/v1',
  defaultModel: 'deepseek-ai/DeepSeek-V4-Pro-0813',
};

async function login9router(base, password) {
  const res = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': UA },
    body: JSON.stringify({ password: password ?? DEFAULTS.password }),
  });
  const sc = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  const cookie = sc.map((c) => c.split(';')[0]).join('; ');
  return { ok: res.ok, cookie, body: (await res.text()).slice(0, 200) };
}

async function api(base, cookie, route, init = {}) {
  const res = await fetch(`${base}${route}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': UA,
      ...(cookie ? { Cookie: cookie } : {}),
      ...(init.headers || {}),
    },
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* non-JSON answers are reported as text */
  }
  return { status: res.status, ok: res.ok, json, text: text.slice(0, 400) };
}

async function ensureNode(base, cookie, { name, prefix, baseUrl }) {
  const list = await api(base, cookie, '/api/provider-nodes');
  const nodes = (list.json && list.json.nodes) || [];
  const existing = nodes.find((n) => n.name === name || n.prefix === prefix);
  if (existing) {
    console.log(`provider-node exists: ${existing.id} (prefix ${existing.prefix})`);
    return existing;
  }
  const created = await api(base, cookie, '/api/provider-nodes', {
    method: 'POST',
    body: JSON.stringify({ name, prefix, apiType: 'chat', type: 'openai-compatible', baseUrl }),
  });
  if (!created.ok) throw new Error(`create node failed ${created.status}: ${created.text}`);
  console.log(`provider-node created: ${created.json.node.id}`);
  return created.json.node;
}

async function ensureConnection(base, cookie, { nodeId, name, apiKey, defaultModel }) {
  const list = await api(base, cookie, '/api/providers');
  const conns = (list.json && list.json.connections) || [];
  const existing = conns.find((c) => c.provider === nodeId && c.name === name);
  if (existing) {
    console.log(`connection exists: ${existing.id} (${existing.name}) — pass --name "<label>" to attach another key`);
    return existing;
  }
  const created = await api(base, cookie, '/api/providers', {
    method: 'POST',
    body: JSON.stringify({ provider: nodeId, apiKey, name, priority: 1, defaultModel: defaultModel || null }),
  });
  if (!created.ok && created.status !== 409) {
    throw new Error(`create connection failed ${created.status}: ${created.text}`);
  }
  console.log(`connection created: ${(created.json && created.json.connection && created.json.connection.id) || '(conflict)'}`);
  return created.json && created.json.connection;
}

/**
 * Register the Mango node and attach `apiKey` as a connection.
 * `name` is the connection label: pass a distinct one per key ("Mango 01", …)
 * so the same node can hold as many keys as you minted.
 */
async function connectMango({
  base = DEFAULTS.base,
  password = DEFAULTS.password,
  apiKey,
  name = DEFAULTS.name,
  prefix = DEFAULTS.prefix,
  baseUrl = DEFAULTS.baseUrl,
  defaultModel = DEFAULTS.defaultModel,
} = {}) {
  if (!apiKey) throw new Error('--api-key is required');
  const { cookie, ok, body } = await login9router(base, password);
  console.log(`9Router login: ${ok ? 'ok' : 'not required/failed'} ${ok ? '' : body}`);
  const node = await ensureNode(base, cookie, { name: prefix, prefix, baseUrl });
  await ensureConnection(base, cookie, { nodeId: node.id, name, apiKey, defaultModel });
  console.log(`\nDone. Model prefix: ${prefix}/  ·  default: ${prefix}/${defaultModel}`);
  return node;
}

if (require.main === module) {
  const args = {};
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const k = argv[i].slice(2);
      const v = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
      args[k] = v;
    }
  }
  if (args.help) {
    const doc = require('fs').readFileSync(__filename, 'utf8');
    console.log(doc.slice(doc.indexOf('/**'), doc.indexOf('*/') + 2));
    process.exit(0);
  }
  connectMango({
    base: args.base,
    password: args.password,
    apiKey: args['api-key'] || process.env.NINEROUTER_API_KEY,
    name: args.name,
    prefix: args.prefix,
    baseUrl: args['base-url'],
    defaultModel: args.model,
  }).catch((e) => {
    console.error('[fatal] ' + e.message);
    process.exit(1);
  });
}

module.exports = { connectMango, login9router, ensureNode, ensureConnection };
