# Themes

A theme is a look you can swap without touching the slides: palette, fonts, a few reusable component classes and, optionally, a brand mark. It is kept outside the deck as a folder, inlined into the deck by `sync-runtime.mjs`, so the deck stays one self-contained file. Switching theme means running sync again with another `--theme`.

The kit ships two neutral examples (`themes/paper`, `themes/ink`). Company themes do not belong in this repo: keep them in your own folder and point `DECK_KIT_THEMES` at it.

## Using a theme

```bash
node scripts/sync-runtime.mjs --new my-deck.html --theme paper         # new deck in the theme
node scripts/sync-runtime.mjs --theme ink my-deck.html                 # change theme (idempotent: same command, same file)
node scripts/sync-runtime.mjs --theme ink --variant dark my-deck.html  # which variant the deck opens in
node scripts/sync-runtime.mjs --variant light my-deck.html             # only the default variant
node scripts/sync-runtime.mjs --theme none my-deck.html                # back to the deck's own look
node scripts/sync-runtime.mjs --list-themes
```

`--theme` takes a name or a folder. A name is looked up in this order: the kit's `themes/`, then each folder in `DECK_KIT_THEMES` (separated by `:`; `;` on Windows), then it is read as a path (`--theme ../brand/acme`). A plain `sync-runtime.mjs my-deck.html` refreshes the runtime and leaves the theme as it is. A deck made before themes existed works unchanged; the first `--theme` adds the slot to it.

```bash
export DECK_KIT_THEMES="$HOME/brand/themes:/shared/deck-themes"
node scripts/sync-runtime.mjs --new q3.html --theme acme
```

## What sync writes into the deck

| Where | What |
|---|---|
| `<style id="deck-kit-theme">` | `theme.css`, after the deck's own `<style>`, so its tokens win. Empty in the template, so the default look is unchanged |
| `<link id="deck-kit-theme-fonts">` | the Google Fonts URL from `theme.json`, right before the slot |
| `<!--dk-brand-->…<!--/dk-brand-->` | the `brand` fragment, first child of every slide |
| `data-theme="light\|dark"` on `.deck` | the variant the deck opens in |

All four are managed by sync: it replaces them as a whole and never edits anything else. Put your own CSS in the deck's own `<style>`, not in the slot.

## Theme folder

```
themes/<name>/
  theme.css     tokens and optional component classes
  theme.json    name, description, fonts, brand, variants
```

`theme.json`:

```json
{
  "name": "acme",
  "description": "Acme corporate look, light and dark",
  "fonts": "https://fonts.googleapis.com/css2?family=Inter:wght@400;600&display=block",
  "brand": "<img src=\"data:image/svg+xml;base64,...\" alt=\"Acme\" height=\"36\">",
  "variants": ["light", "dark"],
  "default": "light"
}
```

- `name` (default: the folder name) and `description` appear in `--list-themes`.
- `fonts`, optional: a `https://fonts.googleapis.com/` URL, loaded with `display=block` like every deck font (09-typography.md). No other host is accepted.
- `brand`, optional: an HTML fragment, a logo or a wordmark, put in every slide as `<div class="dk-brand">…</div>`. Position it in `theme.css` (`.dk-brand { position: absolute; right: 150px; top: 60px }`). A slide opts out with `data-brand="off"` (a full-bleed photo, the title slide). Inline the logo as an SVG or a data URI: a theme must not need another file. No `<script>`.
- `variants` and `default`: see below. Omit them for a theme with one look.

`theme.css` defines tokens on `:root` and may add classes. Tokens:

| Token | Role |
|---|---|
| `--bg --ink --muted --rule --accent --accent-text` | the six roles of 04-slide-design.md; `--accent-text` is the accent darkened (or lightened) to 4.5:1 for small text |
| `--line`, `--accent-soft`, `--surface`, `--on-accent` | what the template's primitives read: `--line: var(--rule)`, the marker colour, the card and node fill, text on an accent fill. Fall back to the template's values when a theme omits them |
| `--second --second-text --on-second` | the second accent, when the deck gives it a meaning |
| `--display --text --mono` | font stacks, named like the fonts in `theme.json` |
| `--dk-*` | the runtime hooks (`--dk-mark`, `--dk-letterbox`, `--dk-progress`, `--dk-number`, `--dk-ov-accent`, `--dk-pen-1`…, `--dk-say-*`, `--dk-code-*`; 01-runtime.md and the plugin files list them all) |

