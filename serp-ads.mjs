#!/usr/bin/env node
/**
 * Who is advertising on a Google query, and what they are saying.
 *
 *   node serp-ads.mjs "autosleutel bijmaken"
 *   node serp-ads.mjs "autosleutel bijmaken" --csv ads.csv
 *   node serp-ads.mjs "autosleutel bijmaken" --runs 4    # 4 profiles, usually 4 cities
 *   node serp-ads.mjs "autosleutel bijmaken" --profiles me,nl2
 *
 * A run whose page is google.com/sorry is reported as BLOCKED, not as "no ads":
 * those are completely different facts and conflating them wasted an evening.
 *
 * Needs the camofox server up with a proxy configured (see .env), because
 * Google blocks the host IP and falls back to DuckDuckGo without one.
 *
 * What this CAN see: advertiser domain, position (top vs bottom block), rank
 * within the block, headline, display URL, description, sitelinks, and the
 * price on shopping ads.
 *
 * What NO scraper can see: budget, bid, CPC, quality score, impression share.
 * Anyone claiming otherwise is selling you modelled estimates. "Winning" here
 * means position and repeat appearance across sessions, nothing more.
 *
 * Runs cycle through PROFILES (--profiles, default me,nl2,...). The proxy port
 * is keyed by profile name, so distinct profiles usually mean distinct exit IPs
 * and distinct Dutch cities -- which is the point: ad coverage varies per city,
 * and an advertiser present across profiles is buying broadly. Reusing one
 * profile does NOT give you a second opinion: same context, same IP, same city,
 * so the summary counts distinct profiles rather than runs.
 *
 * Profiles are deliberately stable and long-lived. A fresh profile per run gets
 * google.com/sorry instead of a SERP -- new profile + rotating residential IP is
 * a bot signal. Cold profiles may hit the consent wall or a check once; after
 * that their persisted storage state carries them.
 */
import { writeFileSync } from 'fs';

const CF = process.env.CF || 'http://localhost:9377';

const DEFAULT_PROFILES = ['me', 'nl2', 'nl3', 'nl4', 'nl5'];
const VALUE_FLAGS = new Set(['--runs', '--profiles', '--csv']);

/**
 * Pure, so --selftest can cover it. The previous version used
 * `argv.find(a => !a.startsWith('--'))`, which returns a preceding flag's
 * VALUE: `--runs 2 "autosleutel bijmaken"` searched Google for "2" and wrote
 * the results out under the intended keyword. Silently.
 */
export function parseArgs(argv) {
  const out = { query: null, runs: 1, profiles: DEFAULT_PROFILES.slice(), csv: null, selftest: false, error: null };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--selftest') { out.selftest = true; continue; }
    if (VALUE_FLAGS.has(a)) {
      const v = argv[++i];
      if (v === undefined) { out.error = `${a} needs a value`; return out; }
      if (a === '--runs') {
        const n = Number(v);
        if (!Number.isInteger(n) || n < 1) { out.error = `--runs must be a positive integer, got "${v}"`; return out; }
        out.runs = n;
      } else if (a === '--profiles') {
        out.profiles = v.split(',').map((x) => x.trim()).filter(Boolean);
        if (!out.profiles.length) { out.error = '--profiles is empty'; return out; }
      } else out.csv = v;
      continue;
    }
    if (a.startsWith('--')) { out.error = `unknown flag ${a}`; return out; }
    positional.push(a);
  }
  out.query = positional[0] || null;
  return out;
}

const opts = parseArgs(process.argv.slice(2));
const { query, runs: RUNS, profiles, csv: CSV } = opts;

const api = async (path, opts = {}) => {
  const r = await fetch(CF + path, {
    ...opts, headers: { 'content-type': 'application/json', ...(opts.headers || {}) },
  });
  try { return JSON.parse(await r.text()); } catch { return {}; }
};

