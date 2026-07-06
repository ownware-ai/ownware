---
name: video-frames
description: Write individual Remotion scene components — transitions, lower-thirds, animated text reveals, logo outros, glitch titles, light leaks, KPI count-ups — that drop INTO an existing Remotion project. Each scene is one self-contained `.tsx` file the user adds to `src/scenes/` and sequences in their composition. Use when adding a single animated component to a running project. Do NOT use to bootstrap a new project — that's `video-renderer`.
trigger: /video-frames
---

# Video Frames — drop-in Remotion scene components

## Overview

This skill writes Remotion source files. Ownware does not render video in-product yet — the agent produces the project on disk, the user runs `npx remotion render` (or `npx remotion preview` to view in browser) themselves. When in-product video rendering ships (Slice 7.5), this skill stays the same and a new tool will execute it.

Difference from `video-renderer`: scope. `video-renderer` writes the WHOLE project (`package.json`, `Root.tsx`, scenes, assets). `video-frames` writes ONE scene component file — the user already has a Remotion project running and asks "give me a glitch-title scene I can drop in" or "I need a lower-third with my logo."

Output: a single `.tsx` file (or 2-3 files for a scene + its helpers) named for the scene (`GlitchTitleScene.tsx`, `LowerThird.tsx`, `KPICountUp.tsx`). The user imports it into their `Composition.tsx` and wraps it in a `<Sequence>`.

---

## Critical Constraints — read these first

1. **One scene = one `.tsx` file** (with at most one tiny helper file beside it for shared constants). Multi-file scene = the user has to copy three files, the integration gets messy.
2. **No project boilerplate.** Do NOT write `package.json`, `Root.tsx`, `remotion.config.ts`. Assume the user has a working project — `video-renderer` is the skill for bootstrapping.
3. **Default export the scene component.** Named export is acceptable; default is preferred — `import GlitchTitle from './scenes/GlitchTitle'` is one line.
4. **Props are typed and have defaults.** Every scene takes a `Props` interface with sensible defaults so the user can use it with zero config OR override every value: `<GlitchTitle title="Ship faster" accent="#ff4d00" duration={60} />`.
5. **Self-contained durations.** The scene declares its intended `durationInFrames` in a JSDoc above the component. The user reads that and uses it for `<Sequence durationInFrames>`. Mismatches end up as freezes or cuts.
6. **No external animation libraries.** Remotion's `interpolate`, `spring`, `Easing`, and `random` are enough for every pattern in this skill.
7. **No project assets assumed.** If the scene needs a logo or audio, it takes the path as a prop (`logoSrc?: string`). Never hardcode `staticFile('logo.svg')` — the user might call their file `brand.svg`.

---

## Common scene patterns — the library

Each pattern below is a real component the agent can write verbatim and then customize to the user's brief. Memorize the patterns; copy + tune is faster and cleaner than improvising.

### Pattern 1 — animated text reveal (type-in)

```tsx
import { AbsoluteFill, useCurrentFrame, interpolate } from 'remotion';

interface Props {
  /** Text to reveal. */
  text: string;
  /** Frames over which the text types in. Default 45 (1.5s @ 30fps). */
  revealFrames?: number;
  /** Hex color. Default white. */
  color?: string;
}

/** Intended durationInFrames: revealFrames + 30 (hold). */
export default function TypeInScene({
  text,
  revealFrames = 45,
  color = '#ffffff',
}: Props) {
  const frame = useCurrentFrame();
  const charsShown = Math.floor(
    interpolate(frame, [0, revealFrames], [0, text.length], {
      extrapolateRight: 'clamp',
    })
  );
  return (
    <AbsoluteFill style={{
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: '#0a0a14',
    }}>
      <h1 style={{
        color, fontFamily: 'Inter, sans-serif', fontSize: 96,
        letterSpacing: -1, margin: 0, whiteSpace: 'pre',
      }}>
        {text.slice(0, charsShown)}
        <span style={{ opacity: frame % 30 < 15 ? 1 : 0 }}>|</span>
      </h1>
    </AbsoluteFill>
  );
}
```

### Pattern 2 — lower-third (caption strip at the bottom)

