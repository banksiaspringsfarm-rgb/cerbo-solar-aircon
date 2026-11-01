// ── AC v2 watchdog: function node `ac2.fn.watchdog`, fired every 5 min by its own inject ──
// Independent of the dispatcher on purpose (same idea as the v1 LOCKOUT loop): if the
// dispatcher has stopped evaluating, or solar data has gone stale, and the Faikout says the
// AC is running under automation, force it OFF. It never fights a manual hold, a boost or a preset.
// scripts/build.js prepends AC2_CONFIG and nodered/merge-deep.js.
// Outputs (3): [0] REAL Faikout command (UNWIRED in Phase 1)  [1] bsf/ac2/shadow  [2] bsf/ac2/anomaly

const cfg = mergeDeep(AC2_CONFIG, flow.get('ac2_cfg_overrides') || {});
const host = cfg.faikout_host;
const now = Date.now();
const inp = flow.get('ac2_in') || {};
const mem = flow.get('ac2_mem') || {};
const lastEval = flow.get('ac2_last_eval_ms') || 0;

const acOn = !!(inp.ac && inp.ac.power && now - inp.ac.ts_ms <= cfg.stale.ac_max_age_s * 1000);
const dispatcherDead = now - lastEval > 180000;
const solarStale = !inp.solar || now - inp.solar.ts_ms > cfg.stale.solar_max_age_s * 1000;
const userOwned = mem.mode === 'BOOST' || mem.mode === 'PRESET' || (mem.manualHoldUntil && now < mem.manualHoldUntil);

if (!acOn || userOwned || (!dispatcherDead && !solarStale)) {
  node.status({ fill: 'grey', shape: 'ring', text: 'ok ' + new Date(now).toISOString().slice(11, 16) });
  return null;
}
const why = dispatcherDead ? 'dispatcher not evaluating for ' + Math.round((now - lastEval) / 1000) + ' s' : 'solar state stale';
const cmd = { topic: 'command/' + host, payload: JSON.stringify({ power: false }), qos: 1, retain: false };
node.status({ fill: 'red', shape: 'dot', text: 'FORCE OFF: ' + why });
return [
  cfg.dry_run ? null : cmd,
  { topic: 'bsf/ac2/shadow', payload: { ts: new Date(now).toISOString(), dry_run: !!cfg.dry_run, tier: 'watchdog', topic: cmd.topic, command: { power: false } } },
  { topic: 'bsf/ac2/anomaly', payload: { ts: new Date(now).toISOString(), key: 'WATCHDOG_FORCE_OFF', msg: 'Watchdog forced AC off: ' + why }, qos: 1 },
];
