// AC v2 hard limits: the floor no setting can go below.
//
// The config and the live overrides (flow context ac2_cfg_overrides, set from the dashboard or by hand) can tune
// everything else, but these are clamped every tick, in the dispatcher AND the watchdog. They guard against a
// mistyped number or a careless override, not against someone editing this file (owner 2026-11-04: anyone can
// edit the code; the floor is a guard against accidental settings, not a lock).
//
// Pure, no I/O. scripts/build.js prepends it to both Node-RED function bodies; the core calls hardLimits().
//
// clampConfig(cfg)  -> { cfg, clamped: [...], errors: [...] }   cfg is a copy, raised to the limits
// hardLimits(cfg)   -> { soc_floor_pct, voltage_floor_v|null }   what the core and the watchdog enforce
// hardBreach(cfg, solar) -> null | 'HARD_SOC_FLOOR' | 'BATT_VOLTAGE'   solar = normalizeHw() output, already fresh

const LIMITS = {
  // Lowest state of charge any setting may run the aircon to (owner 2026-11-04, D9). Lead covers flooded, gel and AGM.
  soc_floor_pct: { lead: 50, lithium: 25 },
  // Lowest per-cell voltage a voltage floor may be set to: a loaded lead cell at ~1.95 V is well past half empty;
  // LiFePO4 at 3.0 V is near the bottom of its flat curve. cells = system_v / nominal cell voltage, rounded DOWN for
  // lithium: "48 V" covers both 15-cell (Pylontech) and 16-cell banks, and the minimum must not trip the 15-cell one.
  min_cell_v: { lead: 1.95, lithium: 3.0 },
  nominal_cell_v: { lead: 2.0, lithium: 3.2 },
  system_v: [24, 48],               // 12 V systems are refused: an aircon is too big a load for them
  min_capacity_kwh: 5,              // banks smaller than this are refused, when the size is given
  inverter_cap_frac: 0.7,           // load.cap_w at most 70 % of the inverter's continuous rating, when given
  min_off_s: 180,                   // compressor rest between runs, whatever the config says
  max_solar_age_s: 600,             // solar state older than this is stale, whatever the config says
  max_ac_age_s: 900,
};

function chemistryOf(cfg) {
  const c = cfg && cfg.battery && cfg.battery.chemistry;
  return c === 'lithium' ? 'lithium' : 'lead';   // anything else (unset, a typo) gets the stricter lead floor
}

function hardLimits(cfg) {
  const chem = chemistryOf(cfg), b = (cfg && cfg.battery) || {};
  const sysV = typeof b.system_v === 'number' && isFinite(b.system_v) ? b.system_v : null;
  let vFloor = typeof b.voltage_floor_v === 'number' && isFinite(b.voltage_floor_v) ? b.voltage_floor_v : null;
  if (vFloor !== null && sysV !== null) {
    const cells = (chem === 'lithium' ? Math.floor : Math.round)(sysV / LIMITS.nominal_cell_v[chem]);
    vFloor = Math.max(vFloor, Math.round(cells * LIMITS.min_cell_v[chem] * 10) / 10);
  }
  return { soc_floor_pct: LIMITS.soc_floor_pct[chem], voltage_floor_v: vFloor };
}

function clampConfig(cfg) {
  const c = JSON.parse(JSON.stringify(cfg || {}));
  const clamped = [], errors = [];
  const raise = function (obj, key, min, label) {
    if (!obj) return;
    if (typeof obj[key] !== 'number' || !isFinite(obj[key]) || obj[key] < min) { clamped.push(label + ' ' + obj[key] + ' -> ' + min); obj[key] = min; }
  };
  const lower = function (obj, key, max, label) {
    if (!obj) return;
    if (typeof obj[key] !== 'number' || !isFinite(obj[key]) || obj[key] > max) { clamped.push(label + ' ' + obj[key] + ' -> ' + max); obj[key] = max; }
  };
  c.battery = c.battery || {};
  const b = c.battery, lim = hardLimits(c);
  if (b.chemistry !== undefined && b.chemistry !== 'lead' && b.chemistry !== 'lithium') errors.push('battery.chemistry must be "lead" or "lithium", not ' + JSON.stringify(b.chemistry) + ' (using the lead floor)');
  raise(b, 'soc_floor_pct', lim.soc_floor_pct, 'battery.soc_floor_pct');
  raise(b, 'boost_soc_floor_pct', lim.soc_floor_pct, 'battery.boost_soc_floor_pct');
  if (lim.voltage_floor_v !== null) raise(b, 'voltage_floor_v', lim.voltage_floor_v, 'battery.voltage_floor_v');
  else if (b.voltage_floor_v !== undefined && b.voltage_floor_v !== null) errors.push('battery.voltage_floor_v must be a number of volts');
  if (b.system_v !== undefined && LIMITS.system_v.indexOf(b.system_v) < 0) errors.push('battery.system_v ' + b.system_v + ' is not supported (24 or 48 V only; an aircon is too big a load for a 12 V system)');
  if (typeof b.capacity_kwh === 'number' && b.capacity_kwh < LIMITS.min_capacity_kwh) errors.push('battery.capacity_kwh ' + b.capacity_kwh + ' is under ' + LIMITS.min_capacity_kwh + ' kWh: too small to run an aircon from');
  if (c.load && typeof c.load.inverter_continuous_w === 'number') {
    lower(c.load, 'cap_w', Math.floor(c.load.inverter_continuous_w * LIMITS.inverter_cap_frac), 'load.cap_w');
  }
  if (c.cycle) raise(c.cycle, 'min_off_s', LIMITS.min_off_s, 'cycle.min_off_s');
  if (c.stale) {
    lower(c.stale, 'solar_max_age_s', LIMITS.max_solar_age_s, 'stale.solar_max_age_s');
    lower(c.stale, 'ac_max_age_s', LIMITS.max_ac_age_s, 'stale.ac_max_age_s');
  }
  return { cfg: c, clamped: clamped, errors: errors };
}

// Checked in the dispatcher every tick, in a manual hold, a boost and a preset too, and again by the watchdog.
// A configured voltage floor with no voltage in the solar state counts as a breach: never run blind.
function hardBreach(cfg, solar) {
  const lim = hardLimits(cfg);
  if (!solar || typeof solar.soc !== 'number' || solar.soc < lim.soc_floor_pct) return 'HARD_SOC_FLOOR';
  if (lim.voltage_floor_v !== null && !(typeof solar.batt_v === 'number' && solar.batt_v >= lim.voltage_floor_v)) return 'BATT_VOLTAGE';
  return null;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { LIMITS, chemistryOf, hardLimits, clampConfig, hardBreach };
}
