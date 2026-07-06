# Paper Notebook

> Category: crafted
> Sketchnote / handwritten / textured paper — dot-grid canvas, hand-drawn flourishes, marker-blue accent. The educational / journaling / creative-tool zone.

## 1. Visual theme & atmosphere

This is the "made by hand" system. It belongs on surfaces that want to read as written, sketched, or thought-through-on-paper — an educational app, a journaling product, an indie author's site, a sketchnote-driven blog, a course landing page where the teacher writes their own copy. The page IS a notebook page: warm cream paper, a faint dot grid behind everything, a single marker-blue accent for highlights, occasional underlines that look drawn by hand. The system says *"a person sat down with a pen and thought this through."*

The difference from `soft-clay` (plush molded surfaces) is intent. Soft Clay is *industrial-friendly* — every element is a manufactured tile. Paper Notebook is *handmade-friendly* — the artifacts look like pages from a real notebook, with all the imperfection and warmth that implies. The difference from `warm-soft` (warm minimal) is craft. Warm-soft is *digital warm*; Paper Notebook is *physical warm*. Reach for Paper Notebook when the brief calls for a sense of authorship, study, or personal voice.

The genre depends on **the dot-grid background**. Without it, the system collapses to "warm minimal with a handwritten font." The dot grid IS the paper.

## 2. Color palette & roles

- **Background** (`--bg`, `#f9f3e3`): warm cream paper, the kind a Moleskine page actually is.
- **Surface** (`--surface`, `#fefcf4`): note-card tier, slightly warmer paper-white. Used for elevated notes pinned over the page floor (a callout, a sidebar tip).
- **Foreground** (`--fg`, `#2a2722`): warm dark-brown-ink, not pure black. Real ink dries warm even at maximum density; `#000` on warm paper reads as printed-not-handwritten.
- **Muted** (`--muted`, `#7c7568`): warm muted brown for metadata, byline, "Page 3 of 12" markers.
- **Border** (`--border`, `#d8cdb3`): warm hairline / dot color. Used as the *dotted* line color in the background grid AND as a thin solid hairline under headings.
- **Accent** (`--accent`, `#1f5fb8`): marker-blue. The kind of saturated medium-blue that comes out of a Lamy fountain pen or a Pilot G2. Used on the primary CTA fill, link underlines (drawn as hand-style underlines, not standard text-decoration), the focus ring, and the one decisive hand-drawn flourish per page.
- **Accent hover** (`--accent-hover`, `#154a92`): darken-on-hover.
- **Accent fg** (`--accent-fg`, `#fefcf4`): paper-white on blue.
- **Semantic** (`--good` `#3f8a4a`, `--warn` `#d28b1a`, `--bad` `#c44a3a`): desaturated half a step warmer to live on warm paper. Used sparingly — this isn't a status-heavy system; semantics show up mostly in callout boxes ("✓ tip" / "⚠ caveat").

The discipline: **one chromatic accent**, paired with the warm-paper monochrome. Adding a second accent (a green highlight color + a blue underline) drifts into kids-app territory; this system stays disciplined-handmade rather than playful-handmade. If you need a second highlight color, use the warm-yellow `--warn` as a highlighter — a deliberate genre move that reads as "the writer reached for a different pen."

## 3. Typography rules

- **Font stack:** Caveat or Patrick Hand for display (genuine handwriting feel), Inter for body. **Body NEVER uses the handwritten face** — handwritten font at body sizes is unreadable; the system stays paired (handwritten display + clean sans body). This is the most common failure mode of imitations: putting Caveat at 14px makes the page look like a stranger's handwriting at a distance.
- **Scale (px):** 12 / 14 / 16 / 18 / 24 / 32 / 48 / 72 / 96.
- **Body:** 16px (slightly larger than other systems — paper-feel reads better at this size). Weight 400 default, 600 for emphasis. Line height 1.65 (generous, journaling).
- **Display:** Caveat at the display sizes. **Caveat at 96px doesn't need extra weight** — the face is already loose and handwritten. Don't fake-bold a handwritten face; it just looks like a botched render.
- **Hand-drawn underline pattern.** Links and highlighted phrases get an underline that mimics a pen stroke — a slightly-wavy 2.5px line in the accent, sitting 6–8px below the baseline, often deliberately offset to one side. Implementable via `text-decoration` with `text-decoration-thickness: 2.5px; text-underline-offset: 6px; text-decoration-color: var(--accent); text-decoration-style: wavy;` for a quick version, or via an inline SVG for the hand-drawn version.
- **Margin marks.** Optional vertical small marks in the left margin beside a paragraph — like a reader's pencil annotation. Reserved for the page's most important paragraph.

## 4. Spacing & density

- **Section padding:** 80px vertical on desktop, 56px on mobile.
- **Card / note padding:** 24–32px.
- **Radius:** 10px on cards and buttons. 999px on pills (badges).
- **Gutters:** 24–28px.
- **Line height:** generous — this is a reading system; tight leading breaks the journaling feel.

Density runs medium-loose. Paper Notebook is for reading and study, not for dense numerics; dashboards don't belong in this system.

## 5. Signature moves & avoid list

**The dot-grid background is mandatory.** The page floor is a faint dot pattern:

```css
body {
  background-color: var(--bg);
  background-image: radial-gradient(var(--border) 1px, transparent 1.5px);
  background-size: 22px 22px;
}
```

Subtle but present. Without the dot grid the system reads as "warm minimal with handwritten headlines" — pleasant, but not Paper Notebook. The dot grid is the paper.

**One hand-drawn flourish per artifact.** Either a hand-drawn underline below the headline (curved, not straight — use an inline SVG), a hand-drawn arrow pointing from a caption to a feature, a sketched circle around an oversized number, or a chunky margin checkmark. Pick ONE; layering all four reads as a Pinterest moodboard.

**The marker-highlight.** A piece of body text wrapped in a "highlighter" treatment — a yellow `--warn`-colored stripe (`background: linear-gradient(transparent 50%, rgba(210, 139, 26, 0.4) 50%);`) behind the inline phrase. One per page, on the line that matters most. The trick: the highlight should READ as if someone went back over the typed text with a real highlighter.

**Avoid:**

- Pure-white background. The warm paper IS the brand.
- Hairline solid borders on every element. Borders in this system are mostly dotted, dashed, or absent.
- Handwritten font at body sizes. Caveat at 14px is unreadable; the pairing (handwritten display + sans body) is non-negotiable.
- Hard `#000` text. Warm-brown `#2a2722` is the foreground.
- Pillowy radii (>16px). Drifts to soft-clay, which is a different system.
- Multiple chromatic accents. Marker-blue is the one; the highlighter-yellow is `--warn`, used decoratively, not interactively.
- Soft drop shadows. Paper Notebook uses no shadow at all — paper sits flat, not lifted.
- Stock photography. The genre lives with hand-drawn illustration, simple line art, or no imagery. Photographic hero subjects (especially smiling people) break the brand.
- Marketing-corporate copy voice. Pair with conversational, personal-voice copy — "Here's what I learned…", "Take this with you…". "Best-in-class platform" in this system reads as costume.
- Geometric perfection. The genre tolerates — even rewards — slight imperfection. Perfectly aligned everything reads as fake-handmade; tiny intentional misalignments (a callout box rotated 1°, a headline that breaks 2px past a column) lean into the authentic feel.
