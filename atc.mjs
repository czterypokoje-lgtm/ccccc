#!/usr/bin/env node
/**
 * Google Ads Transparency Center -> every live ad a competitor runs.
 *
 *   node atc.mjs carkeyhouse.com
 *   node atc.mjs carkeyhouse.com --shots ads/ --csv ads.csv
 *   node atc.mjs carkeyhouse.com deregioslotenmaker.nl autosleutelsrdm.nl
 *   node atc.mjs --selftest
 *
 * Public data. No proxy, no SERP scraping, no bot check -- this is Google's own
 * disclosure page, and it shows EVERY creative an advertiser runs, not just the
 * one that happened to win the auction you looked at.
 *
 * Why screenshots and not text: the creative renders through a nested, signed
 * preview pipeline (displayads-formats.googleusercontent.com with a per-request
 * sig + nonce) into frames whose content never lands in the DOM -- verified
 * empty after 15s. The surrounding metadata IS in the DOM. So this reads the
 * metadata and photographs the ad. The picture is the creative; everything
 * around it is data.
 *
 * The useful signal here is not the copy, it is FIRST/LAST SHOWN. Advertisers
 * kill losing ads. An ad still serving months after launch is one that works;
 * a cluster of ads first shown last week is a competitor changing strategy.
 */
import { writeFileSync, mkdirSync } from 'fs';

const CF = process.env.CF || 'http://localhost:9377';
const U = 'atc';
const BASE = 'https://adstransparency.google.com';
const REGION = process.env.ATC_REGION || 'NL';

const argv = process.argv.slice(2);
const VALUE_FLAGS = new Set(['--shots', '--csv', '--limit', '--region']);

export function parseArgs(args) {
  const o = { domains: [], shots: null, csv: null, limit: 0, selftest: false, error: null };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--selftest') { o.selftest = true; continue; }
    if (VALUE_FLAGS.has(a)) {
      const v = args[++i];
      if (v === undefined) { o.error = `${a} needs a value`; return o; }
      if (a === '--limit') {
        const n = Number(v);
        if (!Number.isInteger(n) || n < 1) { o.error = `--limit must be a positive integer, got "${v}"`; return o; }
        o.limit = n;
      } else if (a === '--shots') o.shots = v;
      else if (a === '--csv') o.csv = v;
      continue;
    }
    if (a.startsWith('--')) { o.error = `unknown flag ${a}`; return o; }
    o.domains.push(a);
  }
  return o;
}

