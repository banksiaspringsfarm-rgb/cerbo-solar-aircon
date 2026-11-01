// Runs the BUILT Node-RED function bodies (dist paste) in a vm sandbox that looks like a
// Node-RED function node: msg, flow, node, a fake clock. Plus a fake Faikout that applies
// commands and reports status back the way the firmware does (state/<host>/status).
// Used by the tests, the synthetic day sim and the real-data replay.
'use strict';
const vm = require('vm');
const { build } = require('../scripts/build');

function makeDate(clock) {
  const RealDate = Date;
  function FakeDate(...a) { return a.length ? new RealDate(...a) : new RealDate(clock.now); }
  FakeDate.now = () => clock.now;
  FakeDate.parse = RealDate.parse;
  FakeDate.UTC = RealDate.UTC;
  FakeDate.prototype = RealDate.prototype;
  return FakeDate;
}

class NodeRedSim {
  constructor(opts) {
    opts = opts || {};
    const b = build({ host: opts.host });
    this.cfg = b.cfg;
    this.host = b.cfg.faikout_host;
    this.clock = { now: opts.start || Date.UTC(2026, 0, 15, 20, 0) };
    this.flowStore = {};
    if (opts.overrides) this.flowStore.ac2_cfg_overrides = opts.overrides;
    this.nodeStatus = {};
    const store = this.flowStore;
    const flow = { get: (k) => (store[k] === undefined ? undefined : JSON.parse(JSON.stringify(store[k]))), set: (k, v) => { store[k] = v === undefined ? undefined : JSON.parse(JSON.stringify(v)); } };
    const mk = (name, body) => {
      const node = { status: (s) => { this.nodeStatus[name] = s; }, warn: () => {}, error: (e) => { throw new Error(String(e)); } };
      const script = new vm.Script('(function(msg){\n' + body + '\n})');
      return (msg) => script.runInNewContext({ flow, node, Date: makeDate(this.clock), JSON, Math, Number, String, Object, Array, isFinite, console })(msg);
    };
    this.disp = mk('disp', b.dispPaste);
    this.wd = mk('watchdog', b.wdPaste);
  }
  send(topic, payload) { return this.disp({ topic, payload }); }
  tick() { return this.disp({ topic: 'tick', payload: this.clock.now }); }
  watchdog() { return this.wd({ topic: 'watchdog', payload: this.clock.now }); }
  get mem() { return this.flowStore.ac2_mem; }
}

// Firmware-shaped status. `apply` takes a command/<host> JSON payload.
class FakeFaikout {
  constructor(init) { // Default fields = what the farm FTXZ25 actually reported on 2026-10-12 (no econo, no demand).
    this.s = Object.assign({ protocol: 'S21', online: true, power: false, mode: 'C', temp: 24, fan: 'A', swingh: false, swingv: false, powerful: false, home: 25, outside: 25, liquid: 15, comp: 0, fanrpm: 0, hum: 45 }, init || {}); }
  apply(payload) {
    const c = typeof payload === 'string' ? JSON.parse(payload) : payload;
    ['power', 'mode', 'temp', 'fan', 'econo', 'demand'].forEach((k) => { if (c[k] !== undefined) this.s[k] = c[k]; });
  }
  status() { return Object.assign({}, this.s); }
}

module.exports = { NodeRedSim, FakeFaikout };