Components in a deck read these variables and never a literal colour. Then a variant is one block of tokens and every slide follows. When you add component classes to a theme (`.panel`, `.tag`, `.stat`), the same rule holds. A `var()` inside a custom property is resolved where it is declared, so a token that refers to another one (`--line: var(--rule)`, `--dk-mark: var(--accent-soft)`) is repeated in the variant block that changes the token it refers to.

## Light and dark variants

Each theme can carry both. The default variant sits on `:root`; the other one under a `data-theme` selector, tokens only:

```css
:root { --bg: #f4f2ee; --ink: #342e24; --accent: #0f7b5f; --line: var(--rule); /* … */ }
:root[data-theme="dark"], .deck[data-theme="dark"] { --bg: #16130f; --ink: #e5ddd0; --accent: #3fb893; --line: var(--rule); /* … */ }
```

(A dark default mirrors it: the dark tokens on `:root`, the light ones under `[data-theme="light"]`.) The runtime paints `data-theme` on `.deck` and on `<html>`, so both selectors work and the letterbox follows.

The variant is decided, in this order, by:

1. `?theme=dark` or `?theme=light` in the URL (every mode, including `?render` and the previews);
2. the presenter's last choice, remembered in `localStorage` (live and presenter windows only; storage that is blocked is ignored);
3. `data-theme` on `.deck` in the source, which `--variant` writes.

Switching, with nothing to regenerate:

- **T** in the deck, or the half-moon button in the control bar. Both appear only when the deck has variants; `?` lists the key.
- **Presenter view**: it opens in the same variant, its previews follow, and the ◐ button in its header (or **T**) switches both windows. A choice made in either window reaches the other.
- `Deck.variant()` returns the current variant (`''` for a deck without variants); `Deck.variant('dark')` sets it, without saving it.

Both variants must keep the contrast rules. Generate them from one accent (below) and `check` both: `check` measures what is painted, so run it once per variant.

## Export

The exporter loads the deck with `?render`, so the variant is the one in the source unless the URL says otherwise. Convention for choosing it at export time: add `?theme=<variant>` to the URL the exporter opens. `scripts/theme.mjs` exports `withVariant(url, variant)` for that; an option `--theme-variant dark|light` on `check`, `sheet`, `pdf`, `pptx`, `mp4`… only has to call it where the page URL is built. Until it is wired, export a variant by fixing it in the file (`sync-runtime.mjs --variant dark deck.html`) or by opening a copy.

## Make a theme

From one accent, with the palette generator (04-slide-design.md):

```bash
node scripts/palette.mjs --accent "#0f7b5f" --bg "#f4f2ee" --name acme \
  --fonts-url "https://fonts.googleapis.com/css2?family=Inter:wght@400;600&display=block" \
  --display '"Inter", system-ui, sans-serif' --text '"Inter", system-ui, sans-serif' \
  --theme-out ~/brand/themes/acme
```

`--bg` chooses the default variant (`light`, `dark` or a hex); the other variant is computed from the same accent on the opposite background. Both are written with the guarantees of the palette table: ink 7:1, muted 4.5:1, accent text 4.5:1. Then edit `theme.css` by hand: brand colours that the generator softened, a logo in `theme.json`, component classes.

To make a theme from an existing brand: give `--accent` the brand colour, `--bg` its background, `--second` its second colour, then replace generated values only where the brand fixes them, and run the contrast table again.

## Limits

- Fonts: the deck keeps the template's own font link; a theme's link is added next to it. Run `fonts --write` and `check --no-webfonts` after switching (12-export-qa.md).
- A theme replaces tokens, not layout. Slides that hardcode colours, or SVG that uses literal fills, keep them: use `var(--ink)`, `var(--accent)`.
- Code that reads a colour once, in `setup`, keeps the variant it started in. Charts in this kit use `var(--accent)` strings, which follow; for canvas drawing read the colour in `frame`.
