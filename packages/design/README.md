# @yukibana/design

Yukibana's design system for the docs site, the cloud and Light: the tokens, the shared component styles, and a page
that shows them. It was chosen in rounds of live previews in November 2026; this file is what those rounds decided and
why, so that nobody has to rerun them to learn it.

| Path | What it is |
| --- | --- |
| `tokens/base.tokens.json` | Every token, in the [W3C Design Tokens format](https://www.designtokens.org/tr/2025.10/format/), with the light theme's colours. |
| `tokens/dark.tokens.json` | The dark theme: colours only, each overriding the token of the same path. |
| `css/tokens.css` | Generated: custom properties `--yk-*`, colours as `light-dark()`. Committed, so Light (in its own repository) can copy it. |
| `css/base/*.css` | The shared components, `yk-` classes, drawn from the tokens only: one file per component (`buttons.css`, `fields.css`, `toast.css`, …), and `core.css` for the page and the focus ring. Edit these. |
| `css/base.css` | Generated: the parts in `css/base/` joined into one file, in the order `src/base.ts` lists them. Committed, and the file apps import. |
| `css/fonts.css` | `@font-face` for the three typefaces, under the names `tokens.css` uses, from `fonts/`. Optional. |
| `fonts/` | The fonts as variable WOFF2, Latin and Latin Extended, each family with its licence (`OFL.txt`, SIL Open Font License 1.1). |
| `reference/index.html` | The living reference. Open it from this directory. |

```sh
pnpm --filter @yukibana/design build   # tokens → css/tokens.css, css/base/*.css → css/base.css
pnpm --filter @yukibana/design test    # both generated files are up to date, every colour pair passes WCAG, the compiler's tables
```

A page loads `tokens.css` first, then `fonts.css` if it takes the fonts from here, then `base.css`, and puts
`class="yk-root"` on its `<html>`:

```html
<html lang="en" class="yk-root">
```

`.yk-root` turns on the page itself: the background and text colour, the body font and size, the heading and code
fonts (ligatures off), and the accent colour of links in running text (links without a class). It is opt-in because
those rules change elements the app did not mark. Everything else works without it: the `yk-` classes, the ink focus
ring and the stroke of `svg.yk-icon`. The focus ring and the icon stroke apply anywhere, inside `:where()`, so they add
no specificity and any rule of the app's own wins over them.

A page follows the system's light or dark scheme, unless its root element says `data-theme="light"` or `"dark"`.

**Browsers.** Every colour is a `light-dark()` pair, which needs Chrome and Edge 123, Firefox 120 or Safari 17.5 (all
from 2024). There is no fallback: an older browser drops every colour and shows the page unstyled, black on white.
**Fonts.** `css/fonts.css` loads Bricolage Grotesque, Atkinson Hyperlegible Next (upright and italic) and JetBrains
Mono from `fonts/`, under exactly the names `--yk-font-family-*` uses, with `font-display: swap`. They are variable
WOFF2 files, about 225 KB for all eight, Latin and Latin Extended only; a browser fetches a subset only when the page
shows one of its characters, so a page in English fetches three files, about 115 KB. They are fontsource's 5.3.0 builds,
copied in, so nothing is installed for them; each family's licence (SIL Open Font License 1.1) is beside it. A page
that loads the same families another way leaves `fonts.css` out.

## What was decided, and why

**Character.** Cool, engineered, welcoming to beginners, slightly serious and plainly of its moment. To the point,
progressive disclosure, never bloated. The look is meant to be refreshed as it ages: everything is a token, so a refresh
is cheap; what stays put between refreshes is where controls are.

**Type.** Bricolage Grotesque for headings (rounded, welcoming), Atkinson Hyperlegible Next for text (made for
legibility), JetBrains Mono with ligatures off (students must see the characters they type, `!=` not `≠`).

**Colour.** Cool blue-grey greys. One accent, Light's green in the light theme and a livelier emerald in the dark one,
used for exactly five things: primary buttons, links, the current tab's line, the checkbox fill and selected rows.
Nothing else is green. Ticks and status use `--yk-ok`, always with a symbol (a check), never colour alone; a spinner or
progress is ink or info (blue); focus is the ink ring. Because the accent is green, success never relies on colour: a
graded chip has a check, an open one a circle, and a done button says "✓ Saved". Notes are blue and warnings amber,
never green. Every text pair passes 4.5:1 and every control border 3:1 in both themes;
`tests/tokens.test.ts` lists the pairs.

**Shape.** Small flat buttons with a 6px corner and a semibold label (pills lost to them in context), tinted chips, fields with an 8px radius (never fully round: long text looks
cramped in a pill). No 3D, glow or offset shadows.

**Signature.** The triangles lattice on the plain page colour, only in side rails, gutters, the landing hero and an
empty list's patch. Never behind text, never in a header, and no colour stripe along the top.

**Header.** One row of three columns: the logo and "Yukibana" (Bricolage 650, 16px) on the left, the sections (Docs,
Playground, Embed) centred, and search (a field-like button with Ctrl K), the filled GitHub mark and Sign in on the right.
The landing page and the docs: the bar lifted off the edge, rounded (16px), exactly as wide as the content, of frosted
glass with a fine grain, with a soft shadow, the sections in a grey tray. The cloud: a full-width square bar, sticky, with blur and a hairline.
No section is ever drawn as selected, because some lead to other sites. Below 760px there is no room around it: it
becomes the full-width bar with the brand, the GitHub mark and Sign in. No "Get started" and no Docs call to action in
any header: the landing hero carries the one call to action (Download). The cloud's bar holds only the course switcher
and the avatar.

**Tabs.** Underline for moving between pages; labels turn bold without shifting anything. Light's dock tabs: short
dividers, the current tab filled with the editor's colour on a slightly darker bar, a full 2px line, green in the group
you are typing in and grey in the others. Code blocks in the docs use the same tab bar, without dragging.

**Choices.** One of a few, side by side: the segmented control (`.yk-segmented`), one outlined row whose chosen segment
is pressed, a sunken fill outlined in ink on all four sides, never green (it is a state, not an action). It takes
native radio buttons in labels (the arrow keys move the choice) or buttons with `aria-pressed`. A single toggle is a
`.yk-btn` with `aria-pressed`, drawn the same way when on.

**Tables.** Every row is a link. A checkbox on the left selects it for the bulk bar, which keeps a gap above the list.
Checkboxes are drawn, not native: a native one follows the page's colour scheme and came out dark grey in a light panel.

**Focus.** The ink ring: 2px, a 2px gap, black in the light theme and white in the dark. Highest contrast, and it keeps
green for actions.

**Code.** Expressive Code frames, as on hylo-lang.org: the dock tab bar for files, Copy and Run in Light as icon
buttons, no header on terminal blocks (Copy appears on hover), and marked, added and removed lines with a bar and a sign.

**Feedback.** Where it can, the button says it is done ("✓ Saved" for two seconds). Otherwise a pill, bottom centre,
on one line: dark for success, fading after three seconds; red for an error, with Retry, staying until dismissed. The
pill was chosen over a bar along the bottom of a panel because it works on every page without a panel to attach to.

**Deleting.** Something that cannot come back asks in a dialog. Everything else is deleted at once and offers Undo,
which means the cloud keeps deleted rows for a while instead of removing them.

**Empty and waiting.** An empty list: centred, the lattice patch, a title, one sentence, one button. Content that is
coming shows skeleton rows. A spinner appears only inside a button that is working, never next to a skeleton.

**Motion and icons.** 120ms fades, no movement, no bounce. Thin outline icons, stroke 1.5, Lucide style.

## Still to do

The apps do not use this package yet. The cloud (`cloud/web/src/app.css`), the docs site and Light each move over in
their own change, replacing their own variables with `--yk-*` and their components with the `yk-` classes.
