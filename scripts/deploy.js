#!/usr/bin/env node
// Deploys AC v2 to the Cerbo's Node-RED (admin API, https://<cerbo-ip>:1881). Deployment type
// 'flows': only tabs containing a changed node restart (the AC v2 tab; the v1.15 tab only when its wire
// changes). Restarting the whole AC v2 tab re-subscribes its MQTT inputs so retained state is re-read.
//   node scripts/deploy.js            dry run: show what would change, deploy nothing
//   node scripts/deploy.js --go       back up live flows to backups/, then deploy
// Always builds LIVE (dry_run off, real outputs wired) and also disconnects AC v1.15's plug
// output (acv15.fn.disp out 0 -> link to the Tuya AC plug). The Faikout is powered by the AC, so
// v1.15 cutting the plug would take the Faikout offline. The v1.15 tab otherwise keeps running.
'use strict';
const fs = require('fs');
const path = require('path');
const https = require('https');
const { build } = require('./build');

const HOST = process.env.NODERED || 'https://venus.local:1881';
const V15_DISP = 'acv15.fn.disp';
const V15_PLUG_LINK = '6ed7e9e95e1e37ad';   // link out "acv15.link.plugCmd" -> bridge.tuya.ac (.114)
const agent = new https.Agent({ rejectUnauthorized: false }); // Cerbo uses a self-signed cert

// DEPLOY_VIA_CURL=1: macOS can block node from the LAN (local-network privacy, seen 20 Oct from a Claude
// session) while Apple's own curl still gets through. Same requests, sent by curl.
function reqCurl(method, url, body) {
  const { execFileSync } = require('child_process');
  const args = ['-sk', '--max-time', '30', '-X', method, '-H', 'Node-RED-API-Version: v2', '-w', '\n%{http_code}'];
  if (body) args.push('-H', 'Content-Type: application/json', '-H', 'Node-RED-Deployment-Type: flows', '--data-binary', '@-');
  const out = execFileSync('curl', args.concat(url), { input: body ? JSON.stringify(body) : '', maxBuffer: 64 * 1024 * 1024 }).toString('utf8');
  const i = out.lastIndexOf('\n');
  return Promise.resolve({ status: Number(out.slice(i + 1)), body: out.slice(0, i) });
}

function req(method, url, body) {
  if (process.env.DEPLOY_VIA_CURL) return reqCurl(method, url, body);
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const data = body ? JSON.stringify(body) : null;
    const r = https.request({ method, hostname: u.hostname, port: u.port, path: u.pathname, agent, timeout: 30000,
      headers: Object.assign({ 'Node-RED-API-Version': 'v2' }, data ? { 'Content-Type': 'application/json', 'Node-RED-Deployment-Type': 'flows', 'Content-Length': Buffer.byteLength(data) } : {}) }, (res) => {
      // Collect bytes and decode once: decoding per chunk turns a UTF-8 character split across chunks into U+FFFD.
      const parts = []; res.on('data', (c) => parts.push(c)); res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(parts).toString('utf8') }));
    });
    r.on('error', reject); r.on('timeout', () => r.destroy(new Error('timeout')));
    if (data) r.write(data);
    r.end();
  });
}

async function main() {
  const go = process.argv.includes('--go');
  const got = await req('GET', HOST + '/flows');
  if (got.status !== 200) throw new Error('GET /flows ' + got.status + ' ' + got.body.slice(0, 200));
  const live = JSON.parse(got.body);
  const b = build({ live: true });

  const kept = live.flows.filter((n) => !(n.id === 'ac2.tab' || n.z === 'ac2.tab'));
  const removed = live.flows.length - kept.length;
  const disp = kept.find((n) => n.id === V15_DISP);
  if (!disp) throw new Error(V15_DISP + ' not found in deployed flows');
  const before = JSON.stringify(disp.wires[0]);
  disp.wires[0] = disp.wires[0].filter((w) => w !== V15_PLUG_LINK);
  // Stamp the deploy time into the tab's comment: shows when it was last deployed, and guarantees the AC v2
  // tab really restarts (Node-RED skips unchanged flows), so restart behaviour is exercised on every deploy.
  const note = b.flow.find((n) => n.id === 'ac2.comment.phase');
  if (note) note.name += ' · deployed ' + new Date().toISOString().slice(0, 16).replace('T', ' ') + 'Z';
  const next = kept.concat(b.flow);

  console.log('deployed rev       ', live.rev);
  console.log('ac2 nodes replaced ', removed, '-> new', b.flow.length);
  console.log('v1.15 disp out0    ', before, '->', JSON.stringify(disp.wires[0]));
  console.log('ac2 dispatcher out0', JSON.stringify(b.flow.find((n) => n.id === 'ac2.fn.disp').wires[0]), ' dry_run', b.cfg.dry_run);
  if (!go) { console.log('\n(dry run: nothing deployed; add --go)'); return; }

  const dir = path.join(__dirname, '..', 'backups');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15);
  const bk = path.join(dir, 'flows_pre_deploy_' + stamp + '.json');
  fs.writeFileSync(bk, JSON.stringify(live));
  console.log('backup             ', bk);

  const put = await req('POST', HOST + '/flows', { rev: live.rev, flows: next });
  console.log('POST /flows        ', put.status, put.body.slice(0, 200));
  if (put.status !== 200) process.exit(1);

  const check = JSON.parse((await req('GET', HOST + '/flows')).body);
  const d = check.flows.find((n) => n.id === 'ac2.fn.disp');
  const v = check.flows.find((n) => n.id === V15_DISP);
  console.log('verify: ac2 disp body matches build:', d && d.func === b.dispPaste, '| v1.15 plug link wired:', v.wires[0].includes(V15_PLUG_LINK), '| new rev', check.rev);
}

main().catch((e) => { console.error('deploy failed:', e.message); process.exit(1); });
