// ── Node-RED wrapper for function node `ac2.fn.disp` ─────────────────────────────────────
// scripts/build.js prepends AC2_CONFIG, nodered/merge-deep.js and src/ac2-core.js to this file.
// Inputs (msg.topic): bsf/hotwater/status, bsf/presence/state, bsf/ac/status, bsf/ac/plug_power,
//   state/<host>, state/<host>/status, bsf/ac2/cmd, bsf/ac/cmd (existing dashboard), bsf/weather/forecast, tick (30 s inject).
// Outputs (6):
//   [0] REAL Faikout command  command/<host>        (UNWIRED in Phase 1; also suppressed while dry_run)
//   [1] shadow                bsf/ac2/shadow        what it would send, always
//   [2] status                bsf/ac2/status        retained
//   [3] log                   bsf/ac2/log
//   [4] anomaly               bsf/ac2/anomaly       qos 1
//   [5] Faikout status poll   command/<host>/status read-only request, every tick
//   [6] manual preference log bsf/ac2/manual        qos 1 (also last 200 kept in flow context ac2_manual_log)

const cfg = mergeDeep(AC2_CONFIG, flow.get('ac2_cfg_overrides') || {});
const host = cfg.faikout_host;
const now = Date.now();
const topic = msg.topic || '';
let p = msg.payload;
if (typeof p === 'string') { try { p = JSON.parse(p); } catch (e) { /* keep string */ } }

const inp = flow.get('ac2_in') || {};
let mem = flow.get('ac2_mem') || freshMem();
const logs = [];
let evaluate = topic === 'tick';

if (topic === 'bsf/hotwater/status') {
  inp.solar = normalizeHw(p, now);
} else if (topic === 'bsf/weather/forecast') {
  // Open-Meteo forecast relayed by the farm iMac (scripts/ac2_weather.py). CC BY 4.0, Open-Meteo.com.
  if (p && p.today && typeof p.today.max_c === 'number') inp.forecast = { ts_ms: Date.parse(p.ts) || now, today: p.today, tomorrow: p.tomorrow || null };
} else if (topic === 'bsf/presence/coming_home') {
  // Farm Homecoming app (via scripts/ac2_homecoming.py): someone is driving home. Retained, so check its time.
  if (p && p.ts) inp.arrival = { ts_ms: Date.parse(p.ts) || 0, eta_min: p.eta_min };
} else if (topic === 'bsf/presence/state') {
  inp.presence = { ts_ms: now, anyone_home: !!(p && p.anyone_home === true) };
} else if (topic === 'bsf/ac/status') {
  if (p && typeof p.inside_temp === 'number') {
    inp.inside = { ts_ms: now - (Number(p.inside_temp_age_s) || 0) * 1000, c: p.inside_temp };
  }
} else if (topic === 'bsf/ac2/probe') {
  // Tuya inside probe, raw, from the farm iMac each minute (scripts/ac2_recorder.py). Offset applied in the core.
  if (p && typeof p.raw_c === 'number') inp.inside = { ts_ms: Date.parse(p.ts) || now, c: p.raw_c };
} else if (topic === 'bsf/ac2/room_ref') {
  // Reference room thermometer (Inkbird 4 on the fridge, via a second Pi and the farm iMac). ts = when it was read.
  if (p && typeof p.c === 'number') inp.room_ref = { ts_ms: Date.parse(p.ts) || 0, c: p.c, hum: typeof p.hum === 'number' ? p.hum : null, src: String(p.src || 'ref') };
} else if (topic === 'bsf/ac/plug_power') {
  const w = Number(p);
  if (isFinite(w)) inp.ac_draw = { ts_ms: now, w: w };
} else if (topic === 'state/' + host) {
  // RevK library: retained JSON while up, `false` (last will) when the Faikout drops off.
  const up = !(p === false || p === 'false' || (p && p.up === false));
  inp.faikout_up = up;
  if (inp.ac) inp.ac.online = up ? inp.ac.online : false;
  // Live heartbeat (~30 s). The Faikout publishes status on every change (livestatus), so while it is up the
  // last status is still the current one: keep it fresh. A retained heartbeat proves nothing (could be old).
  if (up && !msg.retain && inp.ac) inp.ac.ts_ms = now;
} else if (topic === 'state/' + host + '/status') {
  inp.ac = normalizeFaikout(p, now);
  // A retained status is a snapshot from whenever it was last published (maybe before a power
  // cut), so it is never "fresh". Only state/<host> {up:true} brings the Faikout back online.
  if (inp.ac && msg.retain) inp.ac.ts_ms = 0;
  if (inp.ac && inp.faikout_up === false) inp.ac.online = false;
} else if (topic === 'Faikout/' + host) {
  // Minute summary: same readings, as a value or [min, avg, max] when it moved during the minute.
  if (p && inp.ac && !msg.retain) {
    const v = function (x) { return Array.isArray(x) ? x[1] : x; };
    ['home', 'outside', 'hum', 'env'].forEach(function (k) { if (typeof v(p[k]) === 'number') inp.ac[k] = v(p[k]); });
    inp.ac.ts_ms = now;
  }
} else if (topic === 'bsf/ac2/cmd' || topic === 'bsf/ac/cmd') {
  // bsf/ac/cmd is the existing dashboard's AC panel (v1.x schema): translate it so the
  // AUTO / ON (boost) / OFF / +30 min buttons keep working with v2.
  let c = p;
  if (topic === 'bsf/ac/cmd') {
    c = null;
    if (p && p.action === 'set_mode') {
      const md = String(p.mode || '').toUpperCase();
      if (md === 'AUTO' || md === 'OFF') c = { cmd: 'set_mode', mode: md };
      else if (md === 'ON') c = { cmd: 'boost' };
      else if (md === 'SCHEDULE') { c = { cmd: 'set_mode', mode: 'AUTO' }; logs.push('SCHEDULE is not in v2 yet -> AUTO'); }
    } else if (p && p.action === 'extend_boost') {
      c = { cmd: 'extend_boost', minutes: (Number(p.add_sec) || 1800) / 60 };
    }
    if (!c) { flow.set('ac2_in', inp); return [null, null, null, [{ topic: 'bsf/ac2/log', payload: { ts: new Date(now).toISOString(), msg: 'dashboard cmd ignored by v2: ' + JSON.stringify(p) } }], null, null, null]; }
  }
  const r = applyCommand(cfg, mem, c, now);
  mem = r.mem;
  logs.push(r.log);
  evaluate = true;
} else if (topic !== 'tick') {
  return null;
}
flow.set('ac2_in', inp);

