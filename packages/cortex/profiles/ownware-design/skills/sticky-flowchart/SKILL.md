---
name: sticky-flowchart
description: 'Sticky-note style flowchart — yellow/pink/cyan/mint sticky rectangles with hand-drawn rotation jitter, Excalidraw-look arrows, hand-written labels. Use for retrospectives, brainstorm captures, onboarding flows, "whiteboard energy" diagrams. Pairs with /diagram-generator (which handles the broader Excalidraw JSON discipline); this skill teaches the sticky-note aesthetic specifically.'
trigger: /sticky-flowchart
---

# Sticky Flowchart — whiteboard-energy diagrams with paper stickies

## Overview

Sister skill to `/diagram-generator`. Where that one ships clean Excalidraw architecture, this one ships the looser whiteboard aesthetic: tilted sticky notes, hand-written labels, curved arrows. Use for retros, brainstorm dumps, onboarding flows — anywhere a clean architecture diagram would feel too cold.

Output is a single self-contained HTML file with inline SVG. Excalidraw JSON also supported, but inline HTML+SVG is the default because the sticky aesthetic depends on CSS rotation that Excalidraw can render but doesn't natively style.

---

## Critical Constraints

1. **Palette is 4 sticky colors plus paper.** Yellow `#fcd34d`, pink `#fca5a5`, mint `#a7f3d0`, cyan/blue `#a5b4fc`. Paper background `#f4ede1` (warm) or `#f0f2f4` (cool). Pick one paper per diagram.
2. **Each sticky rotates ±2deg.** Never 0deg (looks digital). Never more than 3deg (looks drunk). Vary the rotation across nodes so the diagram has rhythm — alternate signs, no two adjacent stickies tilt the same way.
3. **Sticky size: 200×140px** for compact nodes, **240×180px** when the label runs to a second line. Fixed grid keeps the visual rhythm. Padding 18px.
4. **Font is hand-written.** Stack: `"Caveat", "Patrick Hand", "Kalam", "Comic Sans MS", cursive`. Size 18–22px for the title, 14px for sub-text. Mono-style sans (Inter, Helvetica) breaks the aesthetic — it must be hand.
5. **Arrows are curved Béziers with rough strokes.** SVG path `d="M x1 y1 Q cx cy x2 y2"` (quadratic Bézier). Stroke `#1a1a1a`, width 2.5, `stroke-linecap: round`. Arrowhead via `marker-end`.
6. **Hand-drawn shadow on every sticky.** `filter: drop-shadow(0 6px 14px rgba(0,0,0,0.12))`. The shadow is soft — no harsh contrasts.
7. **Optional tape mark on top edge.** A 60×16px translucent rectangle (`rgba(255,255,255,0.35)`) centered at the sticky's top edge, slightly rotated, to feel like masking tape.
8. **5–12 nodes per diagram.** Below 5 = not a flowchart. Above 12 = unreadable; split into two diagrams.

---

## The CSS + SVG pattern — paste-ready

