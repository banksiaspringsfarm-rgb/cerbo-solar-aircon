// node --test   (no dependencies)
// Integration tests run the BUILT Node-RED paste in a sandbox (sim/harness.js), so they cover
// the wrapper wiring as well as the decision core.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { NodeRedSim, FakeFaikout } = require('../sim/harness');
const { build } = require('../scripts/build');
const { replay } = require('../sim/run');

const MIN = 60000;
const at = (hh, mm) => Date.UTC(2026, 0, 15, hh - 10, mm || 0); // 15 Jan, AEST local time
const SUNSET = new Date(Date.UTC(2026, 0, 15, 8, 45)).toISOString(); // 18:45 local

function hw(sim, over) {
  return Object.assign({ ts: new Date(sim.clock.now).toISOString(), soc: 99, surplus_now: 2500, surplus_smooth: 2500, ac_load: 900, curtailed: true, plug_power: 0, sunset_iso: SUNSET }, over || {});
}

// Drive `minutes` of 30 s ticks with a fake Faikout that applies real-output commands.
function drive(sim, fk, minutes, hwOver, opts) {
  opts = opts || {};
  const sent = [];
  for (let s = 0; s < minutes * 2; s++) {
    sim.clock.now += 30000;
    if (!opts.noSolar) sim.send('bsf/hotwater/status', hw(sim, typeof hwOver === 'function' ? hwOver(sim) : hwOver));
    sim.send('state/' + sim.host + '/status', fk.status());
    const out = sim.tick();
    if (out[0]) { fk.apply(out[0].payload); sent.push(JSON.parse(out[0].payload)); }
  }
  return sent;
}

// Tests pin the setpoints they were written against (the owner's targets change; the logic under test does not).
function newSim(start, over) {
  // FakeFaikout's 'home' is the true room temperature here: the idle-sensor correction is off unless a test turns it on.
  const sim = new NodeRedSim({ start: start || at(10), overrides: Object.assign({ dry_run: false, sensors: { ac_idle_offset_c: 0, ac_heat_offset_c: 0, heat_setpoint_add_c: 0 }, setpoints: { heat: { need_below_c: 19, comfort_c: 22, soak_c: 23, battery_c: 21, eco_c: 19 }, cool: { need_above_c: 26, comfort_c: 23, soak_c: 21, battery_c: 24, eco_c: 26 } }, tiers: { fresh_air: { enabled: false }, night: { hot_above_c: 26.5 } }, forecast: { hot_need_above_c: 25 }, presets: { warm_room_c: 24 }, season: { shoulder_cool_if_home_above_c: 24, shoulder_cool_day_max_c: 24 } }, over || {}) });
  sim.send('bsf/presence/state', { anyone_home: true });
  return sim;
}

test('soak: sustained curtailed surplus at high SOC pre-cools to the soak setpoint', () => {
  const sim = newSim(), fk = new FakeFaikout({ home: 27 });
  const sent = drive(sim, fk, 5);
  assert.deepStrictEqual(sent[0], { power: true, mode: 'C', temp: 21, fan: 'A' });
  assert.strictEqual(sim.mem.tier, 'soak');
});

test('hysteresis: a 60 s burst of surplus does not start the AC (needs 90 s sustained)', () => {
  const sim = newSim(), fk = new FakeFaikout({ home: 27 });
  const sent = drive(sim, fk, 1);                                         // 60 s good
  sent.push(...drive(sim, fk, 5, { curtailed: false, surplus_smooth: 0 })); // then nothing
  assert.strictEqual(sent.length, 0);
});

test('guard: stale solar state turns the AC OFF immediately, even inside min-run', () => {
  const sim = newSim(), fk = new FakeFaikout({ home: 27 });
  drive(sim, fk, 5);
  assert.strictEqual(fk.s.power, true);
  const sent = drive(sim, fk, 3, null, { noSolar: true });                // feed stops
  assert.deepStrictEqual(sent[0], { power: false });
  assert.strictEqual(fk.s.power, false);
  assert.ok(sim.mem.tier === 'guard');
});

test('guard: SOC below floor turns the AC OFF and a later recovery waits for sustain', () => {
  const sim = newSim(), fk = new FakeFaikout({ home: 27 });
  drive(sim, fk, 5);
  const sent = drive(sim, fk, 1, { soc: 74 });
  assert.deepStrictEqual(sent[0], { power: false });
});

test('min-run: losing surplus 5 min after start does not stop it; after 20 min it does', () => {
  const sim = newSim(), fk = new FakeFaikout({ home: 27 });
  drive(sim, fk, 3);
  assert.strictEqual(fk.s.power, true);
  let sent = drive(sim, fk, 10, { curtailed: false, surplus_smooth: -500, soc: 92 });
  assert.strictEqual(sent.length, 0, 'held on by min-run');
  sent = drive(sim, fk, 15, { curtailed: false, surplus_smooth: -500, soc: 92 });
  assert.deepStrictEqual(sent[0], { power: false });
});

test('min-off: after stopping it will not restart for 10 min', () => {
  const sim = newSim(), fk = new FakeFaikout({ home: 27 });
  drive(sim, fk, 3);
  const dry = { curtailed: false, surplus_smooth: -500, soc: 92 };
  for (let i = 0; i < 120 && fk.s.power; i++) drive(sim, fk, 0.5, dry);   // until it stops
  assert.strictEqual(fk.s.power, false);
  const offAt = sim.clock.now;
  let onAfter = null;
  for (let i = 0; i < 30 && onAfter === null; i++) {   // surplus back straight away
    drive(sim, fk, 0.5);
    if (fk.s.power) onAfter = sim.clock.now - offAt;
  }
  assert.ok(onAfter !== null, 'restarts eventually');
  assert.ok(onAfter >= 10 * MIN, 'restarted after only ' + onAfter / 1000 + ' s');
});

test('manual remote change -> 60 min hold with no commands; SOC floor still cuts', () => {
  const sim = newSim(), fk = new FakeFaikout({ home: 27 });
  drive(sim, fk, 5);
  fk.s.temp = 26;                                    // someone uses the IR remote
  let sent = drive(sim, fk, 50);
  assert.strictEqual(sent.length, 0);
  assert.strictEqual(sim.mem.tier, 'manual_hold');
  assert.strictEqual(fk.s.temp, 26);
  sent = drive(sim, fk, 1, { soc: 70 });
  assert.deepStrictEqual(sent[0], { power: false }, 'battery guard beats the hold');
});

test('manual hold: stale solar does NOT override a person who turned it on by hand', () => {
  const sim = newSim(), fk = new FakeFaikout({ home: 27 });
  drive(sim, fk, 5);
  fk.s.power = false;                                 // remote off...
  drive(sim, fk, 2);
  fk.s.power = true;                                  // ...and back on by hand
  const sent = drive(sim, fk, 10, null, { noSolar: true });
  assert.strictEqual(sim.mem.tier, 'manual_hold');
  assert.strictEqual(sent.length, 0);
});

test('overnight below 87 % SOC: fan only (fresh air), never the compressor, even when hot', () => {
  const sim = newSim(at(4, 0)), fk = new FakeFaikout({ home: 30 });
  const sent = drive(sim, fk, 50, { soc: 86, curtailed: false, surplus_smooth: -300 });
  assert.ok(sent.length >= 1);
  sent.forEach((c) => assert.ok(c.power === false || c.mode === 'F', JSON.stringify(c)));
  assert.strictEqual(fk.s.mode, 'F');
  assert.strictEqual(fk.s.fan, 'Q');
});

test('overnight: really hot room (> 28 C) gets the compressor at 24 C; below 85 % it drops back to fan', () => {
  const sim = newSim(at(21, 0)), fk = new FakeFaikout({ home: 29 });
  const night = { soc: 90, curtailed: false, surplus_smooth: -300 };
  const sent = drive(sim, fk, 5, night);
  assert.deepStrictEqual(sent[0], { power: true, mode: 'C', temp: 24, fan: 'A' });
  assert.strictEqual(sim.mem.tier, 'night');
  drive(sim, fk, 25, night);
  drive(sim, fk, 5, Object.assign({}, night, { soc: 84 }));
  assert.strictEqual(sim.mem.tier, 'night_fan');
  assert.strictEqual(fk.s.mode, 'F');
  assert.strictEqual(fk.s.power, true);
});