```tsx
import { AbsoluteFill, useCurrentFrame, spring, useVideoConfig } from 'remotion';

interface Props {
  name: string;
  title: string;
  /** Hex color for the accent bar. */
  accent?: string;
}

/** Intended durationInFrames: 120 (4s) — adjust enter/hold/exit windows below. */
export default function LowerThird({ name, title, accent = '#635bff' }: Props) {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();
  const enter = spring({ frame, fps, config: { damping: 18, stiffness: 120 } });
  const exit = spring({
    frame: durationInFrames - frame - 1, fps,
    config: { damping: 18, stiffness: 120 },
  });
  const x = (1 - Math.min(enter, exit)) * -400; // slides in from left, out to left

  return (
    <AbsoluteFill style={{ pointerEvents: 'none' }}>
      <div style={{
        position: 'absolute', left: 80, bottom: 120,
        transform: `translateX(${x}px)`,
        display: 'flex', alignItems: 'stretch',
      }}>
        <div style={{ width: 6, background: accent }} />
        <div style={{
          background: 'rgba(20, 20, 24, 0.85)',
          padding: '20px 28px', color: '#fff',
          fontFamily: 'Inter, sans-serif',
        }}>
          <div style={{ fontSize: 36, fontWeight: 600 }}>{name}</div>
          <div style={{ fontSize: 22, opacity: 0.75, marginTop: 4 }}>{title}</div>
        </div>
      </div>
    </AbsoluteFill>
  );
}
```

### Pattern 3 — KPI count-up

```tsx
import { AbsoluteFill, useCurrentFrame, interpolate, Easing } from 'remotion';

interface Props {
  /** Final value to count up to. */
  value: number;
  /** Label below the number. */
  label: string;
  /** Suffix (e.g. '%', '+', 'M'). */
  suffix?: string;
  /** Frames over which to count up. Default 60 (2s). */
  countFrames?: number;
}

/** Intended durationInFrames: countFrames + 30. */
export default function KPICountUp({
  value, label, suffix = '', countFrames = 60,
}: Props) {
  const frame = useCurrentFrame();
  const current = Math.round(
    interpolate(frame, [0, countFrames], [0, value], {
      extrapolateRight: 'clamp',
      easing: Easing.out(Easing.cubic),
    })
  );
  return (
    <AbsoluteFill style={{
      display: 'flex', flexDirection: 'column', alignItems: 'center',
      justifyContent: 'center', background: '#fafafa',
    }}>
      <div style={{
        fontFamily: 'Inter, sans-serif', fontSize: 240, fontWeight: 700,
        color: '#111', fontVariantNumeric: 'tabular-nums', letterSpacing: -4,
      }}>
        {current}{suffix}
      </div>
      <div style={{ fontSize: 36, color: '#666', marginTop: 8 }}>{label}</div>
    </AbsoluteFill>
  );
}
```

`fontVariantNumeric: 'tabular-nums'` is the critical detail — without it, the digits jitter horizontally as they change width.

### Pattern 4 — glitch title (RGB-split + jitter)

```tsx
import { AbsoluteFill, useCurrentFrame, random } from 'remotion';

interface Props {
  text: string;
  /** Probability per frame of a glitch flash. 0..1, default 0.15. */
  glitchRate?: number;
}

/** Intended durationInFrames: 90 (3s). */
export default function GlitchTitle({ text, glitchRate = 0.15 }: Props) {
  const frame = useCurrentFrame();
  const isGlitching = random(`g-${frame}`) < glitchRate;
  const dx = isGlitching ? (random(`x-${frame}`) - 0.5) * 8 : 0;
  const dy = isGlitching ? (random(`y-${frame}`) - 0.5) * 4 : 0;
  return (
    <AbsoluteFill style={{
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: '#000',
    }}>
      <div style={{ position: 'relative', fontFamily: 'monospace', fontSize: 120, fontWeight: 800 }}>
        <span style={{ position: 'absolute', color: '#ff0040', transform: `translate(${dx - 3}px, ${dy}px)`, opacity: isGlitching ? 0.85 : 0 }}>{text}</span>
        <span style={{ position: 'absolute', color: '#00f0ff', transform: `translate(${dx + 3}px, ${dy}px)`, opacity: isGlitching ? 0.85 : 0 }}>{text}</span>
        <span style={{ position: 'relative', color: '#fff' }}>{text}</span>
      </div>
    </AbsoluteFill>
  );
}
```

