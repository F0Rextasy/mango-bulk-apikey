'use strict';

/**
 * Probes the console BFF with the signed-in jar: which endpoints exist, what
 * the account/key/credit shapes look like.
 *
 *   node src/bff-probe.js
 */

const path = require('path');
const lib = require('./lib');

const STATE_FILE = path.join(lib.OUT, 'http-signup-state.json');

(async () => {
  const state = lib.readJson(STATE_FILE, null);
  if (!state || !state.jar) throw new Error('no jar in http-signup-state.json');
  const proxy = lib.proxyLib.parseProxy(state.exit);
  const jar = new lib.Jar();
  jar.load(state.jar);

  const paths = [
    '/api/bff/keys',
    '/api/bff/api-keys',
    '/api/bff/me',
    '/api/bff/account',
    '/api/bff/accounts/me',
    '/api/bff/billing',
    '/api/bff/credits',
    '/api/bff/usage',
    '/api/bff/orgs',
    '/api/bff/organizations',
    '/api/bff/models',
    '/api/bff/documents',
  ];
  for (const p of paths) {
    try {
      const res = await lib.httpReq(proxy, `${lib.ORIGIN}${p}`, { headers: { Accept: 'application/json' }, jar, timeoutMs: 25000 });
      const body = res.text.replace(/\s+/g, ' ').slice(0, 260);
      lib.log(`${p} -> ${res.status} ${body}`);
      if (res.status === 200) {
        lib.saveJson(path.join(lib.OUT, `bff${p.replace(/\//g, '_')}.json`), res.json || res.text);
      }
    } catch (e) {
      lib.log(`${p} -> ERR ${e.message.slice(0, 80)}`);
    }
  }
  process.exit(0);
})().catch((e) => {
  console.error('BFF PROBE FAIL', e.stack || e.message);
  process.exit(1);
});
