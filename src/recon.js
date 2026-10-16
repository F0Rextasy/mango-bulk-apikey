'use strict';

/**
 * Recon for the Mango Inference console: pulls /login plus its JS chunks
 * through a proxy and dumps whatever describes the register flow
 * (server action id, form fields, endpoints).
 *
 *   node src/recon.js [--proxy line] [--all]
 */

const fs = require('fs');
const path = require('path');
const proxyLib = require('./proxy');

const HERE = __dirname;
const OUT = path.join(HERE, '..', 'outputs');
const ORIGIN = 'https://inference.mangoboost.io';

function pool() {
  const files = [
  path.join(__dirname, 'proxies.txt'),
    path.join(__dirname, 'out', 'pilot-proxies.txt'),
    path.join(__dirname, 'out', 'proxy-candidates-fresh.txt'),
  ];
  const out = [];
  for (const f of files) {
    try {
      for (const p of proxyLib.loadProxyList(f)) out.push(p);
    } catch {}
  }
  return out;
}

async function pickWorking(proxies, url) {
  for (const p of proxies) {
    if (proxyLib.isLocalHost && proxyLib.isLocalHost(p.host)) continue;
    try {
      const t0 = Date.now();
      const text = await proxyLib.fetchText(p, url, {
        timeoutMs: 15000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
        },
      });
      console.log(`proxy ok: ${proxyLib.label(p)} ${Date.now() - t0}ms len=${(text || '').length}`);
      if ((text || '').length < 200) continue; // tunnel up but the site gave nothing useful
      return { proxy: p, text };
    } catch (e) {
      console.log(`proxy fail: ${proxyLib.label(p)} ${e.message}`);
    }
  }
  throw new Error('no working proxy');
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const args = process.argv.slice(2);
  const forced = args.includes('--proxy') ? args[args.indexOf('--proxy') + 1] : null;
  const proxies = forced ? [proxyLib.parseProxy(forced)] : pool();
  console.log(`${proxies.length} proxies in pool`);

  const { proxy, text: loginHtml, status } = await pickWorking(proxies, `${ORIGIN}/login`);
  fs.writeFileSync(path.join(OUT, 'login.html'), loginHtml || '');
  console.log(`saved login.html status=${status} bytes=${(loginHtml || '').length}`);

  // List the chunks the page pulls.
  const chunks = [...new Set([...(loginHtml || '').matchAll(/\/_next\/static\/[^"'\\ ]+\.js/g)].map((m) => m[0]))];
  console.log(`${chunks.length} chunks referenced`);
  fs.writeFileSync(path.join(OUT, 'chunks.txt'), chunks.join('\n'));

  const interesting = [];
  for (const c of chunks) {
    try {
      const text = await proxyLib.fetchText(proxy, ORIGIN + c, { timeoutMs: 20000 });
      if (!text) continue;
      const name = path.basename(c);
      if (/registerAction|register-email|loginAction|Register|signup/i.test(text)) {
        fs.writeFileSync(path.join(OUT, `chunk-${name}`), text);
        interesting.push(name);
      }
    } catch (e) {
      console.log(`chunk fail ${c}: ${e.message}`);
    }
  }
  console.log(`interesting chunks: ${interesting.join(', ') || '(none)'}`);

  // Server action ids embedded in the HTML flight payload.
  const ids = [...new Set([...(loginHtml || '').matchAll(/"([0-9a-f]{40,44})"/g)].map((m) => m[1]))];
  console.log(`action-id-ish strings in HTML: ${ids.length}`);
  for (const id of ids) console.log('  ' + id);

  // Any register-related strings in raw HTML.
  for (const key of ['register', 'signup', 'password', 'email', 'clientRegion']) {
    const hits = [...(loginHtml || '').matchAll(new RegExp(`.{0,80}${key}.{0,80}`, 'gi'))].slice(0, 4);
    for (const h of hits) console.log(`[${key}] ${h[0].replace(/\s+/g, ' ')}`);
  }
})().catch((e) => {
  console.error('FAIL', e.stack || e.message);
  process.exit(1);
});