`random('g-${frame}')` is Remotion's seeded random — deterministic across renders, jittery per frame.

### Pattern 5 — logo outro (scale + fade)

```tsx
import { AbsoluteFill, useCurrentFrame, spring, useVideoConfig, Img } from 'remotion';

interface Props {
  /** Path passed to `staticFile()` by the parent. Default: '/logo.svg'. */
  logoSrc?: string;
  tagline?: string;
}

/** Intended durationInFrames: 60 (2s). */
export default function LogoOutro({ logoSrc = '/logo.svg', tagline }: Props) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const scale = spring({ frame, fps, from: 0.6, to: 1.0,
                         config: { damping: 14, stiffness: 90 } });
  const opacity = Math.min(1, frame / 15);
  return (
    <AbsoluteFill style={{
      display: 'flex', flexDirection: 'column',
      alignItems: 'center', justifyContent: 'center',
      background: '#fff',
    }}>
      <Img src={logoSrc} style={{ width: 320, transform: `scale(${scale})`, opacity }} />
      {tagline && (
        <div style={{ marginTop: 24, fontFamily: 'Inter, sans-serif',
                      fontSize: 28, color: '#444', opacity }}>
          {tagline}
        </div>
      )}
    </AbsoluteFill>
  );
}
```

---

## Concrete examples — two real handoffs

### Example 1 — user has a project, asks for a glitch title

User: "I've got a Remotion project running. Drop me a 3-second glitch title for the word 'CHAOS' in pure black bg."

Agent writes `GlitchTitle.tsx` from Pattern 4 verbatim, then in the reply:

> Wrote `GlitchTitle.tsx`. Drop it in `src/scenes/`, then in your `Composition.tsx`:
>
> ```tsx
> import GlitchTitle from './scenes/GlitchTitle';
> // …
> <Sequence from={0} durationInFrames={90}>
>   <GlitchTitle text="CHAOS" glitchRate={0.2} />
> </Sequence>
> ```
>
> Bump `Root.tsx` `durationInFrames` by 90 (or it'll clip). Preview with `npx remotion preview`.

### Example 2 — KPI count-up + lower-third for a SaaS reel

User: "I need two scenes — a big '47%' KPI count-up with label 'faster shipping', then a lower-third for our CEO Jane Smith, CEO, Acme."

Agent writes TWO files: `KPICountUp.tsx` (Pattern 3) and `LowerThird.tsx` (Pattern 2). Sets `accent="#635bff"` on the lower-third to match the brand the user mentioned earlier in the thread. Reply gives the user the two `<Sequence>` blocks to drop in, with the right `from` and `durationInFrames` for each:

```tsx
<Sequence from={0}   durationInFrames={90}>
  <KPICountUp value={47} suffix="%" label="faster shipping" />
</Sequence>
<Sequence from={90}  durationInFrames={120}>
  <LowerThird name="Jane Smith" title="CEO, Acme" accent="#635bff" />
</Sequence>
```

---

## Anti-patterns

- **Writing the whole project just to add one scene.** Wrong skill — use `video-renderer` for new projects. `video-frames` adds to an existing one.
- **Hardcoded asset paths.** Never `staticFile('jane-headshot.jpg')` inside the scene — accept a `headshotSrc` prop and let the parent wire it.
- **Pattern improvisation when a pattern fits.** If the user asks for "type-in text," reach for Pattern 1, don't roll a fresh tween. The patterns are tested; improvisation isn't.
- **Forgetting `extrapolateRight: 'clamp'`.** Without it, values keep extrapolating past the end frame and your animation drifts off-screen during the hold.
- **Tabular numerals omitted on KPI count-ups.** Digits will jitter horizontally as widths change. `fontVariantNumeric: 'tabular-nums'` is required.
- **Missing JSDoc on intended duration.** The user has to guess how long to make the `<Sequence>`. Always declare `Intended durationInFrames: NN`.
- **`Math.random()` instead of Remotion's `random(seed)`.** Renders non-deterministically; output differs between preview and final render.