```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Retro flowchart</title>
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link href="https://fonts.googleapis.com/css2?family=Caveat:wght@500;700&display=swap" rel="stylesheet" />
<style>
:root {
  --paper: #f4ede1;
  --ink: #1a1a1a;
  --sticky-yellow: #fcd34d;
  --sticky-pink:   #fca5a5;
  --sticky-mint:   #a7f3d0;
  --sticky-blue:   #a5b4fc;
  --font-hand: "Caveat", "Patrick Hand", "Comic Sans MS", cursive;
}
body { margin: 0; background: var(--paper);
       background-image: linear-gradient(rgba(0,0,0,0.04) 1px, transparent 1px),
                         linear-gradient(90deg, rgba(0,0,0,0.04) 1px, transparent 1px);
       background-size: 28px 28px;
       min-height: 100vh; display: grid; place-items: center; padding: 48px; }
.canvas { position: relative; width: 1280px; height: 720px; }

.sticky {
  position: absolute;
  width: 200px; min-height: 140px;
  padding: 18px;
  font-family: var(--font-hand);
  color: var(--ink);
  filter: drop-shadow(0 6px 14px rgba(0,0,0,0.12));
}
.sticky::before {                                  /* the tape strip */
  content: ""; position: absolute; top: -8px; left: 50%;
  width: 60px; height: 16px; background: rgba(255,255,255,0.4);
  transform: translateX(-50%) rotate(-3deg);
}
.sticky h3   { margin: 0 0 6px; font: 700 22px/1.15 var(--font-hand); }
.sticky p    { margin: 0; font: 500 16px/1.3 var(--font-hand); color: rgba(26,26,26,0.78); }

.sticky.yellow { background: var(--sticky-yellow); transform: rotate(-2deg); }
.sticky.pink   { background: var(--sticky-pink);   transform: rotate( 2deg); }
.sticky.mint   { background: var(--sticky-mint);   transform: rotate(-1deg); }
.sticky.blue   { background: var(--sticky-blue);   transform: rotate( 1.5deg); }

.edges { position: absolute; inset: 0; pointer-events: none; }
.edges path { fill: none; stroke: var(--ink); stroke-width: 2.5; stroke-linecap: round; }
.edges path.dashed { stroke-dasharray: 8 6; }
.edges text { font: 500 16px var(--font-hand); fill: var(--ink); }
</style>
</head>
<body>
<div class="canvas" data-cx-id="flow-canvas">

  <div class="sticky yellow" style="left: 40px;   top: 280px;" data-cx-id="n-1"><h3>🔍 What surprised us</h3><p>The retros people loved most weren't the structured ones.</p></div>
  <div class="sticky pink"   style="left: 320px;  top: 80px;"  data-cx-id="n-2"><h3>💡 Hypothesis</h3><p>Format helps less than psychological safety.</p></div>
  <div class="sticky mint"   style="left: 320px;  top: 480px;" data-cx-id="n-3"><h3>📉 Counter-evidence</h3><p>One unstructured retro flopped — facilitator skill gap.</p></div>
  <div class="sticky blue"   style="left: 620px;  top: 280px;" data-cx-id="n-4"><h3>🧪 Experiment</h3><p>2 retros, no agenda, same facilitator. Compare.</p></div>
  <div class="sticky yellow" style="left: 920px;  top: 280px;" data-cx-id="n-5"><h3>📦 Ship next</h3><p>Document the facilitator playbook before scaling.</p></div>

  <svg class="edges" viewBox="0 0 1280 720" preserveAspectRatio="none">
    <defs>
      <marker id="arrowhead" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="9" markerHeight="9" orient="auto-start-reverse">
        <path d="M0,0 L10,5 L0,10 z" fill="#1a1a1a" />
      </marker>
    </defs>
    <path d="M 240 320  Q 290 240 320 180" marker-end="url(#arrowhead)" />
    <path d="M 240 360  Q 290 440 320 540" marker-end="url(#arrowhead)" />
    <path d="M 520 180  Q 580 240 620 320" marker-end="url(#arrowhead)" />
    <path class="dashed" d="M 520 540  Q 580 440 620 360" marker-end="url(#arrowhead)" />
    <path d="M 820 340  Q 870 340 920 340" marker-end="url(#arrowhead)" />
    <text x="290" y="220">supports</text>
    <text x="290" y="490">but…</text>
    <text x="870" y="320">test</text>
  </svg>
</div>
</body>
</html>
```

That's a 5-node retro flowchart. Stickies positioned absolutely, edges drawn as SVG over them, labels in hand font, every sticky carries `data-cx-id` for surgical edits later.

---

## Concrete examples

### Example 1 — 5-node retrospective (above)

Already in the snippet. Five stickies — surprise → hypothesis → counter-evidence → experiment → ship next. Dashed edge on the counter-evidence line marks it as "tension, not blocker." Reads in five seconds.

### Example 2 — 7-node onboarding flow (variant)

Same skeleton, more nodes, top-to-bottom layout. Sticky colors rotate by step type:

- Yellow = user action ("user clicks Sign up")
- Pink = friction point ("user lands on empty state")
- Mint = success state ("user sees their first thread")
- Blue = system event ("worker provisions sandbox")

Layout: 3 columns × 3 rows, stickies at `(40,80)`, `(340,80)`, `(640,80)`, etc. Edges flow top-to-bottom; the friction edge from "empty state" loops back to "Sign up" as a dashed `bad` path stroked `#c92a2a` to mark the drop-off.

---

## Anti-patterns

- **Every sticky rotated the same direction.** Reads as "I forgot to vary the rotation". Alternate signs.
- **Sticky on a white background.** The paper IS the diagram; pure white kills the whiteboard feel. Use `#f4ede1` or `#f0f2f4`.
- **Inter / Helvetica / system fonts.** Breaks the aesthetic instantly. The font is hand. If Caveat or Patrick Hand can't load, fall back to Comic Sans before reaching for sans.
- **Straight orthogonal arrows.** Sticky flowcharts use curves; right-angle elbows are for architecture diagrams (`/diagram-generator`).
- **Five different sticky colors.** Four max — the palette is fixed. A fifth color reads as "I added a new category at the end" and breaks the rhythm.
- **No `data-cx-id` on stickies.** Then later edits ("change node 3 to mint") cascade. Every sticky carries an ID.