test('overnight: a comfortable room (<= 22 C) gets nothing at all', () => {
  const sim = newSim(at(23, 0)), fk = new FakeFaikout({ home: 21.5 });
  assert.strictEqual(drive(sim, fk, 20, { soc: 95, curtailed: false, surplus_smooth: -300 }).filter((c) => c.power).length, 0);
});

test('evening (end of solar day -> 20:00): comfort 24 C on battery, stops at 85 %', () => {
  const sim = newSim(at(18, 30)), fk = new FakeFaikout({ home: 27 });
  const ev = { soc: 90, curtailed: false, surplus_smooth: -300 };
  let sent = drive(sim, fk, 5, ev);
  assert.deepStrictEqual(sent[0], { power: true, mode: 'C', temp: 24, fan: 'A' });
  assert.strictEqual(sim.mem.tier, 'evening');
  drive(sim, fk, 22, ev);
  sent = drive(sim, fk, 5, Object.assign({}, ev, { soc: 84 }));
  assert.deepStrictEqual(sent[0], { power: false });
});

test('morning warm-up runs in summer too when the house is cold (< 19 C)', () => {
  const sim = newSim(at(5, 30)), fk = new FakeFaikout({ home: 17 });   // unit left in cool
  const sent = drive(sim, fk, 5, { soc: 85, curtailed: false, surplus_smooth: -400 });
  assert.deepStrictEqual(sent[0], { power: true, mode: 'H', fan: 'A' }, 'mode first');
  assert.deepStrictEqual(sent[1], { power: true, mode: 'H', temp: 21, fan: 'A' }, 'then the setpoint');
});

test('night: a manual run at night is cut at 85 % SOC', () => {
  const sim = newSim(at(22, 0)), fk = new FakeFaikout({ home: 24, power: true, temp: 22 });
  let sent = drive(sim, fk, 10, { soc: 90, curtailed: false, surplus_smooth: -800 });
  assert.strictEqual(sent.length, 0, 'already-running AC adopted as manual, left alone');
  assert.strictEqual(sim.mem.tier, 'manual_hold');
  sent = drive(sim, fk, 1, { soc: 84, curtailed: false, surplus_smooth: -800 });
  assert.deepStrictEqual(sent[0], { power: false });
});

test('sunset handover: a day run carries straight on into EVENING without a stop/start', () => {
  const sunset = new Date(Date.UTC(2026, 0, 15, 8, 0)).toISOString();   // 18:00 local -> day window ends 16:30
  const sim = newSim(at(16, 0)), fk = new FakeFaikout({ home: 28 });
  drive(sim, fk, 10, { sunset_iso: sunset });
  assert.strictEqual(sim.mem.tier, 'soak');
  const sent = drive(sim, fk, 40, { sunset_iso: sunset, soc: 95, curtailed: false, surplus_smooth: -200 });
  assert.ok(!sent.some((c) => c.power === false), 'never switched off: ' + JSON.stringify(sent));
  assert.strictEqual(sim.mem.tier, 'evening');
  assert.strictEqual(fk.s.temp, 24);
});

test("yesterday's sunset is not trusted: window falls back to 16:00 (v1.15 midnight bug)", () => {
  const sim = newSim(at(16, 30)), fk = new FakeFaikout({ home: 30 });
  const yesterday = new Date(Date.UTC(2026, 0, 14, 8, 45)).toISOString();
  const sent = drive(sim, fk, 10, { sunset_iso: yesterday, soc: 86 });
  assert.strictEqual(sent.filter((c) => c.power).length, 0);
  assert.strictEqual(sim.mem.tier, 'window_closed');
});

test('boost: runs regardless of surplus, then reverts to AUTO; SOC floor cuts it', () => {
  const sim = newSim(at(20, 0)), fk = new FakeFaikout({ home: 30 });
  sim.send('bsf/hotwater/status', hw(sim, { curtailed: false, surplus_smooth: -400, soc: 90 }));
  const out = sim.send('bsf/ac2/cmd', { cmd: 'boost', minutes: 30 });
  fk.apply(out[0].payload);
  assert.strictEqual(fk.s.power, true);
  drive(sim, fk, 31, { curtailed: false, surplus_smooth: -400, soc: 86 });
  assert.strictEqual(sim.mem.mode, 'AUTO');
  assert.strictEqual(fk.s.power, false, 'after boost, 20:30 at 86 % is below the night start threshold');
  const o2 = sim.send('bsf/ac2/cmd', { cmd: 'boost', minutes: 60 });
  fk.apply(o2[0].payload);
  assert.strictEqual(fk.s.power, true);
  const sent = drive(sim, fk, 2, { curtailed: false, surplus_smooth: -400, soc: 74 });  // boost floor 75
  assert.deepStrictEqual(sent[sent.length - 1], { power: false });
  assert.strictEqual(sim.mem.mode, 'AUTO');
});

test('load cap: AC trips when house load > 4200 W and hot water is not drawing', () => {
  const sim = newSim(), fk = new FakeFaikout({ home: 27 });
  drive(sim, fk, 5);
  let sent = drive(sim, fk, 1, { ac_load: 4500, plug_power: 3000 });
  assert.strictEqual(sent.length, 0, 'HW drawing: HW dispatcher sheds first');
  sent = drive(sim, fk, 1, { ac_load: 4500, plug_power: 0 });
  assert.deepStrictEqual(sent[0], { power: false });
});

test('dry run: never emits on the real command output, but shadows the command', () => {
  const sim = new NodeRedSim({ start: at(10), overrides: { dry_run: true } });
  const fk = new FakeFaikout({ home: 27 });
  let shadows = 0;
  for (let s = 0; s < 20; s++) {
    sim.clock.now += 30000;
    sim.send('bsf/hotwater/status', hw(sim));
    sim.send('state/daikin1/status', fk.status());
    const out = sim.tick();
    assert.strictEqual(out[0], null);
    if (out[1]) { shadows++; assert.strictEqual(out[1].payload.topic, 'command/daikin1'); assert.strictEqual(out[1].payload.dry_run, true); }
    assert.strictEqual(out[5].topic, 'command/daikin1/status');
  }
  assert.ok(shadows >= 1);
});

test('Faikout offline (last will false): one anomaly, not one per tick', () => {
  const sim = newSim(), fk = new FakeFaikout({ home: 27 });
  drive(sim, fk, 2);
  sim.send('state/daikin1', false);
  let anoms = 0;
  for (let i = 0; i < 10; i++) { sim.clock.now += 30000; sim.send('bsf/hotwater/status', hw(sim)); const o = sim.tick(); if (o[4]) anoms += o[4].filter((a) => a.payload.key === 'AC_OFFLINE').length; }
  assert.strictEqual(anoms, 1);
});

test('command not applied (Faikout ignores it): retried, then an anomaly', () => {
  const sim = newSim(), fk = new FakeFaikout({ home: 27 });
  let tries = 0, anomaly = false;
  for (let s = 0; s < 40; s++) {
    sim.clock.now += 30000;
    sim.send('bsf/hotwater/status', hw(sim));
    sim.send('state/daikin1/status', fk.status());       // never applies anything
    const o = sim.tick();
    if (o[0]) tries++;
    if (o[4] && o[4].some((a) => a.payload.key === 'COMMAND_NOT_APPLIED')) anomaly = true;
  }
  assert.ok(tries >= 3, 'retried ' + tries);
  assert.ok(anomaly);
});

test('watchdog: dispatcher silent + AC on -> force OFF; leaves a boost alone', () => {
  const sim = newSim(), fk = new FakeFaikout({ home: 27 });
  drive(sim, fk, 5);
  sim.clock.now += 4 * MIN;                            // dispatcher stops ticking
  sim.send('state/daikin1/status', fk.status());
  const w = sim.watchdog();
  assert.deepStrictEqual(JSON.parse(w[0].payload), { power: false });
  assert.strictEqual(w[2].payload.key, 'WATCHDOG_FORCE_OFF');
  sim.flowStore.ac2_mem.mode = 'BOOST';
  assert.strictEqual(sim.watchdog(), null);
});

