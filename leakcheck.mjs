#!/usr/bin/env node
/**
 * Proves the browser cannot reveal the host IP. Run it after every proxy change.
 *
 *   node leakcheck.mjs                 # server must be running
 *   node leakcheck.mjs --expect 1.2.3.4   # or let it ask the proxy itself
 *   node leakcheck.mjs --selftest         # test the checker's own logic, offline
 *
 * Checks, in order of how often they are the thing that actually leaks:
 *   1. HTTP exit IP        - the only one most people test
 *   2. WebRTC / STUN       - the classic Firefox leak, invisible in HTTP tests
 *   3. IPv6                - proxy is usually v4-only; v6 traffic walks past it
 *   4. DNS / exit geo      - resolver location gives away the real network
 *
 * EVERY CHECK FAILS CLOSED. A probe that could not reach its endpoint reports
 * INCONC and fails the run. An earlier version of this file let three checks
 * pass on no data at all -- `undefined !== realIP` is true, so a dead probe
 * looked exactly like a clean result. A leak test that cannot fail is worse
 * than no leak test, because it manufactures confidence.
 *
 * Exit: 0 only if every check conclusively passed.
 */
const CF = process.env.CF || 'http://localhost:9377';
const U = 'leakcheck';
const arg = (n) => { const i = process.argv.indexOf(n); return i < 0 ? null : process.argv[i + 1]; };

const api = async (path, opts = {}) => {
  const r = await fetch(CF + path, {
    ...opts,
    headers: { 'content-type': 'application/json', ...(opts.headers || {}) },
  });
  const t = await r.text();
  try { return JSON.parse(t); } catch { return { raw: t }; }
};

const js = async (tab, expression) => {
  const r = await api(`/tabs/${tab}/evaluate`, {
    method: 'POST',
    body: JSON.stringify({ userId: U, expression }),
  });
  if (!r.ok) throw new Error(r.error || JSON.stringify(r));
  return typeof r.result === 'string' ? r.result : JSON.stringify(r.result);
};

/** Load a URL in the browser and return its body text, or null if it did not load. */
async function browserGet(tab, url) {
  try {
    await api(`/tabs/${tab}/navigate`, {
      method: 'POST', body: JSON.stringify({ userId: U, url }),
    });
    return await js(tab, 'document.body.innerText');
  } catch { return null; }
}

const asJSON = (s) => { try { return JSON.parse(s); } catch { return null; } };

/**
 * The host's real addresses, fetched OUTSIDE the browser. These are the needles.
 *
 * Both families, deliberately. Comparing a v6 answer against a v4-only needle
 * can never match, which is how the previous version managed to approve the
 * very leak it was named after.
 */
async function hostIPs() {
  const one = async (url) => {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(15000) });
      return (await r.json()).ip || null;
    } catch { return null; }
  };
  const [v4, any] = await Promise.all([
    one('https://api.ipify.org?format=json'),
    one('https://api64.ipify.org?format=json'),
  ]);
  return [...new Set([v4, any].filter(Boolean))];  // api64 returns v4 on a v4-only host
}

const isV6 = (ip) => typeof ip === 'string' && ip.includes(':');

/**
 * Ask the configured proxy, directly, what IP it exits from -- so --expect does
 * not have to be typed by hand (and cannot be typo'd into a false pass).
 *
 * Goes out through curl rather than fetch: node's fetch has no proxy support,
 * and this must NOT share the browser's path -- the whole point is to obtain
 * an independent answer to compare the browser against.
 * Returns null when no proxy is configured; the run then just has no --expect.
 */
async function proxyExitIP() {
  const host = process.env.PROXY_HOST || process.env.PROXY_BACKCONNECT_HOST;
  const port = process.env.PROXY_PORT || process.env.PROXY_BACKCONNECT_PORT || '7000';
  if (!host) return null;
  const proto = process.env.PROXY_PROTOCOL || 'http';
  const user = process.env.PROXY_USERNAME;
  const pass = process.env.PROXY_PASSWORD;
  const auth = user ? `${encodeURIComponent(user)}:${encodeURIComponent(pass || '')}@` : '';
  const url = `${proto}://${auth}${host}:${port}`;
  const { execFile } = await import('node:child_process');
  return new Promise((resolve) => {
    execFile('curl', ['-s', '--max-time', '20', '-x', url, 'https://api.ipify.org?format=json'],
      (err, stdout) => {
        if (err) return resolve(null);
        try { resolve(JSON.parse(stdout).ip || null); } catch { resolve(null); }
      });
  });
}

