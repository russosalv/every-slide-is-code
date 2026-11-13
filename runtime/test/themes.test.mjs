import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as Theme from '../../scripts/theme.mjs';
import { wcag } from '../../scripts/palette.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-kit-themes-'));
const sync = (args, env = {}) => spawnSync(process.execPath, [path.join(root, 'scripts/sync-runtime.mjs'), ...args], { encoding: 'utf8', env: { ...process.env, DECK_KIT_THEMES: '', ...env } });
const read = f => fs.readFileSync(f, 'utf8');

// a theme folder in a private library, outside the kit
function mkTheme(dir, { css = ':root { --bg: #fff; --ink: #000; }', json = { name: path.basename(dir) } } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'theme.css'), css);
  if (json) fs.writeFileSync(path.join(dir, 'theme.json'), JSON.stringify(json));
  return dir;
}
const lib = path.join(tmp, 'lib');
mkTheme(path.join(lib, 'house'), { json: { name: 'house', variants: ['light', 'dark'], default: 'dark', fonts: 'https://fonts.googleapis.com/css2?family=Inter&display=block', brand: '<span class="mark">HOUSE</span>' } });
mkTheme(path.join(lib, 'paper'), { json: { name: 'impostor' } });   // same name as a kit theme: the kit wins

test('theme lookup: the kit first, then DECK_KIT_THEMES, then a direct path', () => {
  const env = lib;
  assert.equal(Theme.resolveTheme('paper', { env }), path.join(root, 'themes/paper'));
  assert.equal(Theme.resolveTheme('house', { env }), path.join(lib, 'house'));
  assert.equal(Theme.resolveTheme(path.join(lib, 'house'), { env: '' }), path.join(lib, 'house'));
  assert.equal(Theme.resolveTheme('./house', { env: '', cwd: lib }), path.join(lib, 'house'));
  const two = [path.join(tmp, 'nothing'), lib].join(path.delimiter);
  assert.equal(Theme.resolveTheme('house', { env: two }), path.join(lib, 'house'), 'several folders, colon separated');
  assert.throws(() => Theme.resolveTheme('nope', { env }), /not found[\s\S]*Available:.*house/);
  assert.throws(() => Theme.resolveTheme('', {}), /needs a theme name/);
  assert.deepEqual(Theme.listThemes(lib).map(t => t.name).sort(), ['house', 'ink', 'paper']);
});

test('a theme is validated when loaded', () => {
  const bad = (json, css, re) => assert.throws(() => Theme.loadTheme(mkTheme(fs.mkdtempSync(path.join(tmp, 'bad-')), { css, json })), re);
  bad({ fonts: 'https://evil.example/x.css' }, ':root{}', /fonts.googleapis/);
  bad({ brand: '<script>1</script>' }, ':root{}', /brand/);
  bad({}, ':root{} </style><script>', /<\/style/);
  bad({ variants: ['light', 'sepia'] }, ':root{}', /variants/);
  bad({ variants: ['light'], default: 'dark' }, ':root{}', /default/);
  const t = Theme.loadTheme(mkTheme(path.join(tmp, 'plain'), { json: null }));
  assert.deepEqual([t.name, t.variants, t.default, t.fonts, t.brand], ['plain', [], '', '', ''], 'theme.json is optional');
});

test('the shipped themes carry light and dark variants that keep the documented contrast', () => {
  for (const name of ['paper', 'ink']) {
    const t = Theme.loadTheme(Theme.resolveTheme(name));
    assert.deepEqual([...t.variants].sort(), ['dark', 'light'], name);
    // the default variant is :root, the other one the [data-theme] block
    const blocks = [...t.css.matchAll(/(^|\n)([^\n{]*)\{([^}]*)\}/g)].map(m => ({ sel: m[2], body: m[3] })).filter(b => /--bg:/.test(b.body));
    assert.equal(blocks.length, 2, `${name}: two token blocks`);
    for (const b of blocks) {
      const v = n => b.body.match(new RegExp(`--${n}:\\s*(#[0-9a-f]{6})`, 'i'))[1];
      assert.ok(wcag(v('ink'), v('bg')) >= 7, `${name} ${b.sel} ink`);
      assert.ok(wcag(v('muted'), v('bg')) >= 4.5, `${name} ${b.sel} muted`);
      assert.ok(wcag(v('accent-text'), v('bg')) >= 4.5, `${name} ${b.sel} accent-text`);
    }
  }
});