test('winter: morning warm-up heats from 05:00 above 80 % SOC, before any sun', () => {
  const start = Date.UTC(2026, 6, 14, 19, 0);          // 15 Jul 05:00
  const sim = newSim(start), fk = new FakeFaikout({ home: 14, mode: 'H' });
  const sent = drive(sim, fk, 5, { soc: 85, curtailed: false, surplus_smooth: -450, sunset_iso: new Date(Date.UTC(2026, 6, 15, 7, 5)).toISOString() });
  assert.deepStrictEqual(sent[0], { power: true, mode: 'H', temp: 21, fan: 'A' });
});

test('built flow: real command outputs unwired, broker reused, paste embedded', () => {
  const b = build();
  const byId = Object.fromEntries(b.flow.map((n) => [n.id, n]));
  assert.deepStrictEqual(byId['ac2.fn.disp'].wires[0], []);
  assert.deepStrictEqual(byId['ac2.fn.watchdog'].wires[0], []);
  assert.strictEqual(byId['ac2.fn.disp'].outputs, byId['ac2.fn.disp'].wires.length);
  assert.strictEqual(byId['ac2.fn.watchdog'].outputs, byId['ac2.fn.watchdog'].wires.length);
  assert.strictEqual(byId['ac2.fn.disp'].func, b.dispPaste);
  b.flow.filter((n) => /^mqtt /.test(n.type)).forEach((n) => assert.strictEqual(n.broker, 'hwv3.broker', n.id));
  b.flow.forEach((n) => (n.wires || []).flat().forEach((w) => assert.ok(byId[w], n.id + ' wires to missing ' + w)));
  assert.ok(!b.flow.some((n) => n.type === 'mqtt-broker'), 'must not import a second broker');
  assert.strictEqual(b.cfg.dry_run, true, 'shipped config must be dry_run');
});

test('replay of the real 2026-10-11/12 farm data: pre-cools the 35 C day, fan overnight, no thrash', () => {
  const r = replay(path.join(__dirname, 'fixtures/farm-2026-10-11_12.json'), 60);
  const on = r.timeline.filter((c) => c.cmd.power);
  const CFG = require('../config/ac2.config.json');                     // replay runs the shipped setpoints
  assert.ok(on.some((c) => c.tier === 'soak' && c.cmd.temp === CFG.setpoints.cool.soak_c), 'pre-cools on the curtailed day');
  assert.ok(r.timeline.length <= 8, 'commands: ' + r.timeline.length);
  on.forEach((c) => assert.ok(c.cmd.mode === 'C' || (c.cmd.mode === 'F' && c.tier === 'night_fan'), JSON.stringify(c)));
  on.filter((c) => c.tier === 'night' || c.tier === 'evening').forEach((c) => assert.strictEqual(c.cmd.temp, CFG.setpoints.cool.battery_c));
  assert.ok(!r.timeline.some((c, i) => i && !c.cmd.power && r.timeline[i + 1] && r.timeline[i + 1].cmd.power &&
    r.timeline[i + 1].t.localeCompare(c.t) >= 0 && r.timeline[i + 1].t.localeCompare(c.t) < 1), 'no off/on within the same minute');
});

test('existing dashboard buttons (bsf/ac/cmd, v1 schema) drive v2: ON = boost, OFF, AUTO, +30 min', () => {
  const sim = newSim(at(20, 0)), fk = new FakeFaikout({ home: 25 });
  sim.send('bsf/hotwater/status', hw(sim, { soc: 90, curtailed: false, surplus_smooth: -300 }));
  let o = sim.send('bsf/ac/cmd', { action: 'set_mode', mode: 'ON' });
  assert.strictEqual(sim.mem.mode, 'BOOST');
  assert.strictEqual(JSON.parse(o[0].payload).power, true);
  const until = sim.mem.boostUntil;
  sim.send('bsf/ac/cmd', { action: 'extend_boost', add_sec: 1800 });
  assert.strictEqual(sim.mem.boostUntil - until, 30 * MIN);
  o = sim.send('bsf/ac/cmd', { action: 'set_mode', mode: 'OFF' });
  assert.strictEqual(sim.mem.mode, 'OFF');
  sim.send('bsf/ac/cmd', { action: 'set_mode', mode: 'AUTO' });
  assert.strictEqual(sim.mem.mode, 'AUTO');
  o = sim.send('bsf/ac/cmd', { action: 'set_thresholds', on_c: 20 });
  assert.match(o[3][0].payload.msg, /ignored/);
});

test('live build wires both real command outputs to the Faikout command node; default build does not', () => {
  const live = build({ live: true }), shadow = build();
  const by = (b) => Object.fromEntries(b.flow.map((n) => [n.id, n]));
  assert.deepStrictEqual(by(live)['ac2.fn.disp'].wires[0], ['ac2.out.cmd']);
  assert.deepStrictEqual(by(live)['ac2.fn.watchdog'].wires[0], ['ac2.out.cmd']);
  assert.strictEqual(live.cfg.dry_run, false);
  assert.deepStrictEqual(by(shadow)['ac2.fn.disp'].wires[0], []);
  assert.strictEqual(by(live)['ac2.out.cmd'].topic, '', 'topic comes from msg.topic (command/daikin1)');
});

test('offline (LWT) beats a stale retained status that arrives after it (live bug 2026-10-12)', () => {
  const sim = newSim(at(22, 0));
  sim.send('bsf/hotwater/status', hw(sim, { soc: 90, curtailed: false }));
  sim.send('state/daikin1', { up: false, reason: 'LWT' });
  sim.disp({ topic: 'state/daikin1/status', payload: { online: true, power: true, mode: 'C', temp: 22, home: 24 }, retain: true });
  let o = sim.tick();
  assert.strictEqual(o[2].payload.ac_fresh, false);
  assert.ok(o[4] && o[4].some((a) => a.payload.key === 'AC_OFFLINE'));
  sim.send('state/daikin1', { up: true });
  sim.send('state/daikin1/status', { online: true, power: false, mode: 'C', temp: 22, home: 24 });
  o = sim.tick();
  assert.strictEqual(o[2].payload.ac_fresh, true);
});

test('dispatcher node clears cached inputs on start (initialize), keeps memory', () => {
  const n = build({ live: true }).flow.find((x) => x.id === 'ac2.fn.disp');
  assert.match(n.initialize, /flow\.set\('ac2_in', \{\}\)/);
  assert.ok(!/ac2_mem/.test(n.initialize.replace(/\/\/.*$/gm, '')));
});

// drive() variant that also collects bsf/ac2/manual events
function driveEv(sim, fk, minutes, hwOver) {
  const ev = [];
  for (let s = 0; s < minutes * 2; s++) {
    sim.clock.now += 30000;
    sim.send('bsf/hotwater/status', hw(sim, hwOver));
    sim.send('state/' + sim.host + '/status', fk.status());
    const out = sim.tick();
    if (out[0]) fk.apply(out[0].payload);
    if (out[6]) out[6].forEach((m) => ev.push(m.payload));
  }
  return ev;
}

test('manual log: three quick remote presses = ONE event (from what automation set -> final), with context', () => {
  const sim = newSim(), fk = new FakeFaikout({ home: 27, hum: 50, outside: 31 });
  driveEv(sim, fk, 5);                                // automation: soak cool 22
  fk.s.temp = 23; driveEv(sim, fk, 0.5);
  fk.s.temp = 24; driveEv(sim, fk, 0.5);
  fk.s.temp = 25;
  const ev = driveEv(sim, fk, 3);
  const ch = ev.filter((e) => e.type === 'manual_change');
  assert.strictEqual(ch.length, 1, JSON.stringify(ev));
  assert.deepStrictEqual(ch[0].from, { power: true, mode: 'C', temp: 21, fan: 'A' });
  assert.deepStrictEqual(ch[0].to, { power: true, mode: 'C', temp: 25, fan: 'A' });
  assert.strictEqual(ch[0].context.room_c, 27);
  assert.strictEqual(ch[0].context.outside_c, 31);
  assert.strictEqual(ch[0].context.hum, 50);
  assert.strictEqual(ch[0].context.soc, 99);
  assert.strictEqual(ch[0].context.auto_tier_before, 'soak');
});

