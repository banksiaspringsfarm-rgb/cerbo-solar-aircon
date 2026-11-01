#!/usr/bin/env node
// Day simulator + real-data replay for the AC v2 controller. Runs the BUILT Node-RED paste
// (not just the core), with a fake Faikout and a crude house + battery model.
//
//   node sim/run.js summer            hot clear day, flat E/W curve, 24 kWh gel bank
//   node sim/run.js winter            cold clear day (morning warm-up + midday pre-heat)
//   node sim/run.js lowsoc            summer day starting at 68 % SOC (battery protection)
//   node sim/run.js stale             summer day, solar feed dies at 11:00
//   node sim/run.js replay [file]     real farm samples (default test/fixtures/farm-2026-10-11_12.json)
//   add --every 5  to print every 5 min (default 15), --battery-kwh 90 to try a bigger bank
'use strict';
const fs = require('fs');
const path = require('path');
const { NodeRedSim, FakeFaikout } = require('./harness');

const TZ = 600 * 60000;
const local = (ms) => new Date(ms + TZ).toISOString().slice(11, 16);

function argVal(name, dflt) { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : dflt; }

function runDay(sc) {
  const sim = new NodeRedSim({ start: sc.start, overrides: Object.assign({ dry_run: false }, sc.overrides || {}) });
  const fk = new FakeFaikout({ home: sc.room0, outside: sc.outside(0), mode: sc.season === 'heat' ? 'H' : 'C' });
  const capWh = sc.batteryKwh * 1000;
  let soc = sc.soc0, room = sc.room0, acWh = 0, onMin = 0, starts = 0, minSoc = soc, prevOn = false;
  const rows = [];
  sim.send('bsf/presence/state', { anyone_home: true });
  for (let min = 0; min < sc.minutes; min++) {
    const now = sc.start + min * 60000;
    sim.clock.now = now;
    const hod = (now + TZ) % 86400000 / 3600000;          // local hour of day
    const tout = sc.outside(hod);
    // AC + room
    let acW = 0;
    if (fk.s.power) {
      const diff = fk.s.mode === 'C' ? room - fk.s.temp : fk.s.temp - room;
      const duty = Math.max(0, Math.min(1, diff / 2));
      acW = 250 + 850 * duty;
      room += (fk.s.mode === 'C' ? -1 : 1) * duty * sc.acDegPerMin;
    }
    room += (tout - room) / sc.tauMin + (sc.solarGain ? sc.solarGain(hod) : 0);
    fk.s.home = Math.round(room * 2) / 2; fk.s.outside = Math.round(tout);
    // battery + PV
    const load = sc.baseLoad + acW;
    const pvAvail = sc.pv(hod);
    const accept = soc >= 90 ? 6000 * (100 - soc) / 10 : 6000;
    const pv = Math.min(pvAvail, load + accept);
    const curtailed = soc >= 90 && pvAvail > pv + 200;
    soc = Math.max(0, Math.min(100, soc + (pv - load) / 60 / capWh * 100));
    minSoc = Math.min(minSoc, soc);
    if (fk.s.power) { acWh += acW / 60; onMin++; }
    if (fk.s.power && !prevOn) starts++;
    prevOn = fk.s.power;
    const feedAlive = !sc.feedDiesAt || hod < sc.feedDiesAt;
    if (feedAlive && min % 1 === 0) {
      sim.send('bsf/hotwater/status', { ts: new Date(now).toISOString(), soc: Math.round(soc), surplus_now: Math.round(pv - load), surplus_smooth: Math.round(pv - load), ac_load: Math.round(load), curtailed, plug_power: 0, sunset_iso: new Date(sc.sunset).toISOString() });
    }
    sim.send('bsf/ac/plug_power', Math.round(acW));
    sim.send('state/' + sim.host + '/status', fk.status());
    if (min % 1 === 0 && (min * 60) % 30 === 0) {
      const out = sim.tick();
      if (out && out[0]) fk.apply(out[0].payload);
    }
    if (min % 5 === 0) {
      const w = sim.watchdog();
      if (w && w[0]) fk.apply(w[0].payload);
    }
    const st = sim.flowStore.ac2_mem;
    if (min % sc.every === 0) rows.push([local(now), Math.round(soc), Math.round(pvAvail), Math.round(pv - load), curtailed ? 'C' : ' ', room.toFixed(1), Math.round(tout), st.tier, fk.s.power ? fk.s.mode + fk.s.temp : 'off', Math.round(acW)]);
  }
  return { rows, summary: { ac_kwh: +(acWh / 1000).toFixed(2), ac_on_h: +(onMin / 60).toFixed(1), starts, min_soc: Math.round(minSoc), end_soc: Math.round(soc), end_room_c: +room.toFixed(1) } };
}

function flatPv(start, plateauFrom, plateauTo, end, kw) {
  return (h) => (h <= start || h >= end) ? 0 : h < plateauFrom ? kw * 1000 * (h - start) / (plateauFrom - start)
    : h <= plateauTo ? kw * 1000 : kw * 1000 * (end - h) / (end - plateauTo);
}

