---
name: video-renderer
description: Write a Remotion project (`package.json`, `Composition.tsx`, scene components, assets) to disk via writeFile so the user can render with `npx remotion render` or preview with `npx remotion preview`. Use for branded explainers, social cuts, dashboard-to-video, motion graphics, anything multi-scene with cuts and audio cues. Do NOT use for a single animated component dropped into a larger project — that's `video-frames`.
trigger: /video-renderer
---

# Video Renderer — Remotion projects written to disk

## Overview

This skill writes Remotion source files. Ownware does not render video in-product yet — the agent produces the project on disk, the user runs `npx remotion render` (or `npx remotion preview` to view in browser) themselves. When in-product video rendering ships (Slice 7.5), this skill stays the same and a new tool will execute it.

Output is a **complete, runnable Remotion project**: `package.json` with pinned versions, `remotion.config.ts`, a `src/Root.tsx` that registers compositions, one `src/Composition.tsx` orchestrating scenes, separate `src/scenes/*.tsx` files per scene, and a `public/` folder for assets. The user runs `npm install && npx remotion preview` to see it.

---

## Critical Constraints — read these first

1. **One project per turn.** A "video" is one Remotion project, not five scattered files. Everything lives in `./video-<slug>/`.
2. **Pin Remotion versions.** `remotion@^4.0.0` and `@remotion/cli@^4.0.0`. Never use `latest` — Remotion has breaking changes between majors.
3. **30 fps, 1920×1080 default.** Standard. If the user explicitly asks for vertical (TikTok / Reels / Shorts) it's `1080×1920`. If square (Instagram feed) it's `1080×1080`. Never invent off-spec dimensions.
4. **Each scene is its own file.** `HeroScene.tsx`, `ProblemScene.tsx`, `SolutionScene.tsx`. Never one mega-file with 400 lines of motion. The composition imports them and orders them with `<Sequence>`.
5. **Frames, not seconds, in code.** Remotion thinks in frames. Comment durations in frames AND seconds: `// 90 frames @ 30fps = 3s`.
6. **`interpolate` for every tween.** Hand-tuned keyframes inside `useCurrentFrame`. Never raw math like `frame * 0.05` — that breaks on fps changes.
7. **Assets in `public/`.** Logos, music, voice-over. Reference via `staticFile('logo.svg')`. NEVER hardcode absolute paths — the user's machine is not the agent's machine.
8. **No external animation libraries.** No GSAP, no Framer Motion (it has a Remotion adapter but adds surface). Pure Remotion + `interpolate` + `spring` covers everything this skill makes.

---

## Project shape — exactly this layout, every time

```
video-<slug>/
├── package.json
├── remotion.config.ts
├── tsconfig.json
├── src/
│   ├── Root.tsx              # Registers compositions
│   ├── Composition.tsx       # Top-level scene sequencer
│   └── scenes/
│       ├── HeroScene.tsx
│       ├── FeatureScene.tsx
│       ├── ProofScene.tsx
│       └── LogoOutro.tsx
└── public/
    ├── logo.svg
    ├── voice.mp3            # optional
    └── bgm.mp3              # optional
```

That's the canonical shape. Memorize it.

---

## File-by-file: what each file contains

### `package.json` — pinned, minimal

```json
{
  "name": "video-<slug>",
  "version": "0.1.0",
  "private": true,
  "scripts": {
    "preview": "remotion preview src/index.ts",
    "render":  "remotion render src/index.ts MainComp out/video.mp4"
  },
  "dependencies": {
    "remotion": "^4.0.0",
    "@remotion/cli": "^4.0.0",
    "react": "^18.3.1",
    "react-dom": "^18.3.1"
  },
  "devDependencies": {
    "@types/react": "^18.3.0",
    "typescript": "^5.4.0"
  }
}
```

### `remotion.config.ts`

```ts
import { Config } from '@remotion/cli/config';

Config.setVideoImageFormat('jpeg');
Config.setOverwriteOutput(true);
Config.setConcurrency(4);
```

### `tsconfig.json`

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "jsx": "react-jsx",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true
  },
  "include": ["src"]
}
```

### `src/index.ts` — Remotion entry

```ts
import { registerRoot } from 'remotion';
import { Root } from './Root';
registerRoot(Root);
```

### `src/Root.tsx` — composition registry

```tsx
import { Composition } from 'remotion';
import { MainComp } from './Composition';

export const Root: React.FC = () => (
  <Composition
    id="MainComp"
    component={MainComp}
    durationInFrames={180}      // 6s @ 30fps — sum of all scenes below
    fps={30}
    width={1920}
    height={1080}
  />
);
```

`durationInFrames` MUST equal the sum of all `<Sequence durationInFrames>` in `Composition.tsx`. If they drift, the final frame freezes or cuts mid-scene.

### `src/Composition.tsx` — scene sequencer

```tsx
import { AbsoluteFill, Sequence, Audio, staticFile } from 'remotion';
import { HeroScene }   from './scenes/HeroScene';
import { ProblemScene } from './scenes/ProblemScene';
import { LogoOutro }   from './scenes/LogoOutro';