test('--new --theme, then another theme, then none: valid, and the same file when repeated', () => {
  const f = path.join(tmp, 'a.html');
  let r = sync(['--new', f, '--theme', 'paper']);
  assert.equal(r.status, 0, r.stderr);
  const h1 = read(f);
  assert.match(h1, /<style id="deck-kit-theme">\n\/\* theme: paper \*\//);
  assert.match(h1, /<link id="deck-kit-theme-fonts" rel="stylesheet" href="https:\/\/fonts\.googleapis\.com\/css2\?family=Newsreader/);
  assert.match(h1, /<div data-theme="light" class="deck"/);
  assert.equal(h1.match(/id="deck-kit-theme"/g).length, 1);
  sync([f, '--theme', 'paper']);
  assert.equal(read(f), h1, 'idempotent');
  sync([f]); assert.equal(read(f), h1, 'a plain refresh leaves the theme alone');

  r = sync(['--theme', 'ink', f]);
  assert.equal(r.status, 0, r.stderr);
  const h2 = read(f);
  assert.match(h2, /\/\* theme: ink \*\//); assert.doesNotMatch(h2, /theme: paper|Newsreader/);
  assert.match(h2, /<div data-theme="dark" class="deck"/);
  assert.equal(h2.match(/deck-kit-theme-fonts/g).length, 1, 'one fonts link');
  sync(['--theme', 'ink', f]); assert.equal(read(f), h2);

  sync(['--variant', 'light', f]);
  assert.match(read(f), /<div data-theme="light" class="deck"/);
  assert.equal(sync(['--theme', 'ink', '--variant', 'dark', f]).status, 0); assert.equal(read(f), h2, 'the variant is the whole difference');

  sync(['--theme', 'none', f]);
  const plain = path.join(tmp, 'plain.html'); sync(['--new', plain]);
  assert.equal(read(f), read(plain), 'none gives back the theme-less deck');
});

test('a deck without the slot keeps working; --theme adds the slot; errors write nothing', () => {
  const f = path.join(tmp, 'old.html');
  sync(['--new', f]);
  fs.writeFileSync(f, read(f).replace('<style id="deck-kit-theme"></style>\n', ''));   // a deck from before themes
  const before = read(f);
  assert.equal(sync([f]).status, 0); assert.equal(read(f), before, 'a plain sync is unchanged');
  assert.equal(sync([f, '--theme', 'paper']).status, 0);
  assert.equal(read(f).match(/<style id="deck-kit-theme">/g).length, 1);
  assert.ok(read(f).indexOf('id="deck-kit-theme"') > read(f).indexOf('id="deck-kit-css"'), 'the theme comes after the deck styles, so it wins');

  const g = path.join(tmp, 'never.html');
  const r = sync(['--new', g, '--theme', 'missing']);
  assert.equal(r.status, 1); assert.match(r.stderr, /not found/); assert.equal(fs.existsSync(g), false, 'no half-made deck');
  assert.equal(sync(['--theme', 'paper']).status, 1, '--theme alone would rewrite the template and examples');
  assert.equal(sync(['--variant', 'sepia', f]).status, 1);
  assert.equal(sync(['--variant', 'dark', path.join(tmp, 'plain.html')]).status, 0);   // no theme: warns, changes nothing
  assert.doesNotMatch(read(path.join(tmp, "plain.html")), /<div data-theme=/);
});

test('themes from DECK_KIT_THEMES: brand on every slide, once, and not where data-brand is off', () => {
  const f = path.join(tmp, 'b.html');
  const env = { DECK_KIT_THEMES: lib };
  assert.equal(sync(['--new', f, '--theme', 'house'], env).status, 0);
  fs.writeFileSync(f, read(f).replace('<section class="slide" id="agenda">', '<section class="slide" id="agenda" data-brand="off">'));
  sync(['--theme', 'house', f], env);
  const h = read(f), slides = h.slice(0, h.indexOf('<script id="deck-kit-js">')).match(/<section class="slide"/g).length;
  assert.equal(h.match(/<div class="dk-brand"><span class="mark">HOUSE<\/span><\/div>/g).length, slides - 1);
  assert.match(h, /data-theme="dark" class="deck"/, 'the theme declares its default');
  const once = h; sync(['--theme', 'house', f], env); assert.equal(read(f), once, 'idempotent with a brand');
  sync(['--theme', 'paper', f], env);
  assert.doesNotMatch(read(f), /HOUSE|dk-brand-->/, 'switching theme removes the old brand');
  assert.equal(sync(['--theme', 'house', '--variant', 'dark', f], env).status, 0);
  const r = sync(['--theme', 'paper', '--variant', 'sepia', f], env); assert.equal(r.status, 1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'themes/ink/theme.json'), 'utf8')).default, 'dark');
});

test('exports select a variant with ?theme=', () => {
  assert.equal(Theme.withVariant('file:///d/deck.html?render', 'dark'), 'file:///d/deck.html?render=&theme=dark');
  assert.equal(Theme.withVariant('file:///d/deck.html#3.1', 'light'), 'file:///d/deck.html?theme=light#3.1');
  assert.equal(Theme.withVariant('file:///d/deck.html', undefined), 'file:///d/deck.html');
  assert.throws(() => Theme.withVariant('file:///d/deck.html', 'sepia'), /light or dark/);
});

test('palette.mjs --theme-out writes a loadable theme with both variants', () => {
  const out = path.join(tmp, 'gen');
  const r = spawnSync(process.execPath, [path.join(root, 'scripts/palette.mjs'), '--accent', '#0f7b5f', '--bg', 'dark', '--name', 'gen', '--theme-out', out], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const t = Theme.loadTheme(out);
  assert.deepEqual([t.name, t.variants, t.default], ['gen', ['dark', 'light'], 'dark']);
  assert.match(t.css, /:root\[data-theme="light"\], \.deck\[data-theme="light"\]/);
  for (const v of ['--bg', '--ink', '--muted', '--rule', '--accent', '--accent-text', '--display', '--text', '--mono', '--dk-mark']) assert.ok(t.css.includes(v + ':'), v);
});
