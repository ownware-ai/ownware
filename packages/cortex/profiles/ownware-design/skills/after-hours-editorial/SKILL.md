---
name: after-hours-editorial
description: 'Dark-mode editorial for late-night long-reads — warm off-black surface, cream body, single amber accent, jazz-magazine voice. Use when the brief is "premium dark editorial", "long-read for evening reading", or "essay that should feel like a bar at 11pm". Layered on top of /article-layout. Skip for documentation, product pages, and anything under 800 words.'
trigger: /after-hours-editorial
---

# After Hours Editorial — warm dark, amber, long-form jazz

## Overview

Most dark mode is "the same page with the colors inverted." This is the other thing — a page designed dark first, where the warmth of the off-black surface, the cream of the body type, and a single amber accent carry the mood. It's the magazine you read in a lamp pool at 11pm. Pair with `/article-layout` for the structural pieces (h2, footnotes, pulls); the token block + accent discipline below make it after-hours instead of "just dark."

The discipline is in the warmth. `#0A0A0A` near-black reads cold and webby. `#1A1612` (warm off-black with brown undertone) reads like a bound book under tungsten light. That difference is the whole skill.

---

## Critical Constraints — read these first, every time

1. **Warm near-black, never pure.** `--bg: #1A1612` (warm off-black, brown undertone). Pure `#000` or `#0A0A0A` breaks the voice immediately — it reads as a console window, not a magazine.
2. **Cream body type, not white.** `--fg: #F4E9D9` (warm cream). White (`#FFF`) on this surface burns the eye after 200 words; cream is the long-read color.
3. **One amber accent, used four places only.** `--accent: #F2A93B`. Allowed: drop cap, pull-quote left rule, link underline, kicker chip. Banned: section dividers, byline, any decoration. The accent is rare or it stops glowing.
4. **No glow effects.** No `text-shadow`, no `filter: drop-shadow`, no glow underlines. The warmth comes from the *palette*, not from light effects. Glow turns the piece into a hacker film prop.
5. **Display in a humanist serif at confident weight.** Display `font-weight: 500` or `600` — not 700+. Heavy weights on dark backgrounds optically thicken; medium reads as confident, not aggressive.
6. **Body 18–20px, line-height ≥ 1.7.** Reading 1500 words on dark requires generous leading. 16px is cramped; 1.5 line-height is suffocating.

---

## The token block (paste verbatim into `:root`)

```css
:root {
  --bg: #1A1612;             /* warm off-black */
  --surface: #221D17;        /* one step up — sidebars, pull-quote backgrounds */
  --fg: #F4E9D9;             /* warm cream body */
  --muted: #9C9080;           /* warm gray secondary text */
  --border: #3A322A;          /* hairline rule, warm dark */
  --accent: #F2A93B;          /* the one amber */
  --accent-dim: #B8801F;      /* hover state, used once */
  --radius: 0;
  --font-display: "Fraunces", "Iowan Old Style", "Charter", Georgia, serif;
  --font-body: "Iowan Old Style", "Charter", "Source Serif Pro", Georgia, serif;
  --font-mono: ui-monospace, "JetBrains Mono", Menlo, monospace;
}
body { margin: 0; background: var(--bg); color: var(--fg);
       font: 19px/1.75 var(--font-body); text-wrap: pretty; }
.body { max-width: 62ch; margin: 0 auto; padding: 80px 6vw; }
::selection { background: var(--accent); color: var(--bg); }
```

Warm off-black + cream serif + one amber. That's the whole palette. The `::selection` rule is the one piece of polish you don't skip — selecting text in cream-on-warm-dark should feel intentional.

---

## Rubric — the after-hours affordances

### Kicker chip (above title)

Tiny amber chip naming the section. The first time the accent appears in the page.

```css
.kicker {
  display: inline-block;
  color: var(--accent);
  border: 1px solid var(--accent);
  padding: 4px 10px;
  font: 11px/1 var(--font-body);
  letter-spacing: 0.14em;
  text-transform: uppercase;
}
```

