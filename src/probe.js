'use strict';

/**
 * One-account live probe: drives a real Chrome through the whole Mango signup
 * (register -> OTP -> profile -> login -> key) with full network capture, so we
 * learn the exact HTTP shapes and grab account #1's key.
 *
 *   node src/probe.js [--headful] [--exit socks5://ip:port] [--mail mailtrap|inboxes]
 *
 * Writes: outputs/probe-capture.json, outputs/probe-1-account.json
 */

const fs = require('fs');
const path = require('path');
const lib = require('./lib');

const OUT = lib.OUT;
const CDP_PORT = parseInt(process.env.MANGO_CDP_PORT || '9910', 10);
const PROFILE = path.join(OUT, `.mango-chrome-${CDP_PORT}`);
const HEADFUL = process.argv.includes('--headful');

const argv = process.argv.slice(2);
const argVal = (name) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : null);

const captured = { requests: [], responses: [], notes: [], steps: {} };

function note(msg) {
  lib.log(msg);
  captured.notes.push(`[${lib.now()}] ${msg}`);
}

function findInputs(page) {
  return page.eval(`JSON.stringify([...document.querySelectorAll('input')].map(i => ({id:i.id, name:i.name, type:i.type, ph:i.placeholder, ac:i.autocomplete, hidden:i.offsetParent===null})))`);
}

async function dump(page, label) {
  const text = await page.body();
  note(`--[${label}] url=${await page.url()}`);
  note(`   text: ${String(text).replace(/\s+/g, ' ').slice(0, 400)}`);
  const inputs = await findInputs(page).catch(() => '[]');
  note(`   inputs: ${inputs}`);
}

function recordRequests(net, phase) {
  const set = captured.steps[phase] = captured.steps[phase] || { requests: [], responses: [] };
  for (const r of net.requests.splice(0)) {
    set.requests.push(r);
    captured.requests.push({ phase, ...r });
  }
  for (const r of net.responses.splice(0)) {
    set.responses.push(r);
    captured.responses.push({ phase, ...r });
  }
}