function scenario(name, batteryKwh) {
  const summerStart = Date.UTC(2026, 0, 14, 19, 0);     // 15 Jan 05:00 AEST
  const winterStart = Date.UTC(2026, 6, 14, 19, 0);     // 15 Jul 05:00 AEST
  const hot = (h) => 19 + 15 * Math.max(0, Math.sin(Math.PI * (h - 7) / 14));
  const cold = (h) => 1 + 14 * Math.max(0, Math.sin(Math.PI * (h - 8) / 10));
  const common = { minutes: 15 * 60, tauMin: 360, acDegPerMin: 0.06, baseLoad: 450, batteryKwh: batteryKwh || 24, every: 15 };
  const summer = Object.assign({}, common, { start: summerStart, sunset: Date.UTC(2026, 0, 15, 8, 45), season: 'cool', soc0: 82, room0: 25, outside: hot, pv: flatPv(6, 8, 16, 18.5, 6.5), solarGain: (h) => (h > 9 && h < 17 ? 0.012 : 0) });
  switch (name) {
    case 'summer': return summer;
    case 'lowsoc': return Object.assign({}, summer, { soc0: 68, pv: flatPv(6, 9, 13, 17, 3.0) });
    case 'stale': return Object.assign({}, summer, { feedDiesAt: 11 });
    case 'winter': return Object.assign({}, common, { start: winterStart, sunset: Date.UTC(2026, 6, 15, 7, 5), season: 'heat', soc0: 84, room0: 14, outside: cold, pv: flatPv(7, 8.5, 14.5, 16.8, 5.0) });
    default: throw new Error('unknown scenario ' + name);
  }
}

function replay(file, every, opts) {
  const fx = JSON.parse(fs.readFileSync(file, 'utf8'));
  const s0 = fx.samples[0].ts;
  // The fake aircon reports the real house temperature, so the idle-sensor correction is off here.
  const sim = new NodeRedSim({ start: s0, overrides: { dry_run: false, sensors: { ac_idle_offset_c: 0, ac_heat_offset_c: 0, heat_setpoint_add_c: 0 }, tiers: { fresh_air: { enabled: (opts || {}).freshAir === true } } } });
  const fk = new FakeFaikout({ home: fx.samples[0].inside_temp });
  sim.send('bsf/presence/state', { anyone_home: true });
  const rows = [], timeline = [];
  let lastRow = -Infinity, lastTick = -Infinity, lastWd = -Infinity, onMs = 0, prev = null;
  for (const s of fx.samples) {
    sim.clock.now = s.ts;
    if (prev && fk.s.power) onMs += s.ts - prev;
    prev = s.ts;
    // Real house temp from the Tuya probe (the AC did not run that day, so this is the
    // un-cooled house: good for judging WHEN v2 would act, not how cold it would get).
    if (typeof s.inside_temp === 'number') fk.s.home = s.inside_temp;
    sim.send('bsf/hotwater/status', s.hw);
    sim.send('state/' + sim.host + '/status', fk.status());
    if (s.ts - lastWd >= 300000) { lastWd = s.ts; const w = sim.watchdog(); if (w && w[0]) fk.apply(w[0].payload); }
    if (s.ts - lastTick >= 30000) {
      lastTick = s.ts;
      const out = sim.tick();
      if (out && out[0]) { fk.apply(out[0].payload); timeline.push({ t: local(s.ts), cmd: JSON.parse(out[0].payload), tier: sim.mem.tier }); }
    }
    if (s.ts - lastRow >= every * 60000) {
      lastRow = s.ts;
      rows.push([local(s.ts), s.hw.soc, s.hw.pv_total, s.hw.surplus_smooth !== undefined ? s.hw.surplus_smooth : s.hw.surplus_now, s.hw.curtailed ? 'C' : ' ', s.inside_temp, '', sim.mem.tier, fk.s.power ? fk.s.mode + fk.s.temp : 'off', '']);
    }
  }
  return { rows, timeline, summary: { samples: fx.samples.length, from: new Date(s0).toISOString(), ac_on_h: +(onMs / 3600000).toFixed(1), commands: timeline.length } };
}

function print(res) {
  console.log(['time', 'soc', 'pv', 'surpl', 'cu', 'room', 'out', 'tier', 'ac', 'acW'].map((h) => h.padEnd(7)).join(''));
  res.rows.forEach((r) => console.log(r.map((c) => String(c === null || c === undefined ? '' : c).padEnd(7)).join('')));
  if (res.timeline) { console.log('\ncommands sent:'); res.timeline.forEach((c) => console.log('  ' + c.t + '  ' + c.tier.padEnd(13) + JSON.stringify(c.cmd))); }
  console.log('\nsummary', JSON.stringify(res.summary));
}

if (require.main === module) {
  const name = process.argv[2] || 'summer';
  const every = Number(argVal('--every', 15));
  if (name === 'replay') {
    const f = process.argv[3] && !process.argv[3].startsWith('--') ? process.argv[3] : path.join(__dirname, '..', 'test/fixtures/farm-2026-10-11_12.json');
    print(replay(f, every));
  } else {
    const sc = scenario(name, Number(argVal('--battery-kwh', 0)) || undefined);
    sc.every = every;
    print(runDay(sc));
  }
}

module.exports = { runDay, scenario, replay };