Hollow border, not solid fill. The hollow chip on dark reads as a neon-lit sign without using any actual neon.

### Display headline

```css
h1.title {
  font-family: var(--font-display);
  font-size: clamp(40px, 6.5vw, 76px);
  font-weight: 500;          /* not 700 */
  line-height: 1.05;
  letter-spacing: -0.018em;
  text-wrap: balance;
  margin: 24px 0 16px;
}
```

Medium weight + tight letter-spacing + cream on warm dark = confident, not shouting.

### Drop cap (opening paragraph only)

```css
.body > p.opening::first-letter {
  float: left;
  font-family: var(--font-display);
  font-size: 6.5em;
  line-height: 0.82;
  margin: 0.04em 0.1em 0 0;
  font-weight: 500;
  color: var(--accent);
}
```

Amber drop cap on cream-on-dark is the page's first warm glow. One drop cap, opening only.

### Pull quote (left amber rule, surface-tinted background)

```css
.pull {
  margin: 56px 0;
  padding: 24px 28px;
  background: var(--surface);
  border-left: 3px solid var(--accent);
  font-family: var(--font-display);
  font-size: clamp(24px, 3vw, 32px);
  font-weight: 500;
  font-style: italic;
  line-height: 1.3;
  text-wrap: balance;
}
```

The surface tint distinguishes the pull from the page without using a card-radius. Magazine pull-quotes never have rounded corners.

### Section ornament

```css
hr.dot { border: none; text-align: center; margin: 56px 0; }
hr.dot::before { content: "·   ·   ·"; color: var(--accent); letter-spacing: 0.8em; font-size: 14px; }
```

Three amber dots, generously spaced. The piece's second amber appearance.

### Byline + dateline

`color: var(--muted); font-size: 14px; letter-spacing: 0.02em;` — mid-dots, author in italic. No underline, no link styling at all in the byline.

### Link underline (accent's fourth appearance)

```css
a { color: var(--fg); text-decoration: underline;
    text-decoration-color: var(--accent); text-underline-offset: 4px;
    text-decoration-thickness: 1.5px; }
a:hover { text-decoration-color: var(--accent-dim); }
```

The amber lives in the underline, not the text color. The text stays cream. This keeps body type readable while signaling links unambiguously.

---

## Concrete examples

### Example 1 — a 1500-word essay "The case for the slow record"

- **Kicker:** hollow amber chip "ESSAY · MUSIC".
- **Title:** "The case for the slow record." 64px Fraunces 500, cream, balanced.
- **Byline:** "by *Mara Olivetti · for Issue №14* · February 14, 2026 · 11 min read", muted, mid-dots.
- **Lede:** 22px italic, one paragraph naming the angle. Cream on warm dark, no decoration.
- **Body open:** drop cap on the first letter ("T"), amber, six lines deep.
- **First h2 at ~350 words:** Fraunces 500, 32px, cream.
- **Pull quote at ~700 words:** "A record that hurries is a record that's afraid you'll change the station." Surface-tinted background, italic, amber left rule.
- **Three-dot ornament at ~1000 words** between the second and third movement.
- **Footnote near a contentious claim** about a specific producer; entry at the bottom with `↩` back-link, muted color.
- **Second pull at ~1300 words.** (Two pulls max in a 1500-word piece; the second earns its place by being a different kind of claim than the first.)
- **Related reading footer:** two cards. Title in Fraunces 500 cream, one-line description muted. No images.
- **Colophon:** "Set in Fraunces & Iowan Old Style. Read by lamp. Issue №14, 2026."

That's the full kit. Two amber appearances above-the-fold (chip + drop cap), three more total in the body (pull, dots, link underline if there are links). The piece feels lit, not loud.

