'use strict';

/**
 * Fetches `GET /v1/models` with a minted key (through a pool proxy) and writes
 * the raw payload to ../models.json.
 *
 *   node src/models.js [--key <key>]     (defaults to the first line of keys.txt)
 */

const fs = require('fs');
const path = require('path');
const lib = require('./lib');
const vlib = require('./verify-lib');

const HERE = path.join(__dirname);
const MODELS_FILE = path.join(HERE, 'models.json');

function arg(name) {
  const i = process.argv.indexOf(name);
  return i === -1 ? null : process.argv[i + 1];
}

(async () => {
  const key = arg('--key') || fs.readFileSync(path.join(HERE, 'keys.txt'), 'utf8').split(/\r?\n/).filter(Boolean)[0];
  if (!key) throw new Error('no key');

  const pool = lib.loadPool();
  const selfIp = await lib.ownIp();
  let lastErr = null;
  for (let i = 0; i < 6; i++) {
    const { proxy, ip } = await lib.pickExit(pool, { selfIp, start: i * 3 });
    try {
      const res = await vlib.apiCall(proxy, key, '/models', { timeoutMs: 45000 });
      if (res.status !== 200 || !res.json) throw new Error(`models -> ${res.status} ${res.text.slice(0, 120)}`);
      lib.saveJson(MODELS_FILE, { savedAt: new Date().toISOString(), baseUrl: lib.API_BASE, ...res.json });
      lib.log(`models.json saved: ${res.json.data.length} models via ${lib.proxyLabel(proxy)} (${ip})`);
      return process.exit(0);
    } catch (e) {
      lastErr = e;
      lib.log(`attempt ${i + 1} via ${lib.proxyLabel(proxy)} failed: ${e.message.slice(0, 80)}`);
    }
  }
  throw lastErr || new Error('could not fetch models');
})().catch((e) => {
  console.error('MODELS FAIL', e.stack || e.message);
  process.exit(1);
});
