// Editable PowerPoint export in real Chrome: `deck.mjs pptx --editable` on the template and on a fixture with a table,
// boxes, a gradient, a list and a rotated element. Checks the .pptx itself: slide count, native searchable text,
// a native table, shapes, pictures only where a picture is unavoidable, valid paragraph properties, notes.
// The default export stays image-only.
// Usage: npm run test:pptx     (Chrome or CHROME_PATH; `npm install` in export/)
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const JSZip = createRequire(path.join(root, 'export', 'package.json'))('jszip');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-kit-pptx-'));

const template = fs.readFileSync(path.join(root, 'template/deck.html'), 'utf8');
const fixtureSlides = `<div class="deck" data-transition="fade">
  <section class="slide" id="a" style="background:linear-gradient(135deg,#f4f2ee,#d8def5)">
    <p class="kicker">Fixture</p>
    <h2>Table, boxes and a gradient</h2>
    <table style="border-collapse:collapse;font:400 32px/1.3 var(--text)">
      <tr><th style="text-align:left;padding:12px 24px;border-bottom:3px solid #1c1b18">Region</th><th style="text-align:right;padding:12px 24px;border-bottom:3px solid #1c1b18">Revenue</th></tr>
      <tr><td style="padding:12px 24px">North</td><td style="text-align:right;padding:12px 24px">1,200</td></tr>
    </table>
    <div style="position:absolute;left:1100px;top:300px;width:600px;height:240px;background:#fff;border:4px solid #2b50e0;border-radius:32px;padding:30px;box-sizing:border-box">
      <p style="margin:0;font:700 40px/1.1 var(--text);text-transform:uppercase">Card title</p>
      <p style="margin:12px 0 0;font:400 28px/1.3 var(--text)">Line one<br>line two with <b>bold</b> and <span style="color:#c62828">red</span>.</p>
    </div>
    <div style="position:absolute;left:1100px;top:640px;width:160px;height:160px;border-radius:50%;background:#2b50e0"></div>
    <div style="position:absolute;left:150px;top:760px;font:600 44px var(--text);transform:rotate(-4deg)">Rotated stays a picture</div>
    <aside class="notes"><p>Fixture notes.</p></aside>
  </section>
  <section class="slide" id="b">
    <h2>A list on the second slide</h2>
    <ul style="font:400 40px/1.4 var(--text)"><li>First bullet</li><li>Second bullet</li></ul>
  </section>
`;
const a = template.indexOf('<div class="deck"'), b = template.indexOf('</div>\n\n<script id="deck-kit-js">');
const fixture = path.join(tmp, 'fixture.html');
fs.writeFileSync(fixture, template.slice(0, a) + fixtureSlides + template.slice(b));

const run = (deck, out, ...flags) => {
  const r = spawnSync(process.execPath, [path.join(root, 'export/deck.mjs'), 'pptx', deck, out, ...flags], { encoding: 'utf8', timeout: 180000 });
  assert.equal(r.status, 0, `deck.mjs pptx failed:\n${r.stdout}\n${r.stderr}`);
  return r.stdout;
};
const load = async file => {
  const zip = await JSZip.loadAsync(fs.readFileSync(file)), slides = {};
  for (const n of Object.keys(zip.files).filter(n => /^ppt\/slides\/slide\d+\.xml$/.test(n))) slides[+n.match(/\d+/)[0]] = await zip.file(n).async('string');
  const notes = await Promise.all(Object.keys(zip.files).filter(n => /^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(n)).map(n => zip.file(n).async('string')));
  return { slides, count: Object.keys(slides).length, notes, text: n => [...slides[n].matchAll(/<a:t>([^<]*)<\/a:t>/g)].map(m => m[1]).join(' ') };
};

let failed = 0;
const check = async (name, fn) => { try { await fn(); console.log('ok   ' + name); } catch (e) { failed++; console.log('FAIL ' + name + '\n' + String(e.stack || e).replace(/^/gm, '     ')); } };

await check('template: one slide per slide, titles are native searchable text', async () => {
  const out = path.join(tmp, 'template.pptx');
  const log = run(path.join(root, 'template/deck.html'), out, '--editable');
  const p = await load(out);
  assert.equal(p.count, 9);
  assert.match(p.text(1), /A title that\s*makes a claim/);
  assert.match(p.text(2), /Three things to decide today/);
  assert.match(p.text(9), /Approve the pilot/);
  assert.match(log, /text boxes, \d+ shapes, 0 tables native; \d+ cut-out pictures/);
  assert.ok(p.notes.some(n => /Speaker notes live here/.test(n)), 'speaker notes are carried over');
  assert.match(p.slides[4], /<p:pic>/, 'an svg chart is a picture');
});

await check('fixture: table, shapes, bold/colour runs, gradient background and rotated picture', async () => {
  const out = path.join(tmp, 'fixture.pptx');
  run(fixture, out, '--editable');
  const p = await load(out);
  assert.equal(p.count, 2);
  assert.match(p.slides[1], /<a:tbl>/, 'native table');
  assert.match(p.text(1), /Region\s+Revenue\s+North\s+1,200/);
  assert.match(p.text(1), /CARD TITLE/, 'text-transform is applied');
  assert.match(p.slides[1], /prst="roundRect"/);
  assert.match(p.slides[1], /prst="ellipse"/, 'border-radius 50% is an ellipse');
  assert.match(p.slides[1], / b="1"/, 'bold run');
  assert.match(p.slides[1], /srgbClr val="C62828"/, 'coloured run');
  assert.ok((p.slides[1].match(/<p:pic>/g) || []).length >= 2, 'gradient background and the rotated text are pictures');
  assert.ok(!/Rotated stays/.test(p.text(1)), 'the rotated text is not duplicated as text');
  assert.match(p.text(2), /First bullet/);
  assert.match(p.text(2), /Second bullet/);
});

await check('every paragraph has at most one pPr, and it comes first', async () => {
  const p = await load(path.join(tmp, 'fixture.pptx'));
  for (const xml of Object.values(p.slides)) for (const para of xml.match(/<a:p>[\s\S]*?<\/a:p>/g) || []) {
    assert.ok((para.match(/<a:pPr\b/g) || []).length <= 1, para.slice(0, 300));
    if (para.includes('<a:pPr')) assert.ok(para.startsWith('<a:p><a:pPr'));
  }
});

await check('default export is still one image per slide, no text', async () => {
  const out = path.join(tmp, 'static.pptx');
  run(path.join(root, 'template/deck.html'), out);
  const p = await load(out);
  assert.equal(p.count, 9);
  assert.ok(!/<a:t>/.test(p.slides[1]));
  assert.match(p.slides[1], /<p:pic>/);
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