const out = [null, null, null, null, null, null, null];
// Just (re)started: retained inputs take a few seconds to arrive. Judging "stale" before the first solar
// reading would cut a running aircon on every redeploy, so wait up to 90 s for it.
const started = flow.get('ac2_start_ms') || 0;
if (evaluate && !inp.solar && now - started < 90000) {
  node.status({ fill: 'grey', shape: 'ring', text: 'starting: waiting for solar data' });
  evaluate = false;
}
if (evaluate) {
  const r = decide(cfg, inp, mem, now);
  mem = r.mem;
  flow.set('ac2_last_eval_ms', now);
  if (r.send) {
    const cmd = { topic: 'command/' + host, payload: JSON.stringify(r.send), qos: 1, retain: false };
    if (!cfg.dry_run) out[0] = cmd;
    out[1] = { topic: 'bsf/ac2/shadow', payload: { ts: r.status.ts, dry_run: !!cfg.dry_run, tier: r.tier, topic: cmd.topic, command: r.send } };
  }
  out[2] = { topic: 'bsf/ac2/status', payload: r.status, retain: true };
  r.logs.forEach(function (l) { logs.push(l); });
  if (r.anomalies.length) out[4] = r.anomalies.map(function (a) { return { topic: 'bsf/ac2/anomaly', payload: { ts: r.status.ts, key: a.key, msg: a.msg }, qos: 1 }; });
  if (topic === 'tick') out[5] = { topic: 'command/' + host + '/status', payload: '' };
  if (r.events.length) {
    const ring = (flow.get('ac2_manual_log') || []).concat(r.events).slice(-200);
    flow.set('ac2_manual_log', ring);
    out[6] = r.events.map(function (e) { return { topic: 'bsf/ac2/manual', payload: e, qos: 1, retain: false }; });
  }
  node.status({
    fill: r.guards.length ? 'red' : (r.status.ac_on ? 'green' : 'grey'),
    shape: cfg.dry_run ? 'ring' : 'dot',
    text: (cfg.dry_run ? 'DRY ' : '') + r.status.mode + ' / ' + r.tier + (r.status.soc !== null ? ' soc ' + r.status.soc : ''),
  });
}
flow.set('ac2_mem', mem);
if (logs.length) out[3] = logs.map(function (l) { return { topic: 'bsf/ac2/log', payload: { ts: new Date(now).toISOString(), msg: l } }; });
return out;