/** Waits until the net buffer holds a request matching `re`, then captures bodies. */
async function waitForRequest(net, re, { timeoutMs = 45000, page } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const hit = net.requests.find((r) => re.test(`${r.method} ${r.url}`));
    if (hit) {
      const res = net.responses.find((x) => x.url === hit.url && x.ts >= hit.ts - 1000);
      let body = '';
      if (res && page) body = await page.responseBody(res.requestId).catch(() => '');
      return { req: hit, res, body };
    }
    await lib.sleep(250);
  }
  return null;
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const pool = lib.loadPool();
  note(`pool size ${pool.length}`);

  const self = await lib.ownIp();
  note(`own ip ${self}`);

  let proxy = argVal('--exit') ? lib.proxyLib.parseProxy(argVal('--exit')) : null;
  let exitIp = null;
  if (proxy) {
    exitIp = await lib.exitIp(proxy);
  } else {
    const picked = await lib.pickExit(pool, { start: 0, selfIp: self });
    proxy = picked.proxy;
    exitIp = picked.ip;
  }
  note(`exit ${lib.proxyLabel(proxy)} (ip ${exitIp})`);

  // mailbox first so the address is ready when the form is filled
  const mailbox = await lib.newMailbox(argVal('--mail') || 'mailtrap');
  note(`mailbox ${mailbox.provider} ${mailbox.address}`);

  lib.launchChrome(CDP_PORT, PROFILE, { headless: !HEADFUL });
  if (!(await lib.waitForPort(CDP_PORT))) throw new Error('chrome did not open the debug port');
  const ws = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`).then((r) => r.json()).then((j) => j.webSocketDebuggerUrl);
  const cdp = new lib.CDP(ws, {});
  await cdp.connect();

  const { page, net, ctx, sessionId } = await lib.openContext(cdp, proxy, {
    capture: (url) => /mangoboost/i.test(url),
  });

  // ---------------------------------------------------------- step 1: register
  await page.goto(`${lib.ORIGIN}/login`);
  await page.waitFor(`document.body && /Sign in|Register|Email/i.test(document.body.innerText)`, { timeoutMs: 45000 });
  await lib.sleep(1500);

  // click the Register tab
  const clicked = await page.click(`document.querySelector('[id$="-trigger-register"], button[aria-controls*="content-register"]')`);
  note(`register tab click: ${clicked}`);
  await page.waitFor(`!!document.querySelector('#register-email')`, { timeoutMs: 15000 });
  await lib.sleep(600);

  // type e-mail via CDP
  await page.type('#register-email', mailbox.address);
  await dump(page, 'register-form');

  const submitSel = `(() => { const f = document.querySelector('#register-email').closest('form'); return f ? f.querySelector('button[type=submit]') : null; })()`;
  await page.click(submitSel);
  note('register submitted');

  const reg = await waitForRequest(net, /POST .*\/login/, { page, timeoutMs: 30000 });
  if (reg) {
    note(`register action -> ${reg.req.url} status=${reg.res && reg.res.status}`);
    note(`  headers: ${JSON.stringify({ 'next-action': reg.req.headers['Next-Action'] || reg.req.headers['next-action'], 'content-type': reg.req.headers['Content-Type'] || reg.req.headers['content-type'], 'next-router-state-tree': String(reg.req.headers['Next-Router-State-Tree'] || '').slice(0, 40) })}`);
    note(`  postData: ${String(reg.req.postData).slice(0, 400)}`);
    note(`  response: ${String(reg.body).slice(0, 600)}`);
  } else {
    note('register action NOT captured');
  }

  // did it navigate to /email-confirm?
  let url = await page.waitFor(`location.pathname === '/email-confirm' ? location.href : null`, { timeoutMs: 20000 });
  if (!url) {
    await dump(page, 'after-register');
    url = await page.url();
  }
  note(`after register url: ${url}`);

  // ------------------------------------------------------------ step 2: OTP
  const mail = await lib.waitForMail(mailbox, (m) => /mango|verify|code|confirm/i.test(`${m.subject} ${m.from} ${m.text}`.slice(0, 4000)), {
    timeoutMs: 150000,
    pollMs: 4000,
    note,
  });
  if (!mail) throw new Error('no OTP mail arrived');
  note(`OTP mail: from=${mail.from} subject=${mail.subject}`);
  const bodyText = `${mail.text || ''}\n${mail.html || ''}`;
  const codes = [...new Set([...bodyText.matchAll(/\b(\d{6})\b/g)].map((m) => m[1]))];
  const links = lib.extractLinks(mail);
  note(`OTP candidates: ${codes.join(',')} links: ${links.slice(0, 4).join(' ')}`);
  const otp = codes[0];
  if (!otp) {
    fs.writeFileSync(path.join(OUT, 'probe-otp-mail.txt'), bodyText);
    throw new Error('no 6-digit code found in the OTP mail (saved probe-otp-mail.txt)');
  }

  await dump(page, 'email-confirm-page');
  // pick the OTP input on the page
  const otpSel = await page.eval(`(() => { const inputs=[...document.querySelectorAll('input')].filter(i=>i.offsetParent!==null); const c = inputs.find(i=>/otp|code/i.test(i.id+i.name+i.autocomplete)) || inputs[0]; return c ? '#'+(c.id||'') : null; })()`);
  note(`otp input selector: ${otpSel}`);
  if (otpSel && otpSel.length > 1) {
    await page.type(otpSel, otp);
  } else {
    // no explicit selector: focus first visible input
    await page.click(`[...document.querySelectorAll('input')].filter(i=>i.offsetParent!==null)[0]`);
    await page.cdp.send('Input.insertText', { text: otp }, sessionId);
  }
  await page.click(`(() => { const b=[...document.querySelectorAll('button[type=submit]')].find(b=>/verify/i.test(b.textContent)); return b || null; })()`);
  note('otp submitted');
  const vres = await waitForRequest(net, /POST .*email-confirm/, { page, timeoutMs: 30000 });
  if (vres) {
    note(`otp action -> status=${vres.res && vres.res.status} next-action=${vres.req.headers['Next-Action'] || vres.req.headers['next-action']}`);
    note(`  postData: ${String(vres.req.postData).slice(0, 300)}`);
    note(`  response: ${String(vres.body).slice(0, 600)}`);
  } else note('otp action NOT captured');

  // ------------------------------------------------------- step 3: profile
  await lib.sleep(3000);
  await dump(page, 'after-otp');
  recordRequests(net, 'profile-load');
  const profileInputs = await findInputs(page);
  note(`profile inputs: ${profileInputs}`);

  const first = ['Elif', 'Deniz', 'Mert', 'Zeynep', 'Kaan'][Math.floor(Math.random() * 5)];
  const last = ['Yilmaz', 'Demir', 'Kaya', 'Aydin', 'Celik'][Math.floor(Math.random() * 5)];
  const password = lib.randomPassword();
  captured.steps.password = password;

  for (const [key, val] of [['firstName', first], ['lastName', last], ['password', password]]) {
    const sel = `(() => { const inputs=[...document.querySelectorAll('input')].filter(i=>i.offsetParent!==null); const el = inputs.find(i=>new RegExp(${JSON.stringify(key)},'i').test(i.id+i.name+i.autocomplete+i.placeholder)); return el ? (el.id ? '#'+el.id : null) : null; })()`;
    const id = await page.eval(sel);
    if (id) {
      await page.type(id, val);
      note(`typed ${key} -> ${id}`);
    } else {
      note(`no input found for ${key}; inputs: ${await findInputs(page)}`);
    }
  }
  // consent checkbox
  const cb = await page.click(`document.querySelector('input[type=checkbox], button[role=checkbox]')`);
  note(`consent checkbox click: ${cb}`);
  await lib.sleep(500);

  await page.click(`(() => { const b=[...document.querySelectorAll('button[type=submit]')].find(b=>/create|continue|finish|sign up|complete/i.test(b.textContent)); return b || null; })()`);
  note('profile submitted');
  const pres = await waitForRequest(net, /mangoboost.*(POST|PATCH|PUT)/, { page, timeoutMs: 40000 });
  if (pres) {
    note(`profile action -> ${pres.req.method} ${pres.req.url} status=${pres.res && pres.res.status}`);
    note(`  next-action=${pres.req.headers['Next-Action'] || pres.req.headers['next-action']}`);
    note(`  postData: ${String(pres.req.postData).slice(0, 500)}`);
    note(`  response: ${String(pres.body).slice(0, 800)}`);
  } else note('profile action NOT captured');

  // --------------------------------------------------------- settle at dashboard
  await lib.sleep(4000);
  const dashUrl = await page.url();
  const dashText = await page.body();
  note(`after profile: url=${dashUrl}`);
  note(`  text: ${String(dashText).replace(/\s+/g, ' ').slice(0, 400)}`);
  recordRequests(net, 'post-profile');

  // if we're still on /email-confirm or /login, try a plain login with the password
  if (!/dashboard/i.test(dashUrl)) {
    note('not on dashboard; attempting explicit sign-in');
    await page.goto(`${lib.ORIGIN}/login`);
    await page.waitFor(`!!document.querySelector('#signin-email')`, { timeoutMs: 30000 });
    await page.type('#signin-email', mailbox.address);
    await page.type('#signin-password', password);
    await page.click(`(() => { const f=document.querySelector('#signin-email').closest('form'); return f?f.querySelector('button[type=submit]'):null; })()`);
    const lres = await waitForRequest(net, /POST .*\/login/, { page, timeoutMs: 30000 });
    if (lres) {
      note(`login action -> status=${lres.res && lres.res.status} next-action=${lres.req.headers['Next-Action'] || lres.req.headers['next-action']}`);
      note(`  postData: ${String(lres.req.postData).slice(0, 300)}`);
      note(`  response: ${String(lres.body).slice(0, 400)}`);
    }
    await lib.sleep(5000);
    note(`after explicit login url=${await page.url()}`);
    recordRequests(net, 'login');
  }

  // ------------------------------------------------------------- step 4: key
  await page.goto(`${lib.ORIGIN}/keys`);
  await lib.sleep(4000);
  await dump(page, 'keys-page');
  recordRequests(net, 'keys-load');
  const keysHtml = await page.html();
  fs.writeFileSync(path.join(OUT, 'probe-keys-page.html'), keysHtml || '');

  // click the create-key button
  const createClicked = await page.click(
    `(() => { const b=[...document.querySelectorAll('button')].find(b=>/create|new key|add key|generate/i.test(b.textContent)); return b || null; })()`
  );
  note(`create-key click: ${createClicked}`);
  await lib.sleep(2500);
  await dump(page, 'create-key-modal');
  recordRequests(net, 'create-key-open');
  const modalHtml = await page.html();
  fs.writeFileSync(path.join(OUT, 'probe-key-modal.html'), modalHtml || '');

  // fill a key name if a modal asked for one, then submit
  const keyName = `mango-${lib.rand(5)}`;
  const nameTyped = await page.eval(
    `(() => { const inputs=[...document.querySelectorAll('input[type=text],input:not([type])')].filter(i=>i.offsetParent!==null); if(!inputs.length) return null; const el=inputs[0]; el.focus(); return el.id||el.name||'(anon)'; })()`
  );
  note(`key name input: ${nameTyped}`);
  if (nameTyped) {
    const sel = nameTyped.startsWith('(') ? `[...document.querySelectorAll('input[type=text],input:not([type])')].filter(i=>i.offsetParent!==null)[0]` : `document.querySelector('#${nameTyped}')`;
    await page.click(sel);
    await page.cdp.send('Input.insertText', { text: keyName }, sessionId);
    await lib.sleep(400);
    await page.click(`(() => { const b=[...document.querySelectorAll('button[type=submit],button')].find(b=>/create|generate|confirm|save|add/i.test(b.textContent)); return b || null; })()`);
    note('key create submitted');
  }
  const kres = await waitForRequest(net, /(keys|key)/i, { page, timeoutMs: 30000 });
  if (kres) {
    note(`key action -> ${kres.req.method} ${kres.req.url} status=${kres.res && kres.res.status}`);
    note(`  next-action=${kres.req.headers['Next-Action'] || kres.req.headers['next-action']}`);
    note(`  postData: ${String(kres.req.postData).slice(0, 300)}`);
    note(`  response: ${String(kres.body).slice(0, 1200)}`);
  }
  await lib.sleep(3500);
  await dump(page, 'after-key-create');
  const afterHtml = await page.html();
  fs.writeFileSync(path.join(OUT, 'probe-after-key.html'), afterHtml || '');
  recordRequests(net, 'key-create');

  // lift a key-looking token from any captured response body
  const bodies = [];
  for (const r of captured.requests.filter((r) => /keys/i.test(r.url))) {
    const resp = captured.responses.find((x) => x.url === r.url && x.ts >= r.ts - 1000);
    if (resp && page) bodies.push({ url: r.url, status: resp.status, body: await page.responseBody(resp.requestId).catch(() => '') });
  }
  fs.writeFileSync(path.join(OUT, 'probe-key-bodies.json'), JSON.stringify(bodies, null, 2));
  const allBodies = bodies.map((b) => b.body).join('\n') + '\n' + afterHtml;
  const keys = [...new Set([...allBodies.matchAll(/\b(mg[a-zA-Z0-9_-]{16,}|sk-[a-zA-Z0-9_-]{16,}|[a-zA-Z0-9_-]{32,64})\b/g)].map((m) => m[1]))].slice(0, 20);
  note(`key candidates: ${keys.map((k) => k.slice(0, 6) + '...' + k.slice(-4)).join(', ') || '(none)'}`);

  // cookies for HTTP replay
  const cookies = await page.cookies();
  note(`cookies: ${cookies.map((c) => `${c.name}@${c.domain}`).join(', ')}`);

  // -------------------------------------------------------------- save + report
  fs.writeFileSync(path.join(OUT, 'probe-capture.json'), JSON.stringify(captured, null, 2));
  fs.writeFileSync(
    path.join(OUT, 'probe-1-account.json'),
    JSON.stringify({ email: mailbox.address, mailbox: { provider: mailbox.provider, token: mailbox.token }, password, exit: lib.proxyLabel(proxy), exitIp, keyName, keyCandidates: keys, cookies }, null, 2)
  );
  note('probe capture saved');

  cdp.close();
  await lib.sleep(300);
  process.exit(0);
})().catch((e) => {
  console.error('PROBE FAIL', e.stack || e.message);
  try {
    fs.writeFileSync(path.join(OUT, 'probe-capture.json'), JSON.stringify(captured, null, 2));
  } catch {}
  process.exit(1);
});
