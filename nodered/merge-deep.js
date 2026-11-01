// Config overrides from flow context (`ac2_cfg_overrides`) are deep-merged over AC2_CONFIG,
// so the dashboard can tune one threshold without restating the rest.
function mergeDeep(base, over) {
  if (!over || typeof over !== 'object' || Array.isArray(over)) return over === undefined ? base : over;
  const out = Array.isArray(base) ? base.slice() : Object.assign({}, base);
  Object.keys(over).forEach(function (k) {
    out[k] = (base && typeof base[k] === 'object' && !Array.isArray(base[k])) ? mergeDeep(base[k], over[k]) : over[k];
  });
  return out;
}
