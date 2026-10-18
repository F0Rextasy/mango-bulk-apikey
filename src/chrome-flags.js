// Shared lean launch flags for every CDP browser the toolchain opens.
//
// Measured 2026-10-14: 97 chrome.exe processes across the tool’s profiles cost
// 7.42 GB of RAM (~6.55 GB free left). Each profile spawns ~8-12 processes
// (browser + renderers + GPU + utility). Two levers matter, in this order:
//   1) fewer concurrent profiles (the biggest win by far),
//   2) lean flags per profile — GPU/utility/renderer trimming is worth ~30-40 %.
//
// Usage:  const { leanArgs } = require('./chrome-flags');
//         puppeteer.launch({ args: [...leanArgs(), '--user-data-dir=…'], … })
//
// Fingerprints: one profile must never wear another profile's UA / viewport /
// timezone / locale. `fingerprintForIndex(i, { country })` answers all four from
// one index, so they always move together (relaunching the same profile index
// reproduces the same fingerprint; the next index gets a different one).
'use strict';

const fs = require('fs');

/** Stock Windows install; move or rename the binary with SD_CHROME. */
const DEFAULT_CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

/** Headless Chrome advertises `HeadlessChrome` in the UA string, which Turnstile
 *  and reCAPTCHA read as a bot. A headless run must therefore pin a headed UA. */
const HEADLESS_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36';

/** The built-in, realistic recent-Chrome pool (one string per profile). */
const UA_POOL = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36',
];

/** Viewports that pair with the pool above (width,height), same index space. */
const VIEWPORT_POOL = ['1280,900', '1366,768', '1440,900', '1536,864'];

/** Locale order per profile; first entry is `--lang`, the list feeds
 *  navigator.languages-style overrides when a caller applies them. */
const LOCALE_POOL = [
  { lang: 'en-US', languages: 'en-US,en' },
  { lang: 'en-GB', languages: 'en-GB,en' },
  { lang: 'de-DE', languages: 'de-DE,de,en-US,en' },
  { lang: 'tr-TR', languages: 'tr-TR,tr,en-US,en' },
];

/** Country (ISO-2, as the exit pool reports it) -> IANA timezone. */
const TZ_BY_COUNTRY = {
  US: 'America/New_York',
  CA: 'America/Toronto',
  BR: 'America/Sao_Paulo',
  GB: 'Europe/London',
  DE: 'Europe/Berlin',
  FR: 'Europe/Paris',
  NL: 'Europe/Amsterdam',
  PL: 'Europe/Warsaw',
  TR: 'Europe/Istanbul',
  RU: 'Europe/Moscow',
  IN: 'Asia/Kolkata',
  SG: 'Asia/Singapore',
  JP: 'Asia/Tokyo',
  KR: 'Asia/Seoul',
  ID: 'Asia/Jakarta',
  AU: 'Australia/Sydney',
  UA: 'Europe/Kyiv',
};

/** Fallback timezones when the exit's country is unknown, same index space. */
const TZ_POOL = ['America/New_York', 'Europe/London', 'Europe/Berlin', 'Asia/Singapore'];