export const MainComp: React.FC = () => (
  <AbsoluteFill style={{ backgroundColor: '#0d1117' }}>
    <Audio src={staticFile('bgm.mp3')} volume={0.3} />

    <Sequence from={0}   durationInFrames={60}> {/* 0–2s */}
      <HeroScene />
    </Sequence>

    <Sequence from={60}  durationInFrames={90}> {/* 2–5s */}
      <ProblemScene />
    </Sequence>

    <Sequence from={150} durationInFrames={30}> {/* 5–6s */}
      <LogoOutro />
    </Sequence>
  </AbsoluteFill>
);
```

### `src/scenes/HeroScene.tsx` — one scene, one job

```tsx
import { AbsoluteFill, useCurrentFrame, interpolate, spring, useVideoConfig } from 'remotion';

export const HeroScene: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const titleOpacity = interpolate(frame, [0, 20], [0, 1], {
    extrapolateRight: 'clamp',
  });
  const titleY = spring({
    frame, fps,
    config: { damping: 14, stiffness: 90 },
  });

  return (
    <AbsoluteFill style={{
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      flexDirection: 'column', color: '#fff', fontFamily: 'Inter, sans-serif',
    }}>
      <h1 style={{
        opacity: titleOpacity,
        transform: `translateY(${(1 - titleY) * 40}px)`,
        fontSize: 96, margin: 0, letterSpacing: -1,
      }}>
        Ship faster with Acme
      </h1>
    </AbsoluteFill>
  );
};
```

`useCurrentFrame()` returns frame relative to the scene's own `<Sequence from>` — so `frame === 0` is the scene's first frame, not the project's. This is the single most important Remotion concept.

---

## Concrete examples — two complete projects

### Example 1 — 6-second branded explainer (3 scenes)

User: "A 6-second explainer for Acme — hero with our tagline, one problem-solution beat, end card with logo. Dark theme, our brand purple is #635bff."

Agent writes the project in `./video-acme-explainer/` with:

- **`HeroScene.tsx`** (frames 0–60, 2s): Title "Ship faster with Acme" fades in (frames 0–20) + springs up (frames 0–30). Subtitle slides in from below (frames 15–35). Background `#0a0a14`.
- **`ProblemSolutionScene.tsx`** (frames 60–150, 3s): Frame 60–90: "Releases take days." (text in red `#e85a4f`, fades in). Frame 90–120: red text fades out as `#635bff` purple text "→ ship in minutes" slides in from right. Frame 120–150: hold.
- **`LogoOutro.tsx`** (frames 150–180, 1s): `<Img src={staticFile('logo.svg')}>` scales from 0.6 to 1.0 via `spring`, opacity 0 → 1 over frames 0–15. Static for 15.
- `Root.tsx` registers `MainComp` with `durationInFrames: 180`.
- `public/logo.svg` — agent writes a brand-purple SVG logomark.

Reply ends with: "Wrote `./video-acme-explainer/`. Run `cd video-acme-explainer && npm install && npx remotion preview` to see it, then `npx remotion render src/index.ts MainComp out/video.mp4` to export."

### Example 2 — vertical product clip for Shorts (4 scenes, 12s)

User: "TikTok-format 12s video — hook ('what if your dashboard wrote itself?'), three feature shots, end CTA."

Agent writes `./video-dashboard-shorts/`:

- `Root.tsx`: `width: 1080, height: 1920, fps: 30, durationInFrames: 360`.
- Scene 1 — `HookScene.tsx` (0–90 frames, 3s): Huge `text-9xl`-style text "What if your dashboard wrote itself?" Text type-in via `interpolate(frame, [0, 60], [0, 38])` returning a slice length, used as `text.slice(0, sliceLen)`.
- Scene 2 — `Feature1Scene.tsx` (90–180): Screenshot of a chart panel (`staticFile('chart.png')`) zooming in from `scale(1.2)` to `scale(1)`, with caption "AI-picked metrics" sliding in.
- Scene 3 — `Feature2Scene.tsx` (180–270): Same pattern, different asset, different caption.
- Scene 4 — `CTAScene.tsx` (270–360): Big "Try free" pill button (CSS), arrow pointing down to "@acme on App Store" text.

Pinned color tokens at top of each scene: `const ACCENT = '#635bff';` rather than re-using `#635bff` ten times — when the user wants a different brand color, one edit per file.

---

## Anti-patterns

- **Putting all scenes in one file.** A 400-line `Composition.tsx` is unmaintainable. Split into `scenes/`. The composition imports + sequences; it does not animate.
- **Using `setTimeout` / `setInterval` / `requestAnimationFrame`.** Remotion is deterministic — every frame is computed from `useCurrentFrame()`. Browser timers produce off-by-frame jitter on render.
- **`Math.random()` inside a scene.** Renders differently every frame. Use `random(seed)` from Remotion (`import { random } from 'remotion'`) — seeded, deterministic.
- **Hardcoded asset paths.** `'/Users/me/logo.svg'` is broken on the user's machine. Always `staticFile('logo.svg')`, asset under `public/`.
- **Skipping `extrapolateRight: 'clamp'` on `interpolate`.** Without it, the value keeps changing past the input range — your title keeps fading out into negative opacity. Always clamp unless you intend overshoot.
- **Mismatching `Root.durationInFrames` with the sum of sequences.** Result: black frames at the end OR clipped final scene. Sum the sequences; set the total.
- **Suggesting cloud-rendered Remotion (Remotion Lambda).** Out of scope and against Ownware's local-first principle. User renders locally with `npx remotion render`.