test('manual log: a later change restarts the hour; hold_end records the outcome, then AUTO resumes', () => {
  const sim = newSim(), fk = new FakeFaikout({ home: 27 });
  driveEv(sim, fk, 5);
  fk.s.temp = 25;
  let ev = driveEv(sim, fk, 40);
  fk.s.power = false;                                 // 40 min later: turned off by hand
  ev = ev.concat(driveEv(sim, fk, 50));
  assert.strictEqual(sim.mem.tier, 'manual_hold', 'hour restarted by the second change');
  ev = ev.concat(driveEv(sim, fk, 15));
  const ch = ev.filter((e) => e.type === 'manual_change');
  const end = ev.filter((e) => e.type === 'hold_end');
  assert.strictEqual(ch.length, 2);
  assert.deepStrictEqual(ch[1].to, { power: false });
  assert.strictEqual(end.length, 1);
  assert.strictEqual(end[0].reason, 'hour_up');
  assert.strictEqual(end[0].changes, 2);
  assert.deepStrictEqual(end[0].final_setting, { power: false });
  assert.ok(end[0].minutes >= 100 && end[0].minutes <= 101, 'episode length ' + end[0].minutes);
  assert.strictEqual(fk.s.power, true, 'AUTO took over again after the hour');
});

test('manual log: AC found already running is recorded; a dashboard button ends the hold with a record', () => {
  const sim = newSim(at(22, 0)), fk = new FakeFaikout({ home: 25, power: true, temp: 22 });
  let ev = driveEv(sim, fk, 2, { soc: 92, curtailed: false, surplus_smooth: -800 });
  assert.strictEqual(ev[0].kind, 'found_running');
  assert.strictEqual(ev[0].from, null);
  const o = sim.send('bsf/ac/cmd', { action: 'set_mode', mode: 'AUTO' });
  assert.strictEqual(o[6][0].payload.type, 'hold_end');
  assert.strictEqual(o[6][0].payload.reason, 'cleared');
});

test('bedtime handover: evening run at 20:00 goes straight to fan-only, no stop/start', () => {
  const sim = newSim(at(19, 30)), fk = new FakeFaikout({ home: 27 });
  const ev = { soc: 90, curtailed: false, surplus_smooth: -300 };
  drive(sim, fk, 10, ev);
  assert.strictEqual(sim.mem.tier, 'evening');
  fk.s.home = 25;
  const sent = drive(sim, fk, 30, ev);
  assert.ok(!sent.some((c) => c.power === false), JSON.stringify(sent));
  assert.strictEqual(sim.mem.tier, 'night_fan');
  assert.strictEqual(fk.s.mode, 'F');
});

test('mode change sends the mode first, then the setpoint (Daikin keeps a setpoint per mode)', () => {
  const start = Date.UTC(2026, 6, 14, 19, 30);        // 15 Jul 05:30, cold house, unit left in cool 25
  const sim = newSim(start), fk = new FakeFaikout({ home: 14, mode: 'C', temp: 25, power: false });
  // Model the real unit: a mode change in the same command as a temp lands on the remembered setpoint.
  const remembered = { H: 18, C: 25 };
  const apply = fk.apply.bind(fk);
  fk.apply = (pl) => { const c = JSON.parse(pl); if (c.mode && c.mode !== fk.s.mode) { apply(JSON.stringify(Object.assign({}, c, { temp: remembered[c.mode] }))); } else apply(pl); };
  const sent = drive(sim, fk, 5, { soc: 85, curtailed: false, surplus_smooth: -400, sunset_iso: new Date(Date.UTC(2026, 6, 15, 7, 5)).toISOString() });
  assert.deepStrictEqual(sent[0], { power: true, mode: 'H', fan: 'A' });
  assert.deepStrictEqual(sent[1], { power: true, mode: 'H', temp: 21, fan: 'A' });
  assert.strictEqual(fk.s.temp, 21);
});

test('v2 never sends swing/louvre fields, so the position set on the remote is kept', () => {
  const sim = newSim(), fk = new FakeFaikout({ home: 27 });
  const sent = drive(sim, fk, 30).concat(drive(sim, fk, 30, { curtailed: false, surplus_smooth: -500, soc: 92 }));
  sent.forEach((c) => { assert.ok(!('swingv' in c) && !('swingh' in c), JSON.stringify(c)); });
});

// ---- 2026-10-13: damp guard, forecast, shared budget, bedroom sensor ----
function fcMsg(sim, max, rad){ const d = new Date(sim.clock.now + 600 * 60000).toISOString().slice(0, 10);
  return { ts: new Date(sim.clock.now).toISOString(), today: { date: d, max_c: max, min_c: 15, rad_mj: rad == null ? 25 : rad, cloud: 20, rain_prob: 5, hum: 50 } }; }

test('damp guard: humid but comfortable room -> dry mode at the room temperature (on spare solar)', () => {
  const sim = newSim(), fk = new FakeFaikout({ home: 23, hum: 78 });
  const sent = drive(sim, fk, 6, { soc: 95, curtailed: false, surplus_smooth: 1500 });
  assert.strictEqual(sim.mem.tier, 'dry');
  assert.strictEqual(fk.s.mode, 'D');
  assert.strictEqual(fk.s.temp, 23);
  assert.ok(sent.length >= 1);
});

test('damp guard: humid AND hot -> cooling wins (it dehumidifies too)', () => {
  const sim = newSim(), fk = new FakeFaikout({ home: 27, hum: 80 });
  drive(sim, fk, 6, { soc: 95, curtailed: false, surplus_smooth: 1500 });
  assert.strictEqual(sim.mem.tier, 'comfort');
  assert.strictEqual(fk.s.mode, 'C');
});

test('damp guard stops once the humidity is down to 55 %', () => {
  const sim = newSim(), fk = new FakeFaikout({ home: 23, hum: 78 });
  drive(sim, fk, 6, { soc: 95, curtailed: false, surplus_smooth: 1500 });
  fk.s.hum = 58;
  drive(sim, fk, 10, { soc: 95, curtailed: false, surplus_smooth: 1500 });
  assert.strictEqual(sim.mem.tier, 'dry', 'still drying at 58 %');
  fk.s.hum = 53;
  drive(sim, fk, 30, { soc: 95, curtailed: false, surplus_smooth: 1500 });
  assert.notStrictEqual(sim.mem.tier, 'dry');
});

test('forecast: a hot day pre-cools from 93 % instead of 97 %; a mild day does not pre-cool at all', () => {
  let sim = newSim(), fk = new FakeFaikout({ home: 24 });
  sim.send('bsf/weather/forecast', fcMsg(sim, 34));
  drive(sim, fk, 6, { soc: 94, curtailed: true, surplus_smooth: 1200 });
  assert.strictEqual(sim.mem.tier, 'soak');
  sim = newSim(); fk = new FakeFaikout({ home: 24 });
  sim.send('bsf/weather/forecast', fcMsg(sim, 21));
  drive(sim, fk, 6, { soc: 99, curtailed: true, surplus_smooth: 2500 });
  assert.notStrictEqual(sim.mem.tier, 'soak');
  assert.strictEqual(fk.s.power, false);
});

test('forecast: stale or yesterday forecast changes nothing', () => {
  const sim = newSim(), fk = new FakeFaikout({ home: 24 });
  const f = fcMsg(sim, 21); f.today.date = '2026-01-01';
  sim.send('bsf/weather/forecast', f);
  drive(sim, fk, 6);
  assert.strictEqual(sim.mem.tier, 'soak');
});

test('shared budget: the hot water gets first claim on spare solar, then the aircon may start', () => {
  const sim = newSim(), fk = new FakeFaikout({ home: 27 });
  const pending = { soc: 95, curtailed: true, surplus_smooth: 2500, mode: 'DISPATCH', hwState: 'off', plug_power: 0 };
  let sent = drive(sim, fk, 5, pending);
  assert.strictEqual(sent.filter((c) => c.power).length, 0, 'waits for the HW');
  sent = drive(sim, fk, 5, Object.assign({}, pending, { hwState: 'on', plug_power: 3100, surplus_smooth: -600 }));
  assert.strictEqual(sent.filter((c) => c.power).length, 1, 'HW running and solar still curtailed -> AC starts');
});

test('shared budget: stops waiting after 10 min if the HW never takes it', () => {
  const sim = newSim(), fk = new FakeFaikout({ home: 27 });
  const sent = drive(sim, fk, 14, { soc: 95, curtailed: true, surplus_smooth: 2500, mode: 'DISPATCH', hwState: 'off', plug_power: 0 });
  assert.ok(sent.some((c) => c.power), 'starts after the wait');
});