const api = async (path, opts = {}) => {
  const r = await fetch(CF + path, {
    ...opts, headers: { 'content-type': 'application/json', ...(opts.headers || {}) },
  });
  try { return JSON.parse(await r.text()); } catch { return {}; }
};
const js = async (tab, expression) => {
  const r = await api(`/tabs/${tab}/evaluate`, {
    method: 'POST', body: JSON.stringify({ userId: U, expression }),
  });
  if (!r.ok) throw new Error(r.error || 'evaluate failed');
  return r.result;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Creative metadata out of the detail page's visible text. Kept pure for
 * --selftest: every field here is a Dutch label that Google can rename, and a
 * silent null is indistinguishable from "ad has no end date" unless tested.
 */
export function parseCreative(text) {
  const after = (label) => {
    const m = text.match(new RegExp(label + '\\s*:?\\s*\\n?\\s*([^\\n]+)'));
    return m ? m[1].trim() : null;
  };
  const variants = text.match(/(\d+)\s+van\s+(\d+)\s+varianten/);
  return {
    advertiser: (() => {
      const m = text.match(/Advertentiedetails\s*\n\s*([^\n]+)/);
      return m ? m[1].trim() : null;
    })(),
    firstShown: after('Voor het eerst getoond'),
    lastShown: after('Voor het laatst weergegeven'),
    format: after('Indeling'),
    topic: after('Onderwerp \\(gelabeld door Google\\)'),
    variants: variants ? Number(variants[2]) : 1,
  };
}

/** Days an ad has been running. The closest public proxy for "this one works". */
export function daysLive(firstShown, lastShown) {
  const NL = { jan: 0, feb: 1, mrt: 2, apr: 3, mei: 4, jun: 5, jul: 6, aug: 7, sep: 8, okt: 9, nov: 10, dec: 11 };
  const parse = (s) => {
    const m = (s || '').match(/(\d{1,2})\s+([a-z]{3})\s+(\d{4})/i);
    if (!m) return null;
    const mo = NL[m[2].toLowerCase()];
    return mo === undefined ? null : new Date(Date.UTC(+m[3], mo, +m[1]));
  };
  const a = parse(firstShown); const b = parse(lastShown);
  if (!a || !b) return null;
  return Math.round((b - a) / 86400000) + 1;
}

async function openTab() {
  const { tabId } = await api('/tabs', {
    method: 'POST', body: JSON.stringify({ userId: U, sessionKey: 'atc' }),
  });
  if (!tabId) throw new Error('could not open a tab -- is the server running?');
  return tabId;
}
const closeTab = (tab) => fetch(`${CF}/tabs/${tab}?userId=${U}`, { method: 'DELETE' }).catch(() => {});
const goto = (tab, url) =>
  api(`/tabs/${tab}/navigate`, { method: 'POST', body: JSON.stringify({ userId: U, url }) });

/**
 * domain -> advertiser IDs -> every creative.
 *
 * The domain page is NOT the right entry point: it renders one account's grid
 * and stops (4 of carkeyhouse's 20), and a domain routinely spans several
 * advertiser accounts -- deregioslotenmaker.nl runs two. The advertiser page
 * returns the full set in one load. So resolve the IDs from the domain page,
 * then enumerate each advertiser.
 */
async function advertiserIds(tab, domain) {
  await goto(tab, `${BASE}/?region=${REGION}&domain=${encodeURIComponent(domain)}`);
  await sleep(8000);
  const reported = await js(tab, `(document.body.innerText.match(/(\\d+)\\s+advertenties?/)||[0,"?"])[1]`);
  // Scroll once: more cards means more distinct advertiser ids surface.
  await js(tab, 'window.scrollTo(0,document.body.scrollHeight);1');
  await sleep(2500);
  const ids = JSON.parse(await js(tab,
    `JSON.stringify([...new Set((document.body.innerHTML.match(/advertiser\\/(AR\\d+)/g)||[])
       .map(function(x){return x.split('/')[1]}))])`));
  return { reported, ids };
}

async function creativesOf(tab, advertiserId) {
  await goto(tab, `${BASE}/advertiser/${advertiserId}?region=${REGION}`);
  await sleep(8000);
  let links = [];
  let stagnant = 0;
  for (let i = 0; i < 15 && stagnant < 3; i++) {
    const found = JSON.parse(await js(tab,
      `JSON.stringify([...new Set([...document.querySelectorAll('a[href*=creative]')].map(a=>a.getAttribute('href')))])`));
    if (found.length > links.length) { links = found; stagnant = 0; } else stagnant++;
    await js(tab, 'window.scrollTo(0,document.body.scrollHeight);1');
    await sleep(2500);
  }
  return links;
}

async function collectLinks(tab, domain) {
  let { reported, ids } = await advertiserIds(tab, domain);
  if (!ids.length) {               // the SPA had not rendered yet; one retry
    await sleep(4000);
    ({ reported, ids } = await advertiserIds(tab, domain));
  }
  const links = [];
  for (const id of ids) {
    for (const href of await creativesOf(tab, id)) if (!links.includes(href)) links.push(href);
  }
  return { reported, links, advertisers: ids.length };
}

async function selftest() {
  const sample = [
    'Advertentiedetails', 'Smart services Nederland',
    'De informatie over deze advertentie kan per locatie verschillen',
    'Getoond in: Nederland',
    'Voor het eerst getoond: 6 okt 2026',
    'Onderwerp (gelabeld door Google): Bedrijven en industrie',
    'Voor het laatst weergegeven: 11 okt 2026',
    'Indeling: Tekst', '1 van 2 varianten',
  ].join('\n');
  const fails = [];
  const ok = (c, m) => { if (!c) fails.push(m); };
  const c = parseCreative(sample);
  ok(c.advertiser === 'Smart services Nederland', `advertiser: ${c.advertiser}`);
  ok(c.firstShown === '6 okt 2026', `firstShown: ${c.firstShown}`);
  ok(c.lastShown === '11 okt 2026', `lastShown: ${c.lastShown}`);
  ok(c.format === 'Tekst', `format: ${c.format}`);
  ok(c.topic === 'Bedrijven en industrie', `topic: ${c.topic}`);
  ok(c.variants === 2, `variants: ${c.variants}`);
  // An ad with no data must yield nulls, never invented values.
  const empty = parseCreative('niets hier');
  ok(empty.firstShown === null && empty.format === null, 'empty page must parse to nulls');
  ok(empty.variants === 1, 'variant count defaults to 1');
  ok(daysLive('6 okt 2026', '11 okt 2026') === 6, `daysLive: ${daysLive('6 okt 2026', '11 okt 2026')}`);
  ok(daysLive('1 jan 2026', '31 dec 2026') === 365, `daysLive year: ${daysLive('1 jan 2026', '31 dec 2026')}`);
  ok(daysLive(null, '11 okt 2026') === null, 'missing date must be null, not NaN or 0');
  ok(daysLive('6 xxx 2026', '11 okt 2026') === null, 'unknown month must be null');

  const A = parseArgs;
  ok(A(['--limit', '3', 'a.nl']).domains.join() === 'a.nl', 'flag value must not become a domain');
  ok(A(['a.nl', '--limit', '3']).limit === 3, '--limit after domain');
  ok(A(['a.nl', '--limit', 'x']).error, '--limit x must error');
  ok(A(['a.nl', '--limit', '0']).error, '--limit 0 must error');
  ok(A(['--selftest']).selftest, '--selftest needs no domain');
  ok(A(['a.nl', '--bogus']).error, 'unknown flag must error');
  ok(A(['a.nl', '--csv']).error, 'missing value must error');
  ok(A(['a.nl', 'b.nl']).domains.length === 2, 'multiple domains');

  console.log('\natc selftest — metadata parser + args\n');
  if (fails.length) { fails.forEach((f) => console.error('  FAIL ' + f)); console.log('\nSELFTEST FAILED\n'); process.exitCode = 1; }
  else console.log('  ok    parseCreative, daysLive, parseArgs\n  passed\n');
}

const opts = parseArgs(argv);
if (opts.error) { console.error('atc: ' + opts.error); process.exit(2); }
if (opts.selftest) { await selftest(); process.exit(process.exitCode || 0); }
if (!opts.domains.length) {
  console.error('usage: node atc.mjs <domain> [more domains] [--shots dir] [--csv f] [--limit N]');
  console.error('       node atc.mjs --selftest');
  process.exit(2);
}
if (opts.shots) mkdirSync(opts.shots, { recursive: true });

const rows = [];
const tab = await openTab();
try {
  for (const domain of opts.domains) {
    const { reported, links, advertisers } = await collectLinks(tab, domain);
    console.log(`\n═══ ${domain} — ${reported} ads reported, ${links.length} reachable`
      + ` across ${advertisers} advertiser account${advertisers === 1 ? '' : 's'} ═══`);
    const todo = opts.limit ? links.slice(0, opts.limit) : links;
    for (const [i, href] of todo.entries()) {
      await goto(tab, BASE + href);
      await sleep(7000);
      let c = parseCreative(await js(tab, 'document.body.innerText'));
      if (!c.firstShown) {           // same cause: re-read rather than record "?"
        await sleep(5000);
        c = parseCreative(await js(tab, 'document.body.innerText'));
      }
      const days = daysLive(c.firstShown, c.lastShown);
      const id = (href.match(/creative\/(CR\d+)/) || [, 'unknown'])[1];
      let shot = '';
      if (opts.shots) {
        shot = `${opts.shots.replace(/\/$/, '')}/${domain}-${id}.png`;
        const r = await fetch(`${CF}/tabs/${tab}/screenshot?userId=${U}`);
        writeFileSync(shot, Buffer.from(await r.arrayBuffer()));
      }
      console.log(`  ${String(i + 1).padStart(2)}. ${(c.format || '?').padEnd(10)}`
        + `${(c.firstShown || '?').padEnd(13)}-> ${(c.lastShown || '?').padEnd(13)}`
        + `${days !== null ? String(days).padStart(4) + 'd' : '   ?'}`
        + `${c.variants > 1 ? '  ' + c.variants + ' varianten' : ''}`);
      rows.push({ domain, id, advertiser: c.advertiser, format: c.format, firstShown: c.firstShown,
        lastShown: c.lastShown, days, variants: c.variants, topic: c.topic, shot, url: BASE + href });
    }
  }
} finally { await closeTab(tab); }

if (!rows.length) {
  console.error('\natc: no creatives read. Nothing was measured.');
  process.exitCode = 1;
} else {
  const live = rows.filter((r) => r.days !== null).sort((a, b) => b.days - a.days);
  if (live.length) {
    console.log('\n═══ longest-running ads (survived longest = most likely working) ═══\n');
    for (const r of live.slice(0, 10)) {
      console.log(`  ${String(r.days).padStart(4)}d  ${r.domain.padEnd(26)} ${r.format || ''}  ${r.id}`);
    }
  }
}

if (opts.csv && rows.length) {
  const cols = ['domain', 'id', 'advertiser', 'format', 'firstShown', 'lastShown', 'days', 'variants', 'topic', 'shot', 'url'];
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  writeFileSync(opts.csv, [cols.join(','), ...rows.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\n'));
  console.log(`\n${opts.csv}: ${rows.length} creatives`);
}