const results = [];
const PASS = 'ok  ', FAIL = 'LEAK', INCONC = 'INCONC';
const record = (state, name, detail) => {
  results.push({ state, name, detail });
  console.log(`  ${state.padEnd(6)} ${name.padEnd(22)} ${detail}`);
};

/* ── decision logic, kept pure so it can be tested ──────────────────────────
 * Three of the bugs found in review were false passes in exactly this code:
 * `undefined !== realIP` is true, so a dead probe read as a clean result. The
 * failure mode of a leak checker is silence, which is why these are separate
 * functions with a --selftest rather than conditions buried in main().
 */
export function classifyExit(ip, needles, expect) {
  if (!ip) return [INCONC, 'probe did not return an IP'];
  if (needles.includes(ip)) return [FAIL, `${ip} is this host`];
  if (expect && ip !== expect) return [FAIL, `${ip} but expected ${expect}`];
  return [PASS, ip];
}

export function classifyWebrtc(webrtc, needles) {
  if (!webrtc) return [INCONC, 'probe did not run'];
  const pub = (webrtc.ips || []).filter(
    (ip) => !/^(10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|fe80:|::1)/i.test(ip));
  const bad = pub.filter((ip) => needles.includes(ip));
  if (bad.length) return [FAIL, bad.join(', ')];
  return [PASS, webrtc.blocked ? 'peerconnection disabled'
    : (pub.length ? pub.join(', ') : 'no public candidates')];
}

export function classifyV6(ip, needles, expect) {
  if (!ip) return [INCONC, 'probe did not return an IP'];
  if (needles.includes(ip)) return [FAIL, `${ip} is this host`];
  // Exited over v6 while the proxy named is v4: that connection did not go
  // through it, even though the address is not ours.
  if (isV6(ip) && expect && !isV6(expect)) {
    return [FAIL, `${ip} is v6 but proxy ${expect} is v4 - traffic bypassed it`];
  }
  return [PASS, ip];
}

export function classifyGeo(geo, needles) {
  if (!geo?.ip) return [INCONC, 'lookup failed or was rate-limited'];
  if (needles.includes(geo.ip)) return [FAIL, `${geo.ip} is this host`];
  return [PASS, `${geo.ip} ${geo.city || ''} ${geo.country_name || ''} ${geo.org || ''}`.trim()];
}

function selftest() {
  const N = ['9.9.9.9', '2a02:dead::1'];
  const eq = (got, want, label) => {
    if (got[0] !== want) { console.error(`FAIL ${label}: got ${got[0]} (${got[1]}), want ${want}`); process.exitCode = 1; }
    else console.log(`  ok    ${label}`);
  };
  console.log('\nleakcheck selftest - the checker\'s own decision logic\n');

  eq(classifyExit(null, N), INCONC, 'dead exit probe is INCONC, not a pass');
  eq(classifyExit('9.9.9.9', N), FAIL, 'exit ip equal to host is a leak');
  eq(classifyExit('1.2.3.4', N), PASS, 'exit ip via proxy passes');
  eq(classifyExit('5.6.7.8', N, '1.2.3.4'), FAIL, '--expect mismatch FAILS (was only a warning)');
  eq(classifyExit('1.2.3.4', N, '1.2.3.4'), PASS, '--expect match passes');

  eq(classifyWebrtc(null, N), INCONC, 'dead webrtc probe is INCONC');
  eq(classifyWebrtc({ blocked: true, ips: [] }, N), PASS, 'blocked peerconnection passes');
  eq(classifyWebrtc({ blocked: false, ips: ['192.168.1.5'] }, N), PASS, 'private candidate is not a leak');
  eq(classifyWebrtc({ blocked: false, ips: ['9.9.9.9'] }, N), FAIL, 'host ip in candidates is a leak');

  eq(classifyV6(null, N), INCONC, 'dead v6 probe is INCONC');
  eq(classifyV6('2a02:dead::1', N), FAIL, 'host v6 caught - needs the v6 needle, not just v4');
  eq(classifyV6('2a02:cafe::9', N, '1.2.3.4'), FAIL, 'v6 exit while proxy is v4 means bypass');
  eq(classifyV6('1.2.3.4', N, '1.2.3.4'), PASS, 'v4 exit via v4 proxy passes');

  eq(classifyGeo(null, N), INCONC, 'failed geo lookup is INCONC, not a pass');
  eq(classifyGeo({}, N), INCONC, 'empty geo body is INCONC');
  eq(classifyGeo({ ip: '9.9.9.9' }, N), FAIL, 'geo reporting host ip is a leak');
  eq(classifyGeo({ ip: '1.2.3.4', city: 'Rotterdam' }, N), PASS, 'geo via proxy passes');

  console.log(process.exitCode ? '\nSELFTEST FAILED\n' : '\nselftest passed\n');
}