test('bedroom sensor: a BLE reference temperature (env) beats the head sensor', () => {
  const sim = newSim(), fk = new FakeFaikout({ home: 24, env: 27.5 });
  const out = (drive(sim, fk, 1), sim.tick());
  assert.strictEqual(out[2].payload.room_c, 27.5);
  assert.strictEqual(out[2].payload.room_src, 'ble');
});

test("the owner's bands: comfort on solar is the tight 23 C; a 27 C night room is outside 19-26 so the compressor runs", () => {
  let sim = newSim(), fk = new FakeFaikout({ home: 27 });
  const sent = drive(sim, fk, 5, { soc: 95, curtailed: false, surplus_smooth: 1200 });
  assert.strictEqual(sim.mem.tier, 'comfort');
  assert.deepStrictEqual(sent[0], { power: true, mode: 'C', temp: 23, fan: 'A' });
  sim = newSim(at(23, 0)); fk = new FakeFaikout({ home: 27 });
  const night = drive(sim, fk, 5, { soc: 92, curtailed: false, surplus_smooth: -300 });
  assert.deepStrictEqual(night[0], { power: true, mode: 'C', temp: 24, fan: 'A' });
});

test('idle Faikout: a live heartbeat keeps the retained status fresh (no "no room temp" after a redeploy)', () => {
  const sim = newSim(at(5, 30));
  sim.send('bsf/hotwater/status', hw(sim, { soc: 83, curtailed: false, surplus_smooth: -150 }));
  sim.disp({ topic: 'state/daikin1', payload: { up: true }, retain: true });
  sim.disp({ topic: 'state/daikin1/status', payload: { online: true, power: false, mode: 'F', temp: 22, home: 26.5, hum: 47 }, retain: true });
  let o = sim.tick();
  assert.strictEqual(o[2].payload.room_c, null, 'retained alone is not trusted');
  sim.clock.now += 30000;
  sim.disp({ topic: 'state/daikin1', payload: { up: true }, retain: false });
  sim.send('bsf/hotwater/status', hw(sim, { soc: 83, curtailed: false, surplus_smooth: -150 }));
  o = sim.tick();
  assert.strictEqual(o[2].payload.room_c, 26.5);
  assert.strictEqual(o[2].payload.ac_fresh, true);
  sim.disp({ topic: 'Faikout/daikin1', payload: { home: [26, 26.2, 26.5], hum: 49 }, retain: false });
  o = sim.tick();
  assert.strictEqual(o[2].payload.room_c, 26.2);
});

test('after a restart, no "stale" cut before the first solar reading arrives (90 s grace)', () => {
  const sim = new NodeRedSim({ start: at(13, 0), overrides: { dry_run: false } });
  sim.flowStore.ac2_start_ms = sim.clock.now;
  sim.send('state/daikin1', { up: true });
  sim.send('state/daikin1/status', { online: true, power: true, mode: 'C', temp: 23, home: 25 });
  sim.clock.now += 5000;
  const o = sim.tick();
  assert.strictEqual(o[0], null, 'no command during the grace');
  assert.strictEqual(o[2], null, 'no status either');
  sim.clock.now += 100000;
  const o2 = sim.tick();
  assert.ok(o2[2], 'evaluation resumes after the grace');
  assert.ok(o2[2].payload.guards.indexOf('STALE_SOLAR') >= 0, 'and still-missing solar data is flagged');
});

test('heading home: a hot house gets cooled to 23 C for up to 45 min, even at night on battery (>= 85 %)', () => {
  const sim = newSim(at(21, 30)), fk = new FakeFaikout({ home: 25.5 });
  sim.send('bsf/presence/coming_home', { ts: new Date(sim.clock.now).toISOString(), eta_min: 11 });
  const night = { soc: 90, curtailed: false, surplus_smooth: -300 };
  const sent = drive(sim, fk, 3, night);
  assert.strictEqual(sim.mem.tier, 'arrival');
  assert.deepStrictEqual(sent[0], { power: true, mode: 'C', temp: 23, fan: 'A' });
  drive(sim, fk, 45, night);
  assert.notStrictEqual(sim.mem.tier, 'arrival', 'window over after 45 min');
});

test('heading home: nothing happens if the house is already comfortable, or the battery is under 85 %', () => {
  let sim = newSim(at(21, 30)), fk = new FakeFaikout({ home: 23.5 });
  sim.send('bsf/presence/coming_home', { ts: new Date(sim.clock.now).toISOString(), eta_min: 11 });
  assert.strictEqual(drive(sim, fk, 3, { soc: 90, curtailed: false, surplus_smooth: -300 }).filter((c) => c.power && c.mode === 'C').length, 0);
  sim = newSim(at(21, 30)); fk = new FakeFaikout({ home: 26 });
  sim.send('bsf/presence/coming_home', { ts: new Date(sim.clock.now).toISOString(), eta_min: 11 });
  assert.strictEqual(drive(sim, fk, 3, { soc: 84, curtailed: false, surplus_smooth: -300 }).filter((c) => c.power && c.mode === 'C').length, 0);
});

test('heading home: an old retained message (from yesterday) does nothing', () => {
  const sim = newSim(at(21, 30)), fk = new FakeFaikout({ home: 26 });
  sim.send('bsf/presence/coming_home', { ts: new Date(sim.clock.now - 20 * 3600000).toISOString(), eta_min: 11 });
  drive(sim, fk, 3, { soc: 90, curtailed: false, surplus_smooth: -300 });
  assert.notStrictEqual(sim.mem.tier, 'arrival');
});

test('room temperature: the aircon sensor; while idle it is corrected for the warm-ceiling drift (15 Oct)', () => {
  const sim = newSim(at(21, 0), { sensors: { ac_idle_offset_c: -3.9, ac_idle_ramp_min: 12 } });
  sim.send('bsf/hotwater/status', hw(sim, { soc: 90, curtailed: false, surplus_smooth: -300 }));
  sim.send('bsf/ac/status', { inside_temp: 25.4, inside_temp_age_s: 5 });            // bedroom probe: ignored
  sim.send('state/daikin1/status', { online: true, power: true, mode: 'F', temp: 22, home: 19.0 });
  let o = sim.tick();
  assert.strictEqual(o[2].payload.room_c, 19);
  assert.strictEqual(o[2].payload.room_src, 'faikout');
  sim.send('state/daikin1/status', { online: true, power: false, mode: 'F', temp: 22, home: 19.2 });
  o = sim.tick();                                                                   // fan just stopped: no correction yet
  assert.strictEqual(o[2].payload.room_src, 'faikout_idle');
  assert.ok(Math.abs(o[2].payload.room_c - 19.2) < 0.2, String(o[2].payload.room_c));
  sim.clock.now += 6 * 60000;
  sim.send('state/daikin1/status', { online: true, power: false, mode: 'F', temp: 22, home: 21.2 });
  o = sim.tick();                                                                   // half way: 21.2 - 1.95
  assert.ok(Math.abs(o[2].payload.room_c - 19.25) < 0.2, String(o[2].payload.room_c));
  sim.clock.now += 20 * 60000;
  sim.send('state/daikin1/status', { online: true, power: false, mode: 'F', temp: 22, home: 23.0 });
  o = sim.tick();                                                                   // fully drifted: 23.0 - 3.9
  assert.strictEqual(o[2].payload.room_c, 19.1);
});

test('room temperature: while heating the aircon sensor is corrected by ac_heat_offset_c', () => {
  const sim = newSim(at(21, 0), { sensors: { ac_idle_offset_c: -3.9, ac_heat_offset_c: -2.0 } });
  sim.send('bsf/hotwater/status', hw(sim, { soc: 90, curtailed: false, surplus_smooth: -300 }));
  sim.send('state/daikin1/status', { online: true, power: true, mode: 'H', temp: 24, home: 21.0 });
  let o = sim.tick();
  assert.strictEqual(o[2].payload.room_c, 19);
  assert.strictEqual(o[2].payload.room_src, 'faikout_heat');
  sim.send('state/daikin1/status', { online: true, power: true, mode: 'C', temp: 24, home: 21.0 });
  o = sim.tick();
  assert.strictEqual(o[2].payload.room_c, 21);
});

