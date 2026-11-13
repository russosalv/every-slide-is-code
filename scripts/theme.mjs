// Theme lookup and inlining for deck-kit (16-themes.md). A theme is a folder: theme.css (+ theme.json).
// Used by scripts/sync-runtime.mjs; no dependencies.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const KIT_THEMES = path.join(root, 'themes');
export const VARIANTS = ['light', 'dark'];
const NAME = /^[A-Za-z0-9][\w.-]*$/;   // a bare name; anything with a separator is a path

// Folders searched by name: the kit's themes/, then DECK_KIT_THEMES (path-delimiter separated: ":" on Linux and macOS).
export function searchDirs(env = process.env.DECK_KIT_THEMES) {
  return [KIT_THEMES, ...(env || '').split(path.delimiter).filter(Boolean).map(d => path.resolve(d))];
}
const isTheme = d => fs.existsSync(path.join(d, 'theme.css'));

export function listThemes(env) {
  const seen = new Set(), out = [];
  for (const base of searchDirs(env)) {
    if (!fs.existsSync(base)) continue;
    for (const e of fs.readdirSync(base, { withFileTypes: true })) {
      const d = path.join(base, e.name);
      if (e.isDirectory() && isTheme(d) && !seen.has(e.name)) { seen.add(e.name); out.push({ name: e.name, dir: d }); }
    }
  }
  return out;
}

// "paper" -> themes/paper, then <DECK_KIT_THEMES entry>/paper; "./mine" or "/abs/mine" -> that folder.
export function resolveTheme(spec, { env, cwd = process.cwd() } = {}) {
  if (!spec) throw new Error('--theme needs a theme name or a folder');
  const tried = [];
  if (NAME.test(spec)) {
    for (const base of searchDirs(env)) {
      const d = path.join(base, spec);
      if (isTheme(d)) return d;
      tried.push(d);
    }
  }
  const direct = path.resolve(cwd, spec);
  if (isTheme(direct)) return direct;
  tried.push(direct);
  const names = listThemes(env).map(t => t.name);
  throw new Error(`theme "${spec}" not found (needs a theme.css). Looked in:\n  ${tried.join('\n  ')}\nAvailable: ${names.join(', ') || 'none'}`);
}

export function loadTheme(dir) {
  const css = fs.readFileSync(path.join(dir, 'theme.css'), 'utf8').trim();
  const jf = path.join(dir, 'theme.json');
  let meta = {};
  if (fs.existsSync(jf)) {
    try { meta = JSON.parse(fs.readFileSync(jf, 'utf8')); } catch (e) { throw new Error(`${jf}: ${e.message}`); }
  }
  const variants = Array.isArray(meta.variants) ? meta.variants : [];
  if (variants.some(v => !VARIANTS.includes(v))) throw new Error(`${jf}: variants may only be "light" and "dark"`);
  const def = meta.default || variants[0] || '';
  if (def && variants.length && !variants.includes(def)) throw new Error(`${jf}: default "${def}" is not in variants`);
  const t = { name: String(meta.name || path.basename(dir)), description: meta.description || '', fonts: meta.fonts || '', brand: meta.brand || '', variants, default: def, css, dir };
  if (/<\/style/i.test(css)) throw new Error(`${dir}/theme.css contains "</style"`);
  if (/<script/i.test(t.brand)) throw new Error(`${dir}/theme.json: brand must not contain <script>`);
  if (t.fonts && !/^https:\/\/fonts\.googleapis\.com\/[^\s"'<>]*$/.test(t.fonts)) throw new Error(`${dir}/theme.json: fonts must be a https://fonts.googleapis.com/ URL`);
  return t;
}

const SLOT = /<style id="deck-kit-theme">[\s\S]*?<\/style>/;
const FONTS = /[ \t]*<link id="deck-kit-theme-fonts"[^>]*>\n?/;
const BRAND = /<!--dk-brand-->[\s\S]*?<!--\/dk-brand-->/g;
const SLIDE = /<section\b(?=[^>]*\bclass="[^"]*\bslide\b)(?![^>]*\bdata-brand="off")[^>]*>/g;

// Returns the deck html with the theme inlined: fonts link + <style id="deck-kit-theme"> + the brand in every slide.
// theme === null empties the slot. Running it twice gives the same file.
export function applyTheme(html, theme) {
  const cut = html.indexOf('<script id="deck-kit-js">');
  let head = cut < 0 ? html : html.slice(0, cut);
  const tail = cut < 0 ? '' : html.slice(cut);
  head = head.replace(FONTS, '').replace(BRAND, '');
  if (!SLOT.test(head)) {
    if (!theme) return head + tail;
    if (!/<\/head>/.test(head)) throw new Error('no </head> to put the theme slot in');
    head = head.replace('</head>', () => '<style id="deck-kit-theme"></style>\n</head>');
  }
  const fonts = theme?.fonts ? `<link id="deck-kit-theme-fonts" rel="stylesheet" href="${theme.fonts}">\n` : '';
  const style = theme ? `<style id="deck-kit-theme">\n/* theme: ${theme.name.replace(/\*\//g, '')} */\n${theme.css}\n</style>` : '<style id="deck-kit-theme"></style>';
  head = head.replace(SLOT, () => fonts + style);
  if (theme?.brand) head = head.replace(SLIDE, m => `${m}<!--dk-brand--><div class="dk-brand">${theme.brand}</div><!--/dk-brand-->`);
  return head + tail;
}

// data-theme on the first .deck element: how a deck fixes its default variant (null removes it). Only the markup before the runtime script is touched.
const DECK_TAG = /<div\b(?=[^>]*\bclass="(?:[^"]*\s)?deck(?:\s[^"]*)?")[^>]*>/;
export function setVariant(html, variant) {
  if (variant && !VARIANTS.includes(variant)) throw new Error(`variant must be light or dark (got "${variant}")`);
  const cut = html.indexOf('<script id="deck-kit-js">');
  const head = cut < 0 ? html : html.slice(0, cut);
  if (!DECK_TAG.test(head)) throw new Error('no <div class="deck"> to set the variant on');
  const tag = head.match(DECK_TAG)[0].replace(/\s+data-theme="[^"]*"/, '').replace(/^<div\b/, variant ? `<div data-theme="${variant}"` : '<div');
  return head.replace(DECK_TAG, () => tag) + (cut < 0 ? '' : html.slice(cut));
}

// Does the deck carry a theme in its slot?
export const hasTheme = html => /<style id="deck-kit-theme">\s*[^\s<]/.test(html);

// The URL convention for exports: the page is loaded with ?theme=<variant>, which the runtime honours in every mode.
// export/deck.mjs can call this on the URL it opens (a --theme-variant dark option); hash and existing query are kept.
export function withVariant(url, variant) {
  if (!variant) return url;
  if (!VARIANTS.includes(variant)) throw new Error(`variant must be light or dark (got "${variant}")`);
  const u = new URL(url);
  u.searchParams.set('theme', variant);
  return u.href;
}