async function main() {
  const needles = await hostIPs();
  if (!needles.length) {
    console.error('leakcheck: cannot determine this host\'s own public IP, so there is');
    console.error('           nothing to compare against. Refusing to report a pass.');
    process.exitCode = 2;
    return;
  }
  const expect = arg('--expect') || await proxyExitIP();
  console.log(`\nHost IPs (must appear nowhere below): ${needles.join(', ')}`);
  if (expect) {
    const how = process.argv.includes('--expect') ? 'from --expect' : 'asked the proxy directly';
    console.log(`Required proxy exit IP:               ${expect}  (${how})`);
  } else {
    console.log('Required proxy exit IP:               none - no proxy configured, or it did');
    console.log('                                      not answer. Checks below still run.');
  }
  console.log();

  const health = await api('/health');
  if (!health.ok) throw new Error('server not reachable at ' + CF);

  const { tabId: tab } = await api('/tabs', {
    method: 'POST', body: JSON.stringify({ userId: U, sessionKey: 'leak' }),
  });
  if (!tab) throw new Error('could not open a tab');

  try {
    // 1. HTTP exit IP. With --expect this is an assertion, not a note: an exit
    //    through some third proxy is not the configuration you asked to verify.
    const httpBody = asJSON(await browserGet(tab, 'https://api.ipify.org?format=json'));
    const httpIP = httpBody?.ip || null;
    const [exitState, exitDetail] = classifyExit(httpIP, needles, expect);
    record(exitState, 'http exit ip', exitDetail);

    // 2. WebRTC. Gather ICE candidates and read every address out of them.
    //    A disabled peerconnection throws; that is a pass, not an error.
    const webrtc = asJSON(await js(tab, `
      (async () => {
        if (!window.RTCPeerConnection) return { blocked: true, ips: [] };
        try {
          const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
          pc.createDataChannel('x');
          const ips = new Set();
          pc.onicecandidate = (e) => {
            if (!e.candidate) return;
            const m = e.candidate.candidate.match(/([0-9]{1,3}(\\.[0-9]{1,3}){3}|[a-f0-9:]{10,})/gi);
            (m || []).forEach((ip) => ips.add(ip));
          };
          await pc.setLocalDescription(await pc.createOffer());
          await new Promise((r) => setTimeout(r, 4000));
          pc.close();
          return { blocked: false, ips: [...ips] };
        } catch (e) { return { blocked: true, ips: [], err: String(e) }; }
      })()
    `));
    record(...[classifyWebrtc(webrtc, needles)].map(([st, d]) => [st, 'webrtc', d])[0]);

    // 3. IPv6. api64 prefers v6 where the client has it, so this is the probe
    //    that catches a v4-only proxy being walked past by AAAA traffic.
    const v6Body = asJSON(await browserGet(tab, 'https://api64.ipify.org?format=json'));
    const v6IP = v6Body?.ip || null;
    record(...[classifyV6(v6IP, needles, expect)].map(([st, d]) => [st, 'ipv6 path', d])[0]);

    // 4. Exit geo. Confirms where the far end believes you are.
    const geo = asJSON(await browserGet(tab, 'https://ipapi.co/json/'));
    record(...[classifyGeo(geo, needles)].map(([st, d]) => [st, 'geo of exit', d])[0]);

    console.log();
    const leaks = results.filter((r) => r.state === FAIL);
    const unknown = results.filter((r) => r.state === INCONC);
    if (leaks.length) {
      console.log(`FAILED - host IP or a bypassed path via: ${leaks.map((l) => l.name).join(', ')}\n`);
      process.exitCode = 1;
    } else if (unknown.length) {
      console.log(`INCONCLUSIVE - could not verify: ${unknown.map((u) => u.name).join(', ')}`);
      console.log('Treat this as a failure. Re-run; if a probe stays unreachable, find out why');
      console.log('before trusting the setup.\n');
      process.exitCode = 1;
    } else {
      console.log('PASSED - host IP appeared in none of the checks.\n');
      console.log('Still not covered here, and you must do it by hand:');
      console.log('  * pull the proxy (firewall it) mid-session and re-run: traffic must FAIL,');
      console.log('    never fall through to direct. That is the only real kill-switch test.');
      console.log('  * the server\'s own fetches (camoufox download, GeoIP db) do not use the');
      console.log('    proxy - only browser traffic does.\n');
    }
  } finally {
    await fetch(`${CF}/tabs/${tab}?userId=${U}`, { method: 'DELETE' }).catch(() => {});
  }
}

if (process.argv.includes('--selftest')) selftest();
else main().catch((e) => { console.error('leakcheck failed:', e.message); process.exitCode = 2; });