test('room temperature: after a restart an idle aircon gets the full correction; the probe is never used while the aircon answers', () => {
  const sim = newSim(at(21, 0), { sensors: { ac_idle_offset_c: -3.9, ac_idle_ramp_min: 12 } });
  sim.send('bsf/hotwater/status', hw(sim, { soc: 90, curtailed: false, surplus_smooth: -300 }));
  sim.send('bsf/ac/status', { inside_temp: 25.4, inside_temp_age_s: 5 });
  sim.send('state/daikin1/status', { online: true, power: false, mode: 'F', temp: 22, home: 20.5 });
  const o = sim.tick();
  assert.strictEqual(o[2].payload.room_c, 16.6);
  assert.strictEqual(o[2].payload.room_src, 'faikout_idle');
});

test('15 Oct 06:24: a 16.5 C house on a forecast-warm October day -> boost HEATS (not Cool 23)', () => {
  const start = Date.UTC(2026, 9, 14, 20, 20);         // 15 Oct 06:20
  const sim = newSim(start, { sensors: { ac_idle_offset_c: -3.9, ac_idle_ramp_min: 12 } }), fk = new FakeFaikout({ home: 20.4, power: false, temp: 18 });
  sim.send('bsf/weather/forecast', { ts: new Date(start).toISOString(), today: { date: '2026-10-15', max_c: 25, min_c: 9, rad_mj: 24 } });
  drive(sim, fk, 2, { soc: 82, curtailed: false, surplus_smooth: 400 });
  sim.send('bsf/ac2/cmd', { cmd: 'boost' });
  const sent = drive(sim, fk, 2, { soc: 82, curtailed: false, surplus_smooth: 400 });
  const last = Object.assign({}, fk.s);                 // what the unit ends up on (mode first, then the setpoint)
  assert.ok(last && last.mode === 'H', JSON.stringify(sent));
  assert.strictEqual(last.temp, 24, 'room target 22 + the heating sensor trim 2 = 24 sent to the unit');
});

test('room temperature: the reference thermometer (Inkbird 4) wins while fresh; stale -> back to the aircon sensor', () => {
  const sim = newSim(at(21, 0));
  sim.send('bsf/hotwater/status', hw(sim, { soc: 90, curtailed: false, surplus_smooth: -300 }));
  sim.send('state/daikin1/status', { online: true, power: true, mode: 'H', temp: 21, home: 20.5 });
  sim.send('bsf/ac2/room_ref', { ts: new Date(sim.clock.now - 60000).toISOString(), c: 18.3, src: 'Inkbird 4' });
  let o = sim.tick();
  assert.strictEqual(o[2].payload.room_c, 18.3);
  assert.strictEqual(o[2].payload.room_src, 'ref');
  sim.clock.now += 11 * MIN;
  sim.send('bsf/hotwater/status', hw(sim, { soc: 90, curtailed: false, surplus_smooth: -300 }));
  sim.send('state/daikin1/status', { online: true, power: true, mode: 'H', temp: 21, home: 20.5 });
  o = sim.tick();
  assert.strictEqual(o[2].payload.room_src, 'faikout');
  assert.strictEqual(o[2].payload.room_c, 20.5);
});

const OCT15_SUNSET = new Date(Date.UTC(2026, 9, 15, 8, 10)).toISOString();   // 18:10 local

test('15 Oct afternoon: forecast fell 25 -> 16 C, house 20.5 C, 12 C out, battery full and curtailed -> it heats', () => {
  const start = Date.UTC(2026, 9, 14, 19, 0);          // 15 Oct 05:00
  const sim = newSim(start), fk = new FakeFaikout({ home: 20.5, outside: 12, power: false, temp: 18 });
  sim.send('bsf/weather/forecast', { ts: new Date(start).toISOString(), today: { date: '2026-10-15', max_c: 25, min_c: 9, rad_mj: 24 } });
  drive(sim, fk, 2, { soc: 85, curtailed: false, surplus_smooth: 0 });
  assert.strictEqual(sim.mem.season.value, 'cool', 'dawn: locked cool from the 25 C forecast');
  sim.clock.now = Date.UTC(2026, 9, 15, 1, 0);         // 11:00
  sim.send('bsf/weather/forecast', { ts: new Date(sim.clock.now).toISOString(), today: { date: '2026-10-15', max_c: 16, min_c: 9, rad_mj: 14 } });
  drive(sim, fk, 8, { soc: 100, curtailed: true, surplus_smooth: 2500, sunset_iso: OCT15_SUNSET });
  assert.strictEqual(fk.s.power, true);
  assert.strictEqual(fk.s.mode, 'H');
});

test('a season locked from the forecast is re-decided when the forecast moves 3 C or more (25 -> 16 C = heat)', () => {
  const start = Date.UTC(2026, 9, 14, 19, 0);
  const sim = newSim(start), fk = new FakeFaikout({ home: 22, outside: 20, power: false });
  sim.send('bsf/weather/forecast', { ts: new Date(start).toISOString(), today: { date: '2026-10-15', max_c: 25, min_c: 9, rad_mj: 24 } });
  drive(sim, fk, 1, { soc: 85, curtailed: false, surplus_smooth: 0 });
  assert.strictEqual(sim.mem.season.value, 'cool');
  sim.send('bsf/weather/forecast', { ts: new Date(sim.clock.now).toISOString(), today: { date: '2026-10-15', max_c: 23, min_c: 9, rad_mj: 24 } });
  drive(sim, fk, 1, { soc: 85, curtailed: false, surplus_smooth: 0 });
  assert.strictEqual(sim.mem.season.value, 'cool', 'a 2 C change keeps the lock');
  sim.send('bsf/weather/forecast', { ts: new Date(sim.clock.now).toISOString(), today: { date: '2026-10-15', max_c: 16, min_c: 9, rad_mj: 14 } });
  drive(sim, fk, 1, { soc: 85, curtailed: false, surplus_smooth: 0 });
  assert.strictEqual(sim.mem.season.value, 'heat');
});

test('cold outside: a 20.5 C room heats (comfort - 1 = 21 in the test setpoints) when it is 12 C out, not when 22 C out', () => {
  const run = (out, fcMax) => {
    const start = Date.UTC(2026, 9, 15, 1, 0);          // 15 Oct 11:00
    const sim = newSim(start), fk = new FakeFaikout({ home: 20.5, outside: out, power: false, temp: 18 });
    sim.send('bsf/weather/forecast', { ts: new Date(start).toISOString(), today: { date: '2026-10-15', max_c: fcMax, min_c: 9, rad_mj: 24 } });
    drive(sim, fk, 8, { soc: 100, curtailed: true, surplus_smooth: 2500, sunset_iso: OCT15_SUNSET });
    return fk.s.power && fk.s.mode;
  };
  assert.strictEqual(run(12, 24), 'H');
  assert.strictEqual(run(22, 26), false);
});

test('humidity: Inkbird 4 (true room air) is used when fresh: 78 % starts the damp guard though the aircon reads 55 %', () => {
  const sim = newSim(), fk = new FakeFaikout({ home: 23, hum: 55 });
  const ref = () => sim.send('bsf/ac2/room_ref', { ts: new Date(sim.clock.now).toISOString(), c: 23, hum: 78, src: 'Inkbird 4' });
  for (let i = 0; i < 6; i++) { ref(); drive(sim, fk, 1, { soc: 95, curtailed: false, surplus_smooth: 1500 }); }
  assert.strictEqual(sim.mem.tier, 'dry');
  assert.strictEqual(fk.s.mode, 'D');
});

test('night fan: any season, runs for a humid room even when it is cool, stops at 17 C', () => {
  const start = Date.UTC(2026, 6, 15, 11, 0);           // 15 Jul 21:00, winter
  const sim = newSim(start), fk = new FakeFaikout({ home: 19.5, outside: 6, hum: 72, power: false });
  sim.send('bsf/weather/forecast', { ts: new Date(start).toISOString(), today: { date: '2026-07-15', max_c: 15, min_c: 2, rad_mj: 12 } });
  drive(sim, fk, 5, { soc: 90, curtailed: false, surplus_smooth: -300 });
  assert.strictEqual(sim.mem.tier, 'night_fan');
  assert.strictEqual(fk.s.mode, 'F');
  fk.s.home = 16.8;                                    // battery 86 %: too low for the overnight heater, so only the floor stops the fan
  drive(sim, fk, 6, { soc: 86, curtailed: false, surplus_smooth: -300 });
  assert.notStrictEqual(sim.mem.tier, 'night_fan');   // (min-run may hold the fan a little longer; the tier has ended)
});

