'use strict';

/**
 * With a signed-in jar from http-signup-test.js: pull /keys, its chunks, and
 * the create-key action id / BFF endpoints they use.
 *
 *   node src/keys-probe.js
 */

const fs = require('fs');
const path = require('path');
const lib = require('./lib');
const rsc = require('./rsc');

const STATE_FILE = path.join(lib.OUT, 'http-signup-state.json');

(async () => {
  const state = lib.readJson(STATE_FILE, null);
  if (!state || !state.jar || !Object.keys(state.jar).length) throw new Error('no jar in http-signup-state.json');
  const proxy = lib.proxyLib.parseProxy(state.exit);
  const jar = new lib.Jar();
  jar.load(state.jar);

  const res = await lib.httpReq(proxy, `${lib.ORIGIN}/keys`, { headers: { Accept: 'text/html' }, jar, timeoutMs: 60000 });
  lib.log(`GET /keys -> ${res.status} (${res.text.length} bytes)`);
  const setCookies = (res.headers['set-cookie'] || []).map((c) => String(c).split(';')[0]);
  if (setCookies.length) lib.log(`  set-cookie: ${setCookies.join(' | ').slice(0, 300)}`);
  fs.writeFileSync(path.join(lib.OUT, 'keys-page.html'), res.text);
  state.jar = jar.dump();
  lib.saveJson(STATE_FILE, state);

  if (res.status !== 200) {
    lib.log(`  location: ${res.headers.location}`);
    lib.log(`  head: ${res.text.slice(0, 300)}`);
    return;
  }

  const chunks = [...new Set([...res.text.matchAll(/\/_next\/static\/chunks\/[^"'\\ ]+\.js/g)].map((m) => m[0]))];
  lib.log(`${chunks.length} chunks on /keys`);
  fs.writeFileSync(path.join(lib.OUT, 'keys-chunks.txt'), chunks.join('\n'));

  const hits = [];
  for (const c of chunks) {
    const name = path.basename(c);
    const local = path.join(lib.OUT, `keys-chunk-${name}`);
    let text = '';
    if (fs.existsSync(local)) text = fs.readFileSync(local, 'utf8');
    else {
      try {
        text = await lib.proxyLib.fetchText(proxy, lib.ORIGIN + c, { timeoutMs: 30000 });
        fs.writeFileSync(local, text || '');
      } catch (e) {
        lib.log(`  chunk fail ${name}: ${e.message.slice(0, 60)}`);
        continue;
      }
    }
    const actions = [...text.matchAll(/createServerReference\("([0-9a-f]{40,44})"[^)]*?,\s*"([a-zA-Z]+)"/g)];
    const bff = [...new Set([...text.matchAll(/["'`](\/api\/bff\/[a-zA-Z0-9_\-\/{}]*)/g)].map((m) => m[1]))];
    const keysy = [...new Set([...text.matchAll(/["'`][^"'`]{0,50}(?:api[- ]?key|Create key|createKey|keys)[^"'`]{0,50}["'`]/gi)].map((m) => m[0]))].slice(0, 12);
    if (actions.length || bff.length || keysy.length) {
      lib.log(`== ${name}`);
      for (const a of actions) lib.log(`   action: ${a[2]} = ${a[1]}`);
      if (bff.length) lib.log(`   bff: ${bff.join(' ')}`);
      for (const k of keysy) lib.log(`   str: ${k.slice(0, 110)}`);
      hits.push({ chunk: name, actions: actions.map((a) => ({ name: a[2], id: a[1] })), bff, keysy });
    }
  }
  lib.saveJson(path.join(lib.OUT, 'keys-chunk-scan.json'), hits);
  lib.log('scan saved');
  process.exit(0);
})().catch((e) => {
  console.error('KEYS PROBE FAIL', e.stack || e.message);
  process.exit(1);
});