const js = async (tab, U, expression) => {
  const r = await api(`/tabs/${tab}/evaluate`, {
    method: 'POST', body: JSON.stringify({ userId: U, expression }),
  });
  if (!r.ok) throw new Error(r.error || 'evaluate failed');
  return r.result;
};

/**
 * Runs inside the page. Reads the ad blocks by id, which is the stable part:
 * #tads is above the organic results, #bottomads below. Class names on the
 * cards themselves are obfuscated and change, so everything else is derived
 * from structure and the visible text.
 */
const EXTRACT = String.raw`(function () {
  var out = { location: null, ads: [], shopping: [], organic: [] };

  var m = document.body.innerText.match(/\n([A-Za-zÀ-ÿ'’.,\- ]{3,40}?)\s*\n[\s\S]{0,20}?Precieze locatie/);
  out.location = m ? m[1].trim() : null;

  function hostOf(a) {
    try {
      var u = new URL(a.href, location.href);
      var isGoogle = /(^|\.)google\./.test(u.hostname);
      var isRedir = u.pathname.indexOf('/url') === 0 || u.pathname.indexOf('/aclk') === 0;
      if (isGoogle || isRedir) {
        var q = u.searchParams.get('q') || u.searchParams.get('adurl');
        if (q && /^https?:/.test(q)) return new URL(q).hostname;
        return isGoogle ? null : u.hostname;
      }
      return u.hostname;
    } catch (e) { return null; }
  }

  ['tads', 'bottomads'].forEach(function (id) {
    var root = document.getElementById(id);
    if (!root) return;
    var block = id === 'tads' ? 'top' : 'bottom';
    // Each advertiser's card is the shallowest ancestor carrying a display URL.
    var cites = root.querySelectorAll('span[role="text"], cite');
    var seen = {};
    var rank = 0;
    cites.forEach(function (cite) {
      var card = cite;
      for (var k = 0; k < 12 && card; k++) {
        card = card.parentElement;
        if (card && card.innerText && card.innerText.length > 100) break;
      }
      if (!card) return;
      var link = card.querySelector('a[href]');
      var host = link ? hostOf(link) : null;
      if (!host || seen[block + host]) return;
      seen[block + host] = 1;
      rank++;
      var lines = card.innerText.split('\n').map(function (s) { return s.trim(); })
        .filter(function (s) { return s && !/^Gesponsord/.test(s); });
      // line 0 headline, then display url, then body; trailing short lines are sitelinks
      var head = lines[0] || '';
      var body = lines.filter(function (l) {
        return l.length > 45 && l !== head && !/^https?:/.test(l) && l.indexOf('\u203a') < 0;
      }).slice(0, 2).join(' ');
      var links = lines.filter(function (l) {
        return l.length > 2 && l.length <= 45 && l !== head && !/^https?:/.test(l) && l.indexOf(host) < 0;
      }).slice(0, 8);
      out.ads.push({ block: block, rank: rank, host: host, headline: head, body: body, sitelinks: links });
    });
  });

  // Shopping / PLA carousel carries real prices.
  document.querySelectorAll('[data-sh-or], .sh-dgr__content, [class*="pla-unit"]').forEach(function (el) {
    var t = el.innerText || '';
    var p = t.match(/€\s?[0-9][0-9.,]*/);
    if (!p) return;
    var a = el.querySelector('a[href]');
    var h = a ? hostOf(a) : null;
    out.shopping.push({ host: h, price: p[0], text: t.split('\n')[0].slice(0, 60) });
  });

  document.querySelectorAll('#search h3, #rso h3').forEach(function (h, i) {
    if (i > 9) return;
    var a = h.closest('a');
    out.organic.push({ pos: i + 1, host: a ? hostOf(a) : null, title: h.innerText.slice(0, 60) });
  });

  return JSON.stringify(out);
})()`;