/** Country -> locale order, used when the exit's country is known. */
const LOCALE_BY_COUNTRY = {
  US: [{ lang: "en-US", languages: "en-US,en" }, { lang: "en-US", languages: "en-US,en-US" }],
  CA: [{ lang: "en-CA", languages: "en-CA,en,fr-CA" }, { lang: "en-CA", languages: "en-CA,en" }],
  BR: [{ lang: "pt-BR", languages: "pt-BR,pt,en-US,en" }, { lang: "pt-BR", languages: "pt-BR,pt" }],
  GB: [{ lang: "en-GB", languages: "en-GB,en" }, { lang: "en-GB", languages: "en-GB,en-GB" }],
  DE: [{ lang: "de-DE", languages: "de-DE,de,en-US,en" }, { lang: "de-DE", languages: "de-DE,de" }],
  FR: [{ lang: "fr-FR", languages: "fr-FR,fr,en-US,en" }, { lang: "fr-FR", languages: "fr-FR,fr" }],
  NL: [{ lang: "nl-NL", languages: "nl-NL,nl,en-US,en" }, { lang: "nl-NL", languages: "nl-NL,nl" }],
  PL: [{ lang: "pl-PL", languages: "pl-PL,pl,en-US,en" }, { lang: "pl-PL", languages: "pl-PL,pl" }],
  TR: [{ lang: "tr-TR", languages: "tr-TR,tr,en-US,en" }, { lang: "tr-TR", languages: "tr-TR,tr" }],
  RU: [{ lang: "ru-RU", languages: "ru-RU,ru,en-US,en" }, { lang: "ru-RU", languages: "ru-RU,ru" }],
  IN: [{ lang: "en-IN", languages: "en-IN,en,hi" }, { lang: "en-IN", languages: "en-IN,en" }],
  SG: [{ lang: "en-SG", languages: "en-SG,en" }, { lang: "en-SG", languages: "en-SG,en-SG" }],
  JP: [{ lang: "ja-JP", languages: "ja-JP,ja,en-US,en" }, { lang: "ja-JP", languages: "ja-JP,ja" }],
  KR: [{ lang: "ko-KR", languages: "ko-KR,ko,en-US,en" }, { lang: "ko-KR", languages: "ko-KR,ko" }],
  ID: [{ lang: "id-ID", languages: "id-ID,id,en-US,en" }, { lang: "id-ID", languages: "id-ID,id" }],
  AU: [{ lang: "en-AU", languages: "en-AU,en" }, { lang: "en-AU", languages: "en-AU,en-AU" }],
  UA: [{ lang: "uk-UA", languages: "uk-UA,uk,ru,en-US,en" }, { lang: "uk-UA", languages: "uk-UA,uk,ru,en" }],
};

/** Chrome binary: SD_CHROME wins; a headless-shell override is honoured only for
 *  headless runs (optional — never forced); otherwise the stock install path. */
function chromePath({ headless = false } = {}) {
  if (process.env.SD_CHROME) return process.env.SD_CHROME;
  if (headless && process.env.SD_CHROME_HEADLESS_SHELL) return process.env.SD_CHROME_HEADLESS_SHELL;
  return DEFAULT_CHROME;
}

/** The operator's own pool: SD_UA_POOL as a file path or a comma-separated list.
 *  Anything unreadable falls back to the built-in pool (never to a direct run). */