test('night fan: a dry 20 C room gets no fan (nothing to air out, not warm)', () => {
  const sim = newSim(at(22, 0)), fk = new FakeFaikout({ home: 20, hum: 50, power: false });
  drive(sim, fk, 5, { soc: 90, curtailed: false, surplus_smooth: -300 });
  assert.notStrictEqual(sim.mem.tier, 'night_fan');
});

test('evening: cold outside -> a 20.5 C room (below comfort - 1) is heated before bed (battery >= 87 %)', () => {
  const start = Date.UTC(2026, 9, 15, 8, 30);           // 15 Oct 18:30
  const sim = newSim(start), fk = new FakeFaikout({ home: 20.5, outside: 11, power: false, temp: 18 });
  sim.send('bsf/weather/forecast', { ts: new Date(start).toISOString(), today: { date: '2026-10-15', max_c: 16, min_c: 8, rad_mj: 14 } });
  drive(sim, fk, 5, { soc: 92, curtailed: false, surplus_smooth: -400, sunset_iso: OCT15_SUNSET });
  assert.strictEqual(sim.mem.tier, 'evening');
  assert.strictEqual(fk.s.mode, 'H');
});

test('hot outside: on solar a 25.5 C room is cooled (not waiting for 26)', () => {
  const start = Date.UTC(2026, 0, 15, 2, 0);            // 15 Jan 12:00
  const sim = newSim(start), fk = new FakeFaikout({ home: 25.5, outside: 31, power: false, temp: 26 });
  sim.send('bsf/weather/forecast', { ts: new Date(start).toISOString(), today: { date: '2026-01-15', max_c: 31, min_c: 18, rad_mj: 28 } });
  drive(sim, fk, 5, { soc: 92, curtailed: false, surplus_smooth: 1500 });
  assert.strictEqual(fk.s.power, true);
  assert.strictEqual(fk.s.mode, 'C');
});

// ---- presets (owner 18 Oct): warm / cool / fresh / off for 1 h, then AUTO ----
test('presets: warm heats the room to 24 (unit Heat 26), cool to 21, fresh = fan, off = off; each ends after 1 h', () => {
  for (const [name, expect] of [['warm', ['H', 26]], ['cool', ['C', 21]], ['fresh', ['F', undefined]], ['off', [null, null]]]) {
    const sim = newSim(at(14, 0), { sensors: { heat_setpoint_add_c: 2 } }), fk = new FakeFaikout({ home: 22, power: false, temp: 18 });
    drive(sim, fk, 1, { soc: 88, curtailed: false, surplus_smooth: 0 });
    sim.send('bsf/ac2/cmd', { cmd: 'preset', name: name, source: 'test' });
    drive(sim, fk, 3, { soc: 88, curtailed: false, surplus_smooth: 0 });
    assert.strictEqual(sim.mem.mode, 'PRESET', name);
    if (expect[0]) { assert.strictEqual(fk.s.power, true, name); assert.strictEqual(fk.s.mode, expect[0], name); if (expect[1] !== undefined) assert.strictEqual(fk.s.temp, expect[1], name); }
    else assert.strictEqual(fk.s.power, false, name);
    drive(sim, fk, 58, { soc: 88, curtailed: false, surplus_smooth: 0 });
    assert.strictEqual(sim.mem.mode, 'AUTO', name + ' back to AUTO after 1 h');
  }
});

test('presets: unknown name ignored; a hand change ends a preset with the normal hold; the battery floor cuts warm', () => {
  let sim = newSim(at(14, 0)), fk = new FakeFaikout({ home: 22, power: false, temp: 18 });
  sim.send('bsf/ac2/cmd', { cmd: 'preset', name: 'sauna' });
  assert.strictEqual(sim.mem.mode, 'AUTO');
  sim.send('bsf/ac2/cmd', { cmd: 'preset', name: 'warm' });
  drive(sim, fk, 4, { soc: 88, curtailed: false, surplus_smooth: 0 });
  fk.s.temp = 28;
  drive(sim, fk, 4, { soc: 88, curtailed: false, surplus_smooth: 0 });
  assert.strictEqual(sim.mem.mode, 'AUTO');
  assert.ok(sim.mem.manualHoldUntil > sim.clock.now, 'hand change -> manual hold');
  assert.strictEqual(fk.s.temp, 28);
  sim = newSim(at(14, 0)); fk = new FakeFaikout({ home: 18, power: false, temp: 18 });
  sim.send('bsf/ac2/cmd', { cmd: 'preset', name: 'warm' });
  drive(sim, fk, 3, { soc: 74, curtailed: false, surplus_smooth: 0 });
  assert.strictEqual(sim.mem.mode, 'AUTO');
  assert.strictEqual(fk.s.power, false);
});

// ---- fresh air whenever nothing else runs (owner 18 Oct) ----
const FRESH = { tiers: { fresh_air: { enabled: true } } };

test('fresh air: a comfortable room gets the fan (quiet) day and night, home or away', () => {
  for (const [hh, home] of [[11, true], [23, true], [11, false], [3, false]]) {
    const sim = newSim(at(hh, 0), FRESH), fk = new FakeFaikout({ home: 22, power: false });
    sim.send('bsf/presence/state', { anyone_home: home });
    drive(sim, fk, 3, { soc: 88, curtailed: false, surplus_smooth: 200 });
    assert.deepStrictEqual([fk.s.power, fk.s.mode, fk.s.fan], [true, 'F', 'Q'], hh + ':00 home=' + home);
    assert.strictEqual(sim.mem.tier, 'fresh_air');
  }
});

test('fresh air: no temperature stop: a 16 C room with no battery to heat keeps the fan', () => {
  const sim = newSim(at(23, 0), FRESH), fk = new FakeFaikout({ home: 16, power: false });
  drive(sim, fk, 10, { soc: 82, curtailed: false, surplus_smooth: -300 });
  assert.deepStrictEqual([fk.s.power, fk.s.mode], [true, 'F']);
});

test('fresh air: not in dashboard OFF, and the battery floor (75 %) still turns everything off', () => {
  let sim = newSim(at(11, 0), FRESH), fk = new FakeFaikout({ home: 22, power: false });
  sim.send('bsf/ac2/cmd', { cmd: 'set_mode', mode: 'OFF' });
  drive(sim, fk, 3, { soc: 90, curtailed: false, surplus_smooth: 200 });
  assert.strictEqual(fk.s.power, false);
  sim = newSim(at(11, 0), FRESH); fk = new FakeFaikout({ home: 22, power: true, mode: 'F', fan: 'Q' });
  drive(sim, fk, 3, { soc: 74, curtailed: false, surplus_smooth: 200 });
  assert.strictEqual(fk.s.power, false);
});

test('fresh air: the fan counts as ~30 W, not 700 W, so it does not invent spare solar for the compressor', () => {
  const sim = newSim(at(11, 0), FRESH), fk = new FakeFaikout({ home: 27, power: false });
  // 500 W real surplus: fresh air starts; comfort cooling needs 900 W, so it must not start once the fan runs
  // (counting the fan as the compressor's 700 W would make it 1200 W and start cooling)
  const sent = drive(sim, fk, 8, { soc: 92, curtailed: false, surplus_smooth: 500 });
  assert.strictEqual(sim.mem.tier, 'fresh_air');
  assert.ok(!sent.some((c) => c.mode === 'C'), JSON.stringify(sent));
  assert.strictEqual(fk.s.mode, 'F');
});