async function oneRun(n) {
  // STABLE per run index -- never timestamped. The proxy port is keyed by
  // userId, so distinct names still rotate the exit IP; but a *fresh* name is
  // also a fresh profile with no cookies, and a brand-new profile arriving on a
  // rotating residential IP gets google.com/sorry instead of a SERP. Reusing
  // the same handful of names keeps their cookies and lets them age into trust.
  // First use of a new name may hit the consent wall or a CAPTCHA once; after
  // that the persisted storage state carries it.
  const U = profiles[(n - 1) % profiles.length];
  const { tabId: tab } = await api('/tabs', {
    method: 'POST', body: JSON.stringify({ userId: U, sessionKey: `ads${n}` }),
  });
  if (!tab) throw new Error('could not open a tab');
  try {
    const url = `https://www.google.nl/search?q=${encodeURIComponent(query)}&hl=nl&gl=NL`;
    await api(`/tabs/${tab}/navigate`, { method: 'POST', body: JSON.stringify({ userId: U, url }) });
    // Dismiss consent WITHOUT a locator wait: /click on a selector that is not
    // there blocks 30s and the server then destroys the tab as a timed-out
    // operation. Once storage state persists the choice the button is absent,
    // so the waiting version kills every later session.
    await js(tab, U, `(function(){var b=document.querySelector('#W0wltc');return b?(b.click(),'clicked'):'absent'})()`);
    await new Promise((r) => setTimeout(r, 2500));
    const here = await js(tab, U, 'location.href');
    if (/\/sorry\//.test(here)) return { blocked: true, profile: U };
    return { profile: U, ...JSON.parse(await js(tab, U, EXTRACT)) };
  } finally {
    await fetch(`${CF}/tabs/${tab}?userId=${U}`, { method: 'DELETE' }).catch(() => {});
  }
}

/**
 * Prove the parser against a known ad DOM, so "no ads" always means Google
 * served none -- never that the extractor quietly broke.
 *
 * The fixture is built inside the real browser (no jsdom dependency) from the
 * shape Google actually ships: #tads > card > cite + headline + body + sitelinks.
 * Text is copied from a live Den Haag SERP captured earlier.
 */
async function selftest() {
  const U = `serpselftest_${Date.now().toString(36)}`;
  const { tabId: tab } = await api('/tabs', {
    // example.com, not about:blank -- the server rejects non-http schemes. Any
    // page works; the fixture replaces its body wholesale.
    method: 'POST', body: JSON.stringify({ userId: U, sessionKey: 'st', url: 'https://example.com' }),
  });
  if (!tab) throw new Error('could not open a tab');
  const FIXTURE = String.raw`(function(){
    document.body.innerHTML =
      '<div id="tads">' +
      '  <div><div>Gesponsord</div>' +
      '    <a href="https://www.carkeyhouse.com/autosleutel/bijmaken"><div>Autosleutel bijmaken Den Haag - Tot 60% goedkoper dan dealer</div></a>' +
      '    <cite>https://www.carkeyhouse.com &rsaquo; autosleutel &rsaquo; bijmaken</cite>' +
      '    <div>Transponder en afstandsbediening ingeleerd. Voor vrijwel elk merk en type. SERMI-gecertificeerd en snel klaar.</div>' +
      '    <div>Autosleutel bijmaken?</div><div>Autosleutel kwijt</div>' +
      '  </div>' +
      '  <div><div>Gesponsord</div>' +
      '    <a href="https://www.buijsautosleutels.nl/"><div>Autosleutel Laten Bijmaken | Tot 50% Goedkoper Dan Dealer</div></a>' +
      '    <cite>https://www.buijsautosleutels.nl</cite>' +
      '    <div>Alle merken autosleutels bijgemaakt en geprogrammeerd terwijl u wacht in onze werkplaats.</div>' +
      '  </div>' +
      '</div>' +
      '<div id="rso"><a href="/url?q=https://www.autosleutel24.nl/arnhem"><h3>Autosleutel Bijmaken Arnhem</h3></a></div>';
    return 'built';
  })()`;
  try {
    await js(tab, U, FIXTURE);
    const d = JSON.parse(await js(tab, U, EXTRACT));
    const fails = [];
    const ok = (c, m) => { if (!c) fails.push(m); };
    ok(d.ads.length === 2, `expected 2 ads, got ${d.ads.length}`);
    ok(d.ads[0] && d.ads[0].host === 'www.carkeyhouse.com', `ad0 host: ${d.ads[0] && d.ads[0].host}`);
    ok(d.ads[0] && d.ads[0].block === 'top', 'ad0 should be in the top block');
    ok(d.ads[0] && d.ads[0].rank === 1, 'ad0 should rank 1');
    ok(d.ads[0] && /goedkoper dan dealer/i.test(d.ads[0].headline), `ad0 headline: ${d.ads[0] && d.ads[0].headline}`);
    ok(d.ads[0] && /SERMI/.test(d.ads[0].body), `ad0 body: ${d.ads[0] && d.ads[0].body}`);
    ok(d.ads[0] && d.ads[0].sitelinks.length >= 2, `ad0 sitelinks: ${d.ads[0] && d.ads[0].sitelinks.length}`);
    ok(d.ads[1] && d.ads[1].host === 'www.buijsautosleutels.nl', `ad1 host: ${d.ads[1] && d.ads[1].host}`);
    ok(!d.ads.some((a) => /^Gesponsord/.test(a.headline)), 'the Gesponsord label leaked into a headline');
    ok(d.organic[0] && d.organic[0].host === 'www.autosleutel24.nl',
      `organic unwrap: ${d.organic[0] && d.organic[0].host}`);

    // The arg layer, where four of the eight reviewed bugs lived. Every one of
    // these used to produce a clean-looking empty result instead of an error.
    const A = parseArgs;
    ok(A(['--runs', '2', 'autosleutel bijmaken']).query === 'autosleutel bijmaken',
      `flag value stolen as query: ${JSON.stringify(A(['--runs', '2', 'autosleutel bijmaken']).query)}`);
    ok(A(['--profiles', 'me', 'kopie maken']).query === 'kopie maken', '--profiles value stolen as query');
    ok(A(['q', '--runs', '3']).runs === 3, '--runs after the query');
    ok(A(['q', '--runs', 'all']).error, '--runs all must error, not silently run zero times');
    ok(A(['q', '--runs', '0']).error, '--runs 0 must error');
    ok(A(['q', '--runs', '2.5']).error, '--runs 2.5 must error');
    ok(A(['--selftest']).selftest && !A(['--selftest']).error, '--selftest needs no query');
    ok(A(['q', '--bogus']).error, 'unknown flag must error');
    ok(A(['q', '--csv']).error, 'flag with missing value must error');
    ok(A(['q']).profiles.length === DEFAULT_PROFILES.length, 'default profiles');
    ok(A(['q', '--profiles', 'a, b ,c']).profiles.join() === 'a,b,c', 'profiles are trimmed');
    console.log('\nserp-ads selftest — parser against a known ad DOM\n');
    if (fails.length) { fails.forEach((f) => console.error('  FAIL ' + f)); console.log('\nSELFTEST FAILED\n'); process.exitCode = 1; }
    else { console.log('  ok    parser: 2 advertisers, block, rank, headline, body, sitelinks, unwrap');
           console.log('  ok    args:   query vs flag values, --runs validation, --selftest, defaults');
           console.log('  passed\n'); }
  } finally {
    await fetch(`${CF}/tabs/${tab}?userId=${U}`, { method: 'DELETE' }).catch(() => {});
  }
}

// Bad flags are reported BEFORE anything else, with the actual reason. Falling
// through to the generic usage text hides which argument was wrong.
if (opts.error) {
  console.error(`serp-ads: ${opts.error}`);
  process.exit(2);
}

if (opts.selftest) { await selftest(); process.exit(process.exitCode || 0); }

if (!query) {
  console.error('usage: node serp-ads.mjs "<query>" [--runs N] [--profiles a,b] [--csv out.csv]');
  console.error('       node serp-ads.mjs --selftest        # offline parser check, no query needed');
  process.exit(2);
}

if (RUNS > profiles.length) {
  console.error(`serp-ads: ${RUNS} runs but only ${profiles.length} profiles -- profiles will repeat,`
    + ' and a repeat is the same exit IP and city, not an independent observation.');
}

const rows = [];
const byHost = new Map();
let serpRuns = 0;   // runs that actually produced a search page

for (let n = 1; n <= RUNS; n++) {
  process.stderr.write(`run ${n}/${RUNS}...\r`);
  let d;
  try { d = await oneRun(n); } catch (e) { console.error(`run ${n} failed: ${e.message}`); continue; }

  if (d.blocked) {
    console.log(`\n═══ run ${n} [${d.profile}] — BLOCKED: google.com/sorry bot check ═══`);
    console.log('  Not "no ads" -- no search page at all. Use an aged profile, or slow down.');
    continue;
  }
  serpRuns++;
  console.log(`\n═══ run ${n} [${d.profile}] — Google thinks we are in: ${d.location || 'unknown'} ═══`);

  if (!d.ads.length) console.log('  no text ads in this session');
  for (const a of d.ads) {
    console.log(`\n  [${a.block.toUpperCase()} #${a.rank}]  ${a.host}`);
    console.log(`     "${a.headline}"`);
    if (a.body) console.log(`     ${a.body.slice(0, 110)}`);
    if (a.sitelinks.length) console.log(`     ext: ${a.sitelinks.join(' · ')}`);
    rows.push({ run: n, profile: d.profile, city: d.location || '', ...a, sitelinks: a.sitelinks.join(' | ') });
    const k = a.host;
    if (!byHost.has(k)) byHost.set(k, { host: k, profiles: new Set(), best: 99, blocks: new Set() });
    const e = byHost.get(k);
    e.profiles.add(d.profile); e.blocks.add(a.block);
    if (a.block === 'top' && a.rank < e.best) e.best = a.rank;
  }

  if (d.shopping.length) {
    console.log('\n  shopping ads:');
    for (const s of d.shopping.slice(0, 6)) console.log(`     ${s.price}  ${s.host || ''}  ${s.text}`);
  }

  const mine = d.organic.find((o) => (o.host || '').includes('autosleutel24'));
  console.log(`\n  autosleutel24 organic: ${mine ? '#' + mine.pos : 'not in top 10'}`);
}

if (RUNS > 1) {
  // Denominator is DISTINCT profiles actually observed, not run count: a reused
  // profile is the same context, port, exit IP and city, so counting it twice
  // would let a one-city advertiser read as national.
  const seen = new Set(rows.map((r) => r.profile));
  console.log(`\n═══ who shows up most (${seen.size} distinct exit profiles) ═══\n`);
  [...byHost.values()].sort((a, b) => b.profiles.size - a.profiles.size || a.best - b.best).forEach((e) => {
    console.log(`  ${String(e.profiles.size).padStart(2)}/${seen.size} profiles  ${e.host.padEnd(32)}`
      + `${e.best < 99 ? 'best top #' + e.best : 'bottom only'}  [${[...e.blocks].join(',')}]`);
  });
}

if (!serpRuns) {
  // Every run was blocked or errored. Exiting 0 here would tell a cron job
  // "no competitors are advertising" when the truth is "we never saw a SERP".
  console.error(`\nserp-ads: 0 of ${RUNS} runs reached a search page. Nothing was measured.`);
  process.exitCode = 1;
}

if (CSV && rows.length) {
  const cols = ['run', 'profile', 'city', 'block', 'rank', 'host', 'headline', 'body', 'sitelinks'];
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  writeFileSync(CSV, [cols.join(','), ...rows.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\n'));
  console.log(`\n${CSV}: ${rows.length} ad rows`);
}