function uaPool() {
  const env = process.env.SD_UA_POOL;
  if (env) {
    const lines = fs.existsSync(env)
      ? fs.readFileSync(env, 'utf8').split(/\r?\n/)
      : String(env).split(',');
    const pool = lines.map((l) => l.trim()).filter((l) => /^Mozilla\//.test(l));
    if (pool.length) return pool;
  }
  return UA_POOL;
}

/** Stable 32-bit hash of a seed (profile dir, account id, …). */
function seedHash(seed) {
  const s = String(seed == null ? '' : seed);
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

/** One fingerprint per profile index: UA, viewport, locale and timezone are
 *  counted out as one mixed-radix number, so profile i and profile i+1 differ
 *  in UA first, then in viewport, then in locale — no two neighbouring profiles
 *  in a run share an identity, and the walk only wraps once the whole space
 *  (4 UA x 4 viewport x locale/timezone variants) has been handed out.
 *  `country` (from the exit) pins tz and locale to that country; for the
 *  built-in pools that leaves 4 UA x 4 viewport x 2 locale orders = 32
 *  identities per country. */
function fingerprintForIndex(index, { country = null } = {}) {
  const i = Number.isFinite(index) ? Math.abs(Math.trunc(index)) : 0;
  const pool = uaPool();
  const iso = String(country || '').toUpperCase();
  const locales = LOCALE_BY_COUNTRY[iso] || LOCALE_POOL;
  const zones = TZ_BY_COUNTRY[iso] ? [TZ_BY_COUNTRY[iso]] : TZ_POOL;
  const perUa = pool.length;
  const perViewport = perUa * VIEWPORT_POOL.length;
  const uaIdx = i % perUa;
  const vpIdx = Math.floor(i / perUa) % VIEWPORT_POOL.length;
  const locIdx = Math.floor(i / perViewport) % locales.length;
  const tzIdx = Math.floor(i / perViewport) % zones.length;
  return {
    index: i,
    userAgent: process.env.SD_UA || pool[uaIdx],
    windowSize: VIEWPORT_POOL[vpIdx],
    timezone: zones[tzIdx],
    locale: locales[locIdx],
  };
}

/** Fingerprint for a seed that is not an index (profile dir, account id, …). */
function fingerprintForSeed(seed, opts) {
  return fingerprintForIndex(seedHash(seed) % 64, opts);
}

/** The UA a given profile carries (SD_UA pins one UA for a one-off run). */
function uaForProfile(seed) {
  return process.env.SD_UA || fingerprintForSeed(seed).userAgent;
}

/** The `WxH` viewport a given profile carries. */
function viewportForProfile(seed) {
  return fingerprintForSeed(seed).windowSize;
}

/** The UA a bare headless run carries when no profile is known (SD_UA wins). */
function uaPin() {
  return process.env.SD_UA || HEADLESS_UA;
}

/** Flags that cut memory without touching JS execution or rendering fidelity.
 *  `ua` overrides the headless pin for this one profile (see uaForProfile). */
function leanArgs({ headless = false, ua = null, extra = [] } = {}) {
  const args = [
    '--disable-gpu',
    '--disable-software-rasterizer',
    '--disable-dev-shm-usage',
    '--disable-extensions',
    '--disable-background-networking',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-default-apps',
    '--disable-sync',
    '--disable-features=Translate,BackForwardCache,AcceptCHFrame,MediaRouter,OptimizationHints',
    '--renderer-process-limit=2',
    '--js-flags=--max-old-space-size=256',
    '--no-first-run',
    '--no-default-browser-check',
    '--mute-audio',
    ...extra,
  ];
  // The UA pin rides along with the headless switch, so no caller can launch a
  // headless browser that still advertises HeadlessChrome to a captcha.
  if (headless) args.push('--headless=new', `--user-agent=${ua || uaPin()}`);
  return args;
}

/** Deletes disposable profile dirs a crashed run left behind (a profile is
 *  created per account/run; leftovers are 40-90 MB each and never reused).
 *  Only dirs older than maxAgeMs are touched, so a live Chrome keeps its own. */
function sweepProfiles(dirPrefix, { maxAgeMs = 12 * 3600 * 1000, root = null } = {}) {
  const os = require('os');
  const path = require('path');
  const base = root || os.homedir();
  let removed = 0;
  try {
    for (const name of fs.readdirSync(base)) {
      if (!name.startsWith(dirPrefix)) continue;
      const dir = path.join(base, name);
      try {
        if (Date.now() - fs.statSync(dir).mtimeMs < maxAgeMs) continue;
        fs.rmSync(dir, { recursive: true, force: true });
        removed++;
      } catch {}
    }
  } catch {}
  return removed;
}

/** A realistic lower bound: one browser with several isolated contexts. */
function sharedBrowserNote() {
  return [
    'Prefer ONE browser with multiple isolated contexts over one browser per account:',
    "  const { browserContextId } = await client.send('Target.createBrowserContext', { proxyServer: 'socks5://…' });",
    "  const { targetId } = await client.send('Target.createTarget', { url, browserContextId });",
    'Each context has its own cookies/proxy/UA and is invisible to the others, while the',
    'process tree (and therefore the RAM cost) is shared. Only the captcha phase truly',
    'needs a visible, dedicated window.',
  ].join('\n');
}

module.exports = {
  leanArgs,
  chromePath,
  uaPin,
  uaPool,
  uaForProfile,
  viewportForProfile,
  fingerprintForIndex,
  fingerprintForSeed,
  seedHash,
  UA_POOL,
  VIEWPORT_POOL,
  LOCALE_POOL,
  TZ_POOL,
  TZ_BY_COUNTRY,
  LOCALE_BY_COUNTRY,
  DEFAULT_CHROME,
  HEADLESS_UA,
  sharedBrowserNote,
  sweepProfiles,
};