### Example 2 — minimum file skeleton

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>The case for the slow record — Issue №14</title>
  <link href="https://fonts.googleapis.com/css2?family=Fraunces:wght@400;500;700&display=swap" rel="stylesheet">
  <style>
    :root { --bg:#1A1612; --surface:#221D17; --fg:#F4E9D9; --muted:#9C9080; --border:#3A322A;
            --accent:#F2A93B; --accent-dim:#B8801F;
            --font-display:"Fraunces",Georgia,serif;
            --font-body:"Iowan Old Style","Charter",Georgia,serif; }
    body { margin:0; background:var(--bg); color:var(--fg);
           font:19px/1.75 var(--font-body); text-wrap:pretty; }
    .body { max-width:62ch; margin:0 auto; padding:80px 6vw; }
    .kicker { display:inline-block; color:var(--accent); border:1px solid var(--accent);
              padding:4px 10px; font:11px/1 var(--font-body); letter-spacing:.14em; text-transform:uppercase; }
    h1.title { font-family:var(--font-display); font-size:clamp(40px,6.5vw,76px); font-weight:500;
               line-height:1.05; letter-spacing:-.018em; text-wrap:balance; margin:24px 0 16px; }
    .byline { color:var(--muted); font-size:14px; margin:0 0 40px; }
    .lede { font-size:22px; line-height:1.55; font-style:italic; margin:0 0 40px; }
    .body > p.opening::first-letter { float:left; font-family:var(--font-display); font-size:6.5em;
         line-height:.82; margin:.04em .1em 0 0; font-weight:500; color:var(--accent); }
    h2 { font-family:var(--font-display); font-weight:500; font-size:32px;
         margin:56px 0 16px; text-wrap:balance; }
    .pull { margin:56px 0; padding:24px 28px; background:var(--surface);
            border-left:3px solid var(--accent); font-family:var(--font-display);
            font-weight:500; font-style:italic; font-size:clamp(24px,3vw,32px); line-height:1.3; }
    hr.dot { border:none; text-align:center; margin:56px 0; }
    hr.dot::before { content:"·   ·   ·"; color:var(--accent); letter-spacing:.8em; font-size:14px; }
    a { color:var(--fg); text-decoration:underline; text-decoration-color:var(--accent);
        text-underline-offset:4px; text-decoration-thickness:1.5px; }
    ::selection { background:var(--accent); color:var(--bg); }
  </style>
</head>
<body>
  <article class="body" data-cx-id="essay">
    <span class="kicker">Essay · Music</span>
    <h1 class="title">The case for the slow record.</h1>
    <p class="byline">by <i>Mara Olivetti · for Issue №14</i> · February 14, 2026 · 11 min read</p>
    <p class="lede">There is a tempo at which a record stops being music and starts being weather…</p>
    <p class="opening">The first time I heard…</p>
    <!-- … rest of the essay … -->
  </article>
</body>
</html>
```

---

## Anti-patterns

- **Pure black `#000` background.** Wrong color. Warm `#1A1612` is the voice; pure black turns it into a terminal window.
- **White body type.** Pure `#FFF` on dark burns at 1500 words. Cream `#F4E9D9` is the long-read move.
- **Glow effects, neon shadows, accent text glow.** Banned. The amber lives in chips, drop caps, rules, and underlines — never as a glow halo. Glow = nightclub poster, not after-hours magazine.
- **Multiple accent colors.** No teal "for variety," no rose "for the heart pulls." One amber. The constraint is the voice.
- **Display weight 700+.** Heavy weights optically thicken on dark backgrounds — what's "bold" on light reads "shouting" on dark. Use 500 or 600.
- **Bright link colors.** Don't make the link itself amber. Cream text + amber underline is readable; amber text on warm dark reads as illegible accent soup.
- **A second pull quote within 400 words of the first.** Pulls need air on both sides. If two pulls land close, the second isn't a pause — it's a banner.
- **Sans-serif body.** This skill is two-serif. A sans body turns the piece into a tech-blog dark mode, not after-hours editorial.