test('fresh air: heat -> fan respects the compressor min-run, fan -> heat respects min-off', () => {
  const sim = newSim(at(11, 0), FRESH), fk = new FakeFaikout({ home: 22, power: false });
  drive(sim, fk, 3, { soc: 92, curtailed: false, surplus_smooth: 200 });
  assert.strictEqual(fk.s.mode, 'F');
  fk.s.home = 18;                                         // cold: comfort heat on solar
  drive(sim, fk, 4, { soc: 92, curtailed: false, surplus_smooth: 1500 });
  assert.strictEqual(fk.s.mode, 'H');
  const startedAt = sim.clock.now;
  fk.s.home = 22;                                         // solar gone 2 min later: stays on heat until 20 min
  const sent = drive(sim, fk, 25, { soc: 92, curtailed: false, surplus_smooth: -200 });
  const toFan = sent.findIndex((c) => c.mode === 'F');
  assert.ok(toFan >= 0, 'back to fresh air');
  assert.ok(!sent.some((c) => c.mode === 'C'), 'a heat run never turns into cooling: ' + JSON.stringify(sent));
  assert.ok(sim.mem.compOffAt - startedAt >= 18 * MIN, 'compressor ran its min-run: ' + (sim.mem.compOffAt - startedAt) / MIN);
  fk.s.home = 18;                                         // cold again: no restart until 10 min after the compressor stopped
  const stoppedAt = sim.mem.compOffAt;
  let restartAt = null;
  for (let i = 0; i < 30 && restartAt === null; i++) {
    drive(sim, fk, 0.5, { soc: 92, curtailed: false, surplus_smooth: 1500 });
    if (fk.s.mode === 'H') restartAt = sim.clock.now;
    else assert.strictEqual(fk.s.mode, 'F', 'keeps the fresh air while it waits');
  }
  assert.ok(restartAt !== null, 'heats again once rested');
  assert.ok(restartAt - stoppedAt >= 10 * MIN, 'min-off: restarted ' + (restartAt - stoppedAt) / MIN + ' min after stopping');
});

test('fresh air: real 2026-10-11/12 replay: compressor still pre-cools, the fan fills the rest, no thrash', () => {
  const r = replay(path.join(__dirname, 'fixtures/farm-2026-10-11_12.json'), 60, { freshAir: true });
  const comp = r.timeline.filter((c) => c.cmd.power && c.cmd.mode !== 'F');
  assert.ok(comp.some((c) => c.tier === 'soak'), 'pre-cools on the curtailed day');
  assert.ok(r.timeline.length <= 12, 'commands: ' + r.timeline.length);
  assert.ok(!r.timeline.some((c) => c.cmd.power === false), 'never fully off: ' + JSON.stringify(r.timeline.filter((c) => !c.cmd.power)));
});

test('a change at the unit during boost ends the boost and gets the 1 h manual hold', () => {
  const sim = newSim(at(20, 0)), fk = new FakeFaikout({ home: 25 });
  drive(sim, fk, 2, { soc: 90, curtailed: false, surplus_smooth: -300 });
  sim.send('bsf/ac2/cmd', { cmd: 'boost' });
  drive(sim, fk, 4, { soc: 90, curtailed: false, surplus_smooth: -300 });
  assert.strictEqual(sim.mem.mode, 'BOOST');
  assert.ok(sim.mem.lastSent.confirmed, 'the unit confirmed the boost setting');
  fk.s.mode = 'H'; fk.s.temp = 26;
  const sent = drive(sim, fk, 10, { soc: 90, curtailed: false, surplus_smooth: -300 });
  assert.strictEqual(sim.mem.mode, 'AUTO');
  assert.ok(sim.mem.manualHoldUntil > sim.clock.now + 45 * MIN, 'hold set');
  assert.strictEqual(sent.length, 0, 'nothing sent over the hand setting: ' + JSON.stringify(sent));
  assert.strictEqual(fk.s.mode + fk.s.temp, 'H26');
});

test('cold room override: heats until the room is back to 22, then the forecast season returns', () => {
  const start = Date.UTC(2026, 9, 14, 20, 20);
  const sim = newSim(start), fk = new FakeFaikout({ home: 16.5, power: false });
  sim.send('bsf/weather/forecast', { ts: new Date(start).toISOString(), today: { date: '2026-10-15', max_c: 25, min_c: 9, rad_mj: 24 } });
  let o = drive(sim, fk, 2, { soc: 90, curtailed: false, surplus_smooth: 400 });
  assert.strictEqual(sim.mem.roomSeason, 'heat');
  fk.s.home = 20.5; drive(sim, fk, 1, { soc: 90, curtailed: false, surplus_smooth: 400 });
  assert.strictEqual(sim.mem.roomSeason, 'heat', 'still heating at 20.5');
  fk.s.home = 22.2; drive(sim, fk, 1, { soc: 90, curtailed: false, surplus_smooth: 400 });
  assert.strictEqual(sim.mem.roomSeason, null);
  assert.strictEqual(sim.mem.season.value, 'cool');
});

test('October: a warm forecast makes it a cooling day even if dawn reads cool', () => {
  const start = Date.UTC(2026, 9, 13, 19, 30);         // 14 Oct 05:30
  const sim = newSim(start), fk = new FakeFaikout({ home: 18.5, power: false });
  sim.send('bsf/weather/forecast', { ts: new Date(start).toISOString(), today: { date: '2026-10-14', max_c: 27, min_c: 12, rad_mj: 25 } });
  drive(sim, fk, 2, { soc: 85, curtailed: false, surplus_smooth: -200 });
  assert.strictEqual(sim.mem.season.value, 'cool');
});

// ---- a change at the unit counts as someone home (owner 20 Oct: a family member's phone is in airplane mode) ----
test('presence: a hand change at the unit counts as home for 4 h, then the phones decide again', () => {
  const sim = newSim(at(9, 0), FRESH), fk = new FakeFaikout({ home: 18, power: false });
  sim.send('bsf/presence/state', { anyone_home: false });
  const solar = { soc: 92, curtailed: false, surplus_smooth: 1500 };
  const away = () => sim.send('bsf/presence/state', { anyone_home: false });
  drive(sim, fk, 3, solar);
  assert.deepStrictEqual([fk.s.power, fk.s.mode], [true, 'F'], 'away: fan only, no comfort heat');
  fk.s.power = false;                                     // she switches the "aircon" off at the remote
  drive(sim, fk, 2, solar);
  assert.strictEqual(sim.mem.tier, 'manual_hold');
  assert.ok(sim.mem.handHomeUntil > sim.clock.now + 3.9 * 3600000, 'counted home for 4 h');
  for (let i = 0; i < 6; i++) { away(); drive(sim, fk, 10, solar); }   // the hour runs out, phones still say away
  assert.strictEqual(fk.s.mode, 'H', 'counted home: comfort heat on solar');
  for (let i = 0; i < 20; i++) { away(); fk.s.home = 18; drive(sim, fk, 10, solar); } // past 4 h
  assert.strictEqual(sim.mem.handHomeUntil, null);
  assert.strictEqual(fk.s.mode, 'F', 'away again: back to fan only');
});

test('presence: an aircon found already running does not count anyone home', () => {
  const sim = newSim(at(9, 0), FRESH), fk = new FakeFaikout({ home: 18, power: true, mode: 'F', fan: 'Q' });
  sim.send('bsf/presence/state', { anyone_home: false });
  drive(sim, fk, 2, { soc: 92, curtailed: false, surplus_smooth: 1500 });
  assert.strictEqual(sim.mem.handHomeUntil, null);
});

// ---- owner 21 Oct: make the house sit around 26 C (the shipped setpoints, not the pinned test ones) ----
test('26 C: on a cold day a 24.5 C room heats to 26 on spare solar (unit 28), and heating to 26-27 never trips cooling', () => {
  const CFG = require('../config/ac2.config.json');
  const sim = new NodeRedSim({ start: Date.UTC(2026, 9, 21, 1, 0), overrides: { dry_run: false, sensors: { ac_idle_offset_c: 0, ac_heat_offset_c: 0 }, tiers: { fresh_air: { enabled: false } } } }); // 21 Oct 11:00, fake room = true room
  sim.send('bsf/presence/state', { anyone_home: true });
  const fk = new FakeFaikout({ home: 24.5, outside: 12, power: false });
  drive(sim, fk, 4, { soc: 92, curtailed: false, surplus_smooth: 1500 });
  assert.deepStrictEqual([fk.s.power, fk.s.mode, fk.s.temp], [true, 'H', CFG.setpoints.heat.comfort_c + CFG.sensors.heat_setpoint_add_c]);
  assert.strictEqual(CFG.setpoints.heat.comfort_c, 26);
  fk.s.home = 27.5;                                       // overshoot while soaking: still heat season, no cooling
  const sent = drive(sim, fk, 30, { soc: 99, curtailed: true, surplus_smooth: 2500 });
  assert.ok(!sent.some((c) => c.mode === 'C'), JSON.stringify(sent));
});
