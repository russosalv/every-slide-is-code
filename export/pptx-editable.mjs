// Editable PowerPoint export: `deck.mjs pptx deck.html --editable`.
// For every slide at its rest frame one pass in the page reads the DOM (boxes, computed style, text runs, tables);
// pptxgenjs then rebuilds it as native objects. What cannot be converted well (SVG, canvas, images, gradients, shadows,
// ::before/::after paint, transformed or filtered subtrees) is cut out of the page as a transparent PNG at its exact
// rectangle. Stacking: slide background, then shapes and pictures in DOM order, then tables, then text on top.
import fs from 'node:fs';
import { PNG } from 'pngjs';
import JSZip from 'jszip';

const BG_SOLID_TOLERANCE = 3;   // per channel, over a sparse grid of the background shot
const RASTER_SCALE = 2;         // device pixels per slide pixel for cut-out pictures

/* ───────────── page side: runs inside Chrome, must not use anything from this module ───────────── */
function extractSlide({ i, W }) {
  const slide = document.querySelectorAll('.deck > .dk-layer > section.slide')[i];
  const sr = slide.getBoundingClientRect(), k = W / sr.width;
  const items = [], warn = new Set();
  let nRaster = 0;
  const R = r => ({ x: (r.left - sr.left) * k, y: (r.top - sr.top) * k, w: r.width * k, h: r.height * k });
  const px = v => parseFloat(v) || 0;
  const RASTER_TAGS = new Set(['svg', 'canvas', 'video', 'img', 'picture', 'iframe', 'object', 'embed']);

  // computed colours are rgb()/rgba() in practice; anything newer (oklch, color-mix) goes through a canvas
  const cv = document.createElement('canvas'); cv.width = cv.height = 1;
  const g2 = cv.getContext('2d', { willReadFrequently: true });
  const cache = new Map();
  const colour = s => {
    if (cache.has(s)) return cache.get(s);
    let c;
    const m = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/.exec(s);
    if (m) c = { r: +m[1], g: +m[2], b: +m[3], a: m[4] == null ? 1 : m[4].endsWith('%') ? parseFloat(m[4]) / 100 : +m[4] };
    else { g2.clearRect(0, 0, 1, 1); g2.fillStyle = '#000'; g2.fillStyle = s; g2.fillRect(0, 0, 1, 1); const d = g2.getImageData(0, 0, 1, 1).data; c = { r: d[0], g: d[1], b: d[2], a: d[3] / 255 }; }
    const hex = '' + [c.r, c.g, c.b].map(v => Math.round(v).toString(16).padStart(2, '0')).join('').toUpperCase();
    const out = { hex, a: c.a };
    cache.set(s, out); return out;
  };
  const identity = t => t === 'none' || /^matrix\(1, 0, 0, 1, [-\d.e]+, [-\d.e]+\)$/.test(t);
  // a reveal mask that stays at rest as inset(-40% -8% 0) clips nothing
  const noClip = c => c === 'none' || (/^inset\(/.test(c) && !/round/.test(c) && (c.match(/-?[\d.]+(?=[a-z%])/g) || []).every(v => parseFloat(v) <= 0));
  const flat = cs => identity(cs.transform) && cs.filter === 'none' && cs.mixBlendMode === 'normal' && noClip(cs.clipPath) && cs.maskImage === 'none' && cs.rotate === 'none' && cs.scale === 'none';

  function raster(el, mode, rect, pad = 0) {
    const n = ++nRaster; el.setAttribute('data-exn', n);
    const r = R(rect);
    items.push({ k: 'raster', n, mode, x: r.x - pad, y: r.y - pad, w: r.w + 2 * pad, h: r.h + 2 * pad });
  }
  // every inline descendant is plain inline (kinetic-text helpers named dk-* count as inline)
  const inlineLevel = el => {
    const cs = getComputedStyle(el);
    if (el.localName === 'br' || el.localName === 'wbr') return true;
    if (RASTER_TAGS.has(el.localName) || !flat(cs) || cs.position === 'absolute' || cs.position === 'fixed' || cs.float !== 'none') return false;
    const okDisplay = cs.display === 'inline' || cs.display === 'contents' || (/^inline-/.test(cs.display) && [...el.classList].some(c => /^dk-/.test(c)));
    return okDisplay && [...el.children].every(inlineLevel);
  };

  function font(cs, opacity) {
    const stack = cs.fontFamily.split(',').map(s => s.trim().replace(/^["']|["']$/g, ''));
    const GENERIC = { 'sans-serif': 'Arial', 'system-ui': 'Arial', '-apple-system': 'Arial', 'ui-sans-serif': 'Arial', serif: 'Times New Roman', 'ui-serif': 'Times New Roman',
      monospace: 'Courier New', 'ui-monospace': 'Courier New', cursive: 'Comic Sans MS', fantasy: 'Impact' };
    const family = stack.find(f => !GENERIC[f.toLowerCase()] && !/^(blinkmacsystemfont|segoe ui|helvetica neue|helvetica|arial)$/i.test(f)) || GENERIC[stack[0].toLowerCase()] || stack[0];
    const c = colour(cs.color), deco = cs.textDecorationLine;
    return { face: family, size: px(cs.fontSize), bold: +cs.fontWeight >= 600 || cs.fontWeight === 'bold', italic: cs.fontStyle === 'italic',
      color: c.hex, alpha: c.a * opacity, underline: deco.includes('underline'), strike: deco.includes('line-through'),
      spacing: cs.letterSpacing === 'normal' ? 0 : px(cs.letterSpacing), caps: cs.textTransform };
  }
  const cased = (t, tt) => (tt === 'uppercase' ? t.toUpperCase() : tt === 'lowercase' ? t.toLowerCase() : tt === 'capitalize' ? t.replace(/(^|\s)(\S)/g, (_, a, b) => a + b.toUpperCase()) : t);

  // text of a node in CSS terms: whitespace collapsed unless the element preserves it
  const prepared = (node, cs) => {
    let t = node.textContent;
    if (!/^pre/.test(cs.whiteSpace)) t = t.replace(/[\t\n\r\f ]+/g, ' '); else if (cs.whiteSpace === 'pre-line') t = t.replace(/[\t\f ]+/g, ' ');
    return t;
  };

  /* a group of text nodes and inline elements that sit in one block: becomes one text box */
  function textGroup(host, hcs, opacity, parts, marker) {
    const nodes = parts.filter(p => p.node).map(p => p.node);
    const runs = [];
    for (const p of parts) {
      const f = font(p.cs, opacity), bg = colour(p.cs.backgroundColor);
      const text = p.br ? '\n' : cased(p.text, f.caps);
      const prev = runs[runs.length - 1];
      runs.push({ ...f, text, hl: bg.a > .5 ? bg.hex : null, prevSpace: prev && /[ \n]$/.test(prev.text) });
    }
    // CSS drops a space that follows a space or a break, and spaces at the edges of the block
    for (const r of runs) if (r.prevSpace && r.text.startsWith(' ')) r.text = r.text.slice(1);
    while (runs.length && !runs[0].text.replace(/^ +/, '')) runs.shift();
    if (runs.length) runs[0].text = runs[0].text.replace(/^ +/, '');
    while (runs.length && !runs.at(-1).text.replace(/ +$/, '') && runs.at(-1).text !== '\n') runs.pop();
    if (runs.length) runs.at(-1).text = runs.at(-1).text.replace(/ +$/, '');
    const merged = [];
    for (const r of runs) {
      const l = merged.at(-1);
      if (l && ['face', 'size', 'bold', 'italic', 'color', 'alpha', 'underline', 'strike', 'spacing', 'hl'].every(p => l[p] === r[p])) l.text += r.text; else merged.push({ ...r });
    }
    if (!merged.some(r => r.text.trim())) return;
    if (merged.some(r => r.alpha < .02)) { if (hcs.webkitTextFillColor && colour(hcs.webkitTextFillColor).a === 0) { warn.add('gradient/transparent text kept as a picture'); raster(host, 'sub', host.getBoundingClientRect()); } return; }

    // geometry from the browser's own line boxes
    const rects = [];
    for (const n of nodes) { const rg = document.createRange(); rg.selectNodeContents(n); for (const q of rg.getClientRects()) if (q.width > .5 && q.height > 1) rects.push(q); }
    let u;
    if (rects.length) {
      const x0 = Math.min(...rects.map(q => q.left)), y0 = Math.min(...rects.map(q => q.top)), x1 = Math.max(...rects.map(q => q.right)), y1 = Math.max(...rects.map(q => q.bottom));
      u = R({ left: x0, top: y0, width: x1 - x0, height: y1 - y0 });
    } else u = R(host.getBoundingClientRect());
    const mids = rects.map(q => (q.top + q.bottom) / 2).sort((a, b) => a - b), tol = Math.max(4, Math.min(...rects.map(q => q.height), 999) * .4), lines = [];
    for (const m of mids) if (!lines.length || m - lines.at(-1) > tol) lines.push(m);
    const hardBreaks = merged.filter(r => r.text === '\n').length;
    const nLines = Math.max(lines.length, 1);
    const ta = hcs.textAlign;
    if (marker) {   // an outside list marker sits one em to the left of the text, in the first run's style
      const f = merged[0], mw = f.size * 1.2 * k;
      items.push({ k: 'text', x: u.x - mw - f.size * .5 * k, y: u.y, w: mw, h: Math.min(u.h, (lines.length > 1 ? (lines[1] - lines[0]) * k : u.h)), align: 'right', lines: 1, lineStep: 0, glyphH: 0, hardBreaks: 0, runs: [{ ...f, text: marker }] });
    }
    items.push({ k: 'text', ...u, align: ta === 'center' ? 'center' : (ta === 'right' || ta === 'end') ? 'right' : 'left', lines: nLines,
      lineStep: nLines > 1 ? ((lines.at(-1) - lines[0]) / (nLines - 1)) * k : 0, glyphH: Math.min(...rects.map(q => q.height)) * k, hardBreaks, runs: merged.map(({ prevSpace, ...r }) => r) });
  }

  function listMarker(el, cs) {
    const t = cs.listStyleType;
    if (cs.display !== 'list-item' || t === 'none' || cs.listStylePosition === 'inside') return null;
    if (t === 'disc') return '\u2022'; if (t === 'circle') return '\u25E6'; if (t === 'square') return '\u25AA';
    if (/decimal|lower|upper/.test(t)) {
      const ol = el.parentElement; const n = (ol && ol.localName === 'ol' ? (ol.start || 1) : 1) + [...(ol ? ol.children : [])].indexOf(el);
      if (t === 'decimal') return n + '.';
      const a = String.fromCharCode((t.startsWith('upper') ? 64 : 96) + ((n - 1) % 26) + 1); return a + '.';
    }
    return null;
  }

  function flow(el, cs, opacity) {
    let parts = [], marker = listMarker(el, cs);
    const flush = () => { if (parts.length) { textGroup(el, cs, opacity, parts, marker); marker = null; } parts = []; };
    const addInline = (node, ecs) => {
      if (node.nodeType === 3) { const t = prepared(node, ecs); if (t) parts.push({ node, text: t, cs: ecs }); }
      else if (node.localName === 'br') parts.push({ br: true, cs: ecs });
      else if (node.nodeType === 1) {
        const ics = getComputedStyle(node); if (ics.display === 'none') return;
        if (ics.backgroundImage !== 'none') raster(node, 'self', node.getBoundingClientRect());   // a highlighter mark: the text on top stays native
        before(node, ics); for (const c of node.childNodes) addInline(c, ics); after(node, ics); }
    };
    // ::before / ::after: a plain text string becomes part of the text; any other generated content is cut out as a picture
    const pseudoText = (host, hcs, which) => {
      const p = getComputedStyle(host, which), c = p.content;
      if (!c || c === 'none' || c === 'normal') return null;
      const m = /^"((?:[^"\\]|\\.)*)"$/.exec(c);
      if (m && m[1] && p.display === 'inline' && p.position === 'static') return { text: m[1].replace(/\\(.)/g, '$1'), cs: p };
      return false;
    };
    const before = (host, hcs) => { const t = pseudoText(host, hcs, '::before'); if (t) parts.push(t); };
    const after = (host, hcs) => { const t = pseudoText(host, hcs, '::after'); if (t) parts.push(t); };
    before(el, cs);
    for (const c of el.childNodes) {
      if (c.nodeType === 3) { addInline(c, cs); continue; }
      if (c.nodeType !== 1) continue;
      const ccs = getComputedStyle(c);
      if (ccs.display === 'none') continue;
      if (inlineLevel(c)) addInline(c, cs); else { flush(); walk(c, opacity); }
    }
    after(el, cs);
    flush();
  }

  function sides(cs) {
    return ['Top', 'Right', 'Bottom', 'Left'].map(s => {
      const w = px(cs['border' + s + 'Width']), c = colour(cs['border' + s + 'Color']);
      return { w: cs['border' + s + 'Style'] === 'none' ? 0 : w, hex: c.hex, a: c.a };
    });
  }

  function box(el, cs, rect, opacity) {
    const r = R(rect), bg = colour(cs.backgroundColor), b = sides(cs).map(s => (s.w * k >= .5 && s.a > .02 ? s : { ...s, w: 0 }));
    const rv = cs.borderTopLeftRadius.split(' ')[0], rad = Math.min(rv.endsWith('%') ? parseFloat(rv) / 100 * Math.min(r.w, r.h) : px(rv) * k, r.w / 2, r.h / 2);
    const shadow = cs.boxShadow !== 'none', pseudo = ['::before', '::after'].some(w => { const c = getComputedStyle(el, w).content; return c && c !== 'none' && c !== 'normal' && !pseudoIsInlineText(el, w); });
    if (cs.backgroundImage !== 'none') { raster(el, 'self', rect); return; }
    if (bg.a > .02 || b.some(s => s.w)) items.push({ k: 'shape', ...r, fill: bg.a > .02 ? bg.hex : null, alpha: bg.a * opacity, radius: rad, round: rad >= Math.min(r.w, r.h) / 2 - .5, sides: b, op: opacity });
    if (shadow || pseudo) raster(el, 'decor', rect, 100);
  }
  function pseudoIsInlineText(el, w) { const p = getComputedStyle(el, w), m = /^"[^"]+"$/.test(p.content); return m && p.display === 'inline' && p.position === 'static'; }

  function table(el, cs, rect, opacity) {
    const rows = [...el.rows], r0 = R(rect), edges = new Set();
    const cells = [];
    rows.forEach((tr, ri) => {
      const rcs = getComputedStyle(tr), rbg = colour(rcs.backgroundColor);
      for (const td of tr.cells) {
        const q = R(td.getBoundingClientRect()), tcs = getComputedStyle(td), f = font(tcs, opacity), bg = colour(tcs.backgroundColor);
        edges.add(Math.round(q.x * 2) / 2); edges.add(Math.round((q.x + q.w) * 2) / 2);
        let text = '';
        const walkText = n => { if (n.nodeType === 3) text += prepared(n, tcs); else if (n.localName === 'br') text += '\n'; else if (n.nodeType === 1 && getComputedStyle(n).display !== 'none') n.childNodes.forEach(walkText); };
        td.childNodes.forEach(walkText);
        text = cased(text.replace(/ *\n */g, '\n').trim(), f.caps);
        cells.push({ ri, x: q.x, w: q.w, text, f, fill: bg.a > .02 ? bg.hex : rbg.a > .02 ? rbg.hex : null, align: tcs.textAlign === 'center' ? 'center' : (tcs.textAlign === 'right' || tcs.textAlign === 'end') ? 'right' : 'left',
          valign: tcs.verticalAlign === 'middle' ? 'middle' : tcs.verticalAlign === 'bottom' ? 'bottom' : 'top', rowspan: td.rowSpan, colspan: td.colSpan, sides: sides(tcs),
          pad: ['Top', 'Right', 'Bottom', 'Left'].map(s => px(tcs['padding' + s]) * k) });
      }
    });
    const xs = [...edges].sort((a, b) => a - b);
    for (const c of cells) { c.col0 = xs.findIndex(e => Math.abs(e - Math.round(c.x * 2) / 2) < 1); c.col1 = xs.findIndex(e => Math.abs(e - Math.round((c.x + c.w) * 2) / 2) < 1); }
    items.push({ k: 'table', ...r0, colW: xs.slice(1).map((e, j) => e - xs[j]), rowH: rows.map(tr => tr.getBoundingClientRect().height * k), cells, nCols: xs.length - 1 });
  }

  // an svg with overflow: visible paints outside its own box (a badge on the edge, a thick stroke): cut out what it really covers
  function svgReach(svg, rect) {
    let x0 = rect.left, y0 = rect.top, x1 = rect.right, y1 = rect.bottom;
    for (const c of svg.querySelectorAll('*')) {
      const q = c.getBoundingClientRect();
      if (q.width || q.height) { const m = (parseFloat(getComputedStyle(c).strokeWidth) || 0) / 2 + 2; x0 = Math.min(x0, q.left - m); y0 = Math.min(y0, q.top - m); x1 = Math.max(x1, q.right + m); y1 = Math.max(y1, q.bottom + m); }
    }
    return { left: x0, top: y0, width: x1 - x0, height: y1 - y0 };
  }

  function walk(el, inherited) {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') return;
    const opacity = inherited * px(cs.opacity === '' ? 1 : cs.opacity);
    if (opacity < .02 || el.localName === 'aside') return;
    const rect = el.getBoundingClientRect();
    const out = rect.right < sr.left || rect.left > sr.right || rect.bottom < sr.top || rect.top > sr.bottom;
    if (cs.display === 'contents') { flow(el, cs, opacity); return; }
    if ((rect.width < .5 || rect.height < .5) && !el.textContent.trim()) return;
    if (out) return;
    if (RASTER_TAGS.has(el.localName) || !flat(cs)) { raster(el, 'sub', el.localName === 'svg' && cs.overflow === 'visible' ? svgReach(el, rect) : rect); return; }
    box(el, cs, rect, opacity);
    if (el.localName === 'table') { table(el, cs, rect, opacity); return; }
    flow(el, cs, opacity);
  }

  // slide-level paint (background, ::before/::after of the slide itself) is baked into the background picture
  const scs = getComputedStyle(slide);
  for (const c of slide.children) walk(c, px(scs.opacity === '' ? 1 : scs.opacity) || 1);
  return { items, warn: [...warn] };
}

/* ───────────── node side ───────────── */
const HIDE_ALL = `.deck *{visibility:hidden!important}`;
const RASTER_CSS = `html,body,.deck,.dk-layer,.slide{background:transparent!important}${HIDE_ALL}
.deck [data-ex]{visibility:visible!important}
.deck [data-ex="sub"] *{visibility:visible!important}
.deck [data-ex="decor"]{background:none!important;border-color:transparent!important}
.deck [data-ex="self"],.deck [data-ex="decor"]{color:transparent!important;-webkit-text-fill-color:transparent!important;text-shadow:none!important}`;
const BG_CSS = `.slide *{visibility:hidden!important}`;

function isFlat(png) {
  const { data, width, height } = PNG.sync.read(png);
  let first = null;
  for (let y = 0; y < height; y += Math.ceil(height / 24)) for (let x = 0; x < width; x += Math.ceil(width / 40)) {
    const o = (y * width + x) * 4;
    if (!first) first = [data[o], data[o + 1], data[o + 2]];
    else for (let c = 0; c < 3; c++) if (Math.abs(data[o + c] - first[c]) > BG_SOLID_TOLERANCE) return null;
  }
  return first.map(v => v.toString(16).padStart(2, '0')).join('').toUpperCase();
}

const PT = 0.5;   // 1 slide pixel (1920 wide) = 0.5 pt on a 13.333 in slide

/**
 * Adds one editable slide per state of `list` to `pptx`.
 * Returns counts for the fidelity report: { slides, text, shape, table, picture, warnings[] }.
 */
export async function addEditableSlides({ page, meta, list, pptx, wIn }) {
  const u = wIn / meta.W;   // slide pixels -> inches
  const stats = { slides: 0, text: 0, shape: 0, table: 0, picture: 0, background: 0, warnings: [], fonts: new Set() };
  const warnAt = (st, w) => stats.warnings.push(`slide ${st.i + 1}: ${w}`);

  for (const st of list) {
    await page.evaluate(({ i, step }) => window.__deck.show(i, step), st);
    await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
    const { items, warn } = await page.evaluate(extractSlide, { i: st.i, W: meta.W });
    warn.forEach(w => warnAt(st, w));
    const clipOf = it => {
      const x = Math.max(0, Math.floor(it.x)), y = Math.max(0, Math.floor(it.y));
      return { x, y, width: Math.min(meta.W, Math.ceil(it.x + it.w)) - x, height: Math.min(meta.H, Math.ceil(it.y + it.h)) - y };
    };

    // background: the slide with every element hidden; a flat colour becomes the slide background, anything else a picture
    await page.evaluate(css => { const s = document.createElement('style'); s.id = '__ex'; s.textContent = css; document.head.append(s); }, BG_CSS);
    const bgPng = await page.screenshot({ type: 'png', clip: { x: 0, y: 0, width: meta.W, height: meta.H } });
    const flatHex = isFlat(bgPng);
    const bgJpg = flatHex ? null : await page.screenshot({ type: 'jpeg', quality: 90, clip: { x: 0, y: 0, width: meta.W, height: meta.H } });
    await page.evaluate(css => { document.getElementById('__ex').textContent = css; }, RASTER_CSS);

    const s = pptx.addSlide();
    if (flatHex) s.background = { color: flatHex };
    else { s.addImage({ data: 'data:image/jpeg;base64,' + bgJpg.toString('base64'), x: 0, y: 0, w: wIn, h: meta.H * u, altText: 'Background' }); stats.background++; }

    const rect = o => ({ x: o.x * u, y: o.y * u, w: o.w * u, h: o.h * u });
    const colorOf = (hex, alpha) => ({ color: hex, ...(alpha < .98 ? { transparency: Math.round((1 - alpha) * 100) } : {}) });
    const texts = [], tables = [];

    for (const it of items) {
      if (it.k === 'raster') {
        const clip = clipOf(it);
        if (clip.width < 1 || clip.height < 1) continue;
        await page.evaluate(({ n, mode }) => document.querySelector(`[data-exn="${n}"]`).setAttribute('data-ex', mode), it);
        const png = await page.screenshot({ type: 'png', omitBackground: true, clip });
        await page.evaluate(n => document.querySelector(`[data-exn="${n}"]`).removeAttribute('data-ex'), it.n);
        s.addImage({ data: 'data:image/png;base64,' + png.toString('base64'), ...rect({ x: clip.x, y: clip.y, w: clip.width, h: clip.height }) });
        stats.picture++;
      } else if (it.k === 'shape') {
        const sd = it.sides, uniform = sd.every(q => q.w === sd[0].w && q.hex === sd[0].hex);
        const kind = it.round && Math.abs(it.w - it.h) < 1.5 ? pptx.ShapeType.ellipse : it.radius > .5 ? pptx.ShapeType.roundRect : pptx.ShapeType.rect;
        const line = uniform && sd[0].w ? { color: sd[0].hex, width: sd[0].w * PT, ...(sd[0].a < .98 ? { transparency: Math.round((1 - sd[0].a) * 100) } : {}) } : { type: 'none' };
        s.addShape(kind, { ...rect(it), fill: it.fill ? colorOf(it.fill, it.alpha) : { type: 'none' }, line, ...(kind === pptx.ShapeType.roundRect ? { rectRadius: it.radius * u } : {}) });
        stats.shape++;
        if (!uniform) {   // a border on some sides only: thin filled rectangles
          const [t, r, b, l] = sd;
          const bar = (q, x, y, w, h) => { if (q.w) { s.addShape(pptx.ShapeType.rect, { ...rect({ x, y, w, h }), fill: colorOf(q.hex, q.a), line: { type: 'none' } }); stats.shape++; } };
          bar(t, it.x, it.y, it.w, t.w); bar(b, it.x, it.y + it.h - b.w, it.w, b.w); bar(l, it.x, it.y, l.w, it.h); bar(r, it.x + it.w - r.w, it.y, r.w, it.h);
        }
      } else if (it.k === 'table') tables.push(it);
      else texts.push(it);
    }

    for (const t of tables) {
      const side = q => (q.w ? { type: 'solid', pt: q.w * PT, color: q.hex } : { type: 'none' });
      const byRow = t.rowH.map(() => []);
      for (const c of t.cells) byRow[c.ri].push(c);
      const rows = byRow.map(cs => cs.sort((a, b) => a.x - b.x).map(c => ({
        text: c.text,
        options: { fontFace: c.f.face, fontSize: c.f.size * PT, bold: c.f.bold, italic: c.f.italic, color: c.f.color, align: c.align, valign: c.valign, charSpacing: c.f.spacing * PT,
          ...(c.fill ? { fill: { color: c.fill } } : {}), border: c.sides.map(side), margin: c.pad.map(p => Math.min(.99, p * u)),
          colspan: Math.max(1, c.col1 - c.col0), rowspan: c.rowspan },
      })));
      t.cells.forEach(c => stats.fonts.add(c.f.face));
      s.addTable(rows, { x: t.x * u, y: t.y * u, w: t.w * u, colW: t.colW.map(w => w * u), rowH: t.rowH.map(h => h * u), autoPage: false });
      stats.table++;
    }

    for (const t of texts) {
      // text box = the browser's own text rectangle, a little wider so a font that is wider in PowerPoint does not wrap
      const slack = t.lines > 1 ? .01 : .03, extra = t.w * slack + 4;
      let x = t.x, w = t.w + extra;
      if (t.align === 'center') x = t.x - extra / 2; else if (t.align === 'right') x = t.x - extra;
      // paragraph properties go on the first run of each paragraph only: pptxgenjs writes a <a:pPr> for every run that carries one
      const lineSpacing = t.lines > 1 && t.lineStep && t.glyphH ? Math.round(t.lineStep / t.glyphH * 100) / 100 : 0;
      const runs = []; let startsPara = true;
      t.runs.forEach(r => {
        const opts = { fontFace: r.face, fontSize: Math.max(1, r.size * PT), bold: r.bold, italic: r.italic, color: r.color, charSpacing: r.spacing * PT, ...(r.alpha < .98 ? { transparency: Math.round((1 - r.alpha) * 100) } : {}),
          ...(r.underline ? { underline: { style: 'sng' } } : {}), ...(r.strike ? { strike: 'sngStrike' } : {}), ...(r.hl ? { highlight: r.hl } : {}) };
        r.text.split('\n').forEach((part, j) => {
          if (j > 0 && runs.length) { runs.at(-1).options.breakLine = true; startsPara = true; }
          if (!part) return;
          runs.push({ text: part, options: { ...opts, ...(startsPara ? { align: t.align, ...(lineSpacing ? { lineSpacingMultiple: lineSpacing } : {}) } : {}) } });
          startsPara = false;
        });
      });
      if (!runs.length) continue;
      // tight line spacing (<100%) lifts the first line in PowerPoint and LibreOffice; .4 of the difference is a measured correction
      s.addText(runs, { ...rect({ x, y: t.y + (lineSpacing ? .4 * Math.max(0, t.glyphH - t.lineStep) : 0), w, h: t.h }), valign: 'middle', margin: 0, wrap: t.lines > 1 && t.lines > t.hardBreaks + 1, fit: 'none' });
      stats.text++; t.runs.forEach(r => stats.fonts.add(r.face));
    }

    const n = meta.deck[st.i].notes; if (n) s.addNotes(n);
    await page.evaluate(() => { document.getElementById('__ex')?.remove(); document.querySelectorAll('[data-exn],[data-ex]').forEach(e => { e.removeAttribute('data-exn'); e.removeAttribute('data-ex'); }); });
    stats.slides++;
  }
  return stats;
}

export function formatReport(stats) {
  const native = stats.text + stats.shape + stats.table, total = native + stats.picture;
  const pct = total ? Math.round(100 * native / total) : 100;
  return `${stats.text} text boxes, ${stats.shape} shapes, ${stats.table} tables native; ${stats.picture} cut-out pictures` +
    `${stats.background ? ` + ${stats.background} picture backgrounds` : ''} (${pct}% of objects native)` +
    `${stats.fonts.size ? `\n  fonts used (install them where the file is opened; they are not embedded): ${[...stats.fonts].join(', ')}` : ''}`;
}

/**
 * Writes the file. pptxgenjs puts a <a:pPr> in front of every run of a paragraph; the schema allows one, first.
 * The extra ones are removed so strict readers (PowerPoint, Keynote, Google Slides) get a valid file.
 */
export async function writeEditable(pptx, file) {
  const zip = await JSZip.loadAsync(await pptx.write({ outputType: 'nodebuffer' }));
  for (const name of Object.keys(zip.files).filter(n => /^ppt\/slides\/slide\d+\.xml$/.test(n))) {
    const xml = await zip.file(name).async('string');
    zip.file(name, xml.replace(/<a:p>[\s\S]*?<\/a:p>/g, p => {
      let seen = 0;
      return p.replace(/<a:pPr\b[^>]*?(?:\/>|>[\s\S]*?<\/a:pPr>)/g, m => (seen++ ? '' : m));
    }));
  }
  fs.writeFileSync(file, await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
}
