# @yukibana/design

Yukibana's design system for the docs site, the cloud and Light: the tokens, the shared component styles, and a page
that shows them. It was chosen in rounds of live previews in November 2026; this file is what those rounds decided and
why, so that nobody has to rerun them to learn it.

| Path | What it is |
| --- | --- |
| `tokens/base.tokens.json` | Every token, in the [W3C Design Tokens format](https://www.designtokens.org/tr/2025.10/format/), with the light theme's colours. |
| `tokens/dark.tokens.json` | The dark theme: colours only, each overriding the token of the same path. |
| `css/tokens.css` | Generated: custom properties `--yk-*`, colours as `light-dark()`. Committed, so Light (in its own repository) can copy it. |
| `css/base.css` | The shared components, `yk-` classes, drawn from the tokens only. |
| `reference/index.html` | The living reference. Open it from this directory. |

```sh
pnpm --filter @yukibana/design build   # tokens → css/tokens.css
pnpm --filter @yukibana/design test    # the CSS is up to date, every colour pair passes WCAG, the compiler's tables
```

A page follows the system's light or dark scheme, unless its root element says `data-theme="light"` or `"dark"`.
It loads the fonts itself: Bricolage Grotesque, Atkinson Hyperlegible Next and JetBrains Mono.

## What was decided, and why

**Character.** Cool, engineered, welcoming to beginners, slightly serious and plainly of its moment. To the point,
progressive disclosure, never bloated. The look is meant to be refreshed as it ages: everything is a token, so a refresh
is cheap; what stays put between refreshes is where controls are.

**Type.** Bricolage Grotesque for headings (rounded, welcoming), Atkinson Hyperlegible Next for text (made for
legibility), JetBrains Mono with ligatures off (students must see the characters they type, `!=` not `≠`).

**Colour.** Cool blue-grey greys. One accent, Light's green, for primary buttons, links and the current tab's line.
Because the accent is green, success never relies on colour: a graded chip has a check, an open one a circle. Notes
are blue and warnings amber, never green. Every text pair passes 4.5:1 and every control border 3:1 in both themes;
`tests/tokens.test.ts` lists the pairs.

**Shape.** Small flat pill buttons, tinted chips, fields with an 8px radius (never fully round: long text looks
cramped in a pill). No 3D, glow or offset shadows.

**Signature.** The triangles lattice on the plain page colour, only in side rails, gutters, the landing hero and an
empty list's patch. Never behind text, never in a header, and no colour stripe along the top.

**Header.** Docs and cloud: a full-width square bar, sticky, with blur and a hairline. The landing page: the same bar
floating, rounded, at most 1000px wide; below 760px it becomes the full-width bar. Sections (Docs, Playground, Embed)
are plain links, because some lead to other sites; none is drawn as a selected segment. Actions: search, the GitHub
mark, Sign in. No "Get started" and no Docs call to action in any header: the landing hero carries the one call to action
(Download). The cloud's bar holds only the course switcher and the avatar.

**Tabs.** Underline for moving between pages; labels turn bold without shifting anything. Light's dock tabs: short
dividers, the current tab filled with the editor's colour on a slightly darker bar, a full 2px line, green in the group
you are typing in and grey in the others. Code blocks in the docs use the same tab bar, without dragging.

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
coming shows skeleton rows; something small shows a spinner.

**Motion and icons.** 120ms fades, no movement, no bounce. Thin outline icons, stroke 1.5, Lucide style.

## Still to do

The apps do not use this package yet. The cloud (`cloud/web/src/app.css`), the docs site and Light each move over in
their own change, replacing their own variables with `--yk-*` and their components with the `yk-` classes.
