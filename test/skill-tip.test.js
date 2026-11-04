// The Ko-fi thank-you: one line in the setup skill, shown once after setup works, and nowhere else in the
// plugin (the plugin manifests go to directory review).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const KOFI = /ko-fi\.com/gi;

function files(dir, keep) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? files(p, keep) : keep(p) ? [p] : [];
  });
}

test('setup skill mentions the Ko-fi link exactly once, gated on a once-only local marker', () => {
  const text = fs.readFileSync(path.join(ROOT, 'skills/setup/SKILL.md'), 'utf8');
  assert.strictEqual((text.match(KOFI) || []).length, 1);
  const tip = text.slice(text.indexOf('## Once it works'));
  assert.ok(tip.length < text.length, 'tip section present');
  assert.match(tip, /First check\*\* whether `~\/\.solarac\/tip-shown` exists/);
  assert.match(tip, /create `~\/\.solarac\/tip-shown`/);
  assert.match(tip, /Never:\*\* repeat the line/);
  assert.doesNotMatch(tip, /https?:\/\/(?!ko-fi\.com\/)/, 'no other URL: nothing to phone home to');
});

test('no other skill and no plugin manifest mentions the tip link', () => {
  const others = files(path.join(ROOT, 'skills'), p => p.endsWith('.md'))
    .filter(p => !p.endsWith(path.join('setup', 'SKILL.md')));
  const manifests = files(path.join(ROOT, '.claude-plugin'), () => true)
    .concat(['plugin.json', 'marketplace.json'].map(f => path.join(ROOT, f)).filter(fs.existsSync));
  for (const p of others.concat(manifests)) {
    assert.doesNotMatch(fs.readFileSync(p, 'utf8'), KOFI, path.relative(ROOT, p));
  }
});
