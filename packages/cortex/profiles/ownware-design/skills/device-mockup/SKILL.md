---
name: device-mockup
description: Render real product UI inside a CSS-built iPhone, MacBook, or browser-frame mockup in a single HTML artifact — for App Store shots, hero embeds, deck slides, marketing pages. Pure CSS / SVG devices, no external mockup-PNG URLs. Use for "show our app on iPhone", "render this dashboard inside a MacBook", "App-Store-ready hero". Skip when a raw screenshot does the job, or when the request is a 3D scene (use `/threejs-scene`).
trigger: /device-mockup
---

# Device Mockup — CSS-built iPhone / MacBook / browser frames

## Overview

A device mockup wraps real product UI in a recognizable hardware shell — iPhone bezels, MacBook lid, Chrome-style browser chrome — so the screenshot reads as "this product, in context." Done right, it makes a landing-page hero feel real. Done wrong, it screams "stock asset" and undermines the page.

This skill ships everything in CSS / SVG inside a single HTML file. No external mockup-PNG URLs (Unsplash, Dribbble, Mockuuups), no Photoshop comps. The "screen" inside the device is a real `<div>` rendering real markup the artifact already has — so the mockup updates live when content changes.

---

## Critical Constraints — read these first, every time

1. **CSS / SVG only.** Never embed an external mockup image. Draw the device with CSS borders, gradients, and SVG paths for the camera notch / speaker grille.
2. **Real content inside the screen.** Use the user's actual data, not lorem ipsum. The screen is a `<div class="screen">` with real headings, real buttons, real numbers. No "Your text here" placeholders.
3. **One device per viewport region.** A hero with three iPhones lined up reads as a stock-asset photo. Pick one hero device; secondary devices go in lower regions.
4. **Hardware colors are factory-correct.** Titanium silver `#a8a8ad` for iPhone 15 Pro frame, space black `#262626`, gold `#dcc7a1`. Never made-up "modern dark gray." If you're not sure, default to titanium silver — most neutral.
5. **Screen radius matches device.** iPhone 15 Pro = `56px` border-radius on a `375×812` viewport. MacBook 14" lid = `12px` outer, `8px` inner display. Wrong radius reads as broken.
6. **`overflow: hidden` on the screen container.** Otherwise inner UI bleeds past the device frame and breaks the illusion.
7. **No real animation by default.** Static mockup. If the brief calls for a slow turntable (rotate -12° → 12°), gate it on `prefers-reduced-motion`.
8. **Honor mobile viewport math.** Inside an iPhone, body text is `14–16px`, not `text-7xl`. Tailwind defaults that look right on a 1440 desktop are far too large inside a 375 mobile mock.

---

## The three canonical devices

You'll use these three 95% of the time. Memorize the dimensions.

### iPhone 15 Pro

- **Outer:** `393×852` (logical CSS pixels for the Pro). For mockup use, scale to `width: 320px; aspect-ratio: 393/852` and let the layout decide the on-page size.
- **Frame:** `4px` solid titanium silver `#a8a8ad`, outer radius `56px`, with an inner `2px` shadow inset for depth.
- **Screen:** inner radius `52px`, true black `#000` background bleeds behind the inner UI.
- **Dynamic Island:** centered, top `12px`, `120×34px` pill, `#000`, radius `999px`.

### MacBook Pro 14"

- **Lid + display:** outer `width: 720px; aspect-ratio: 16/10`, frame `12px` solid `#1c1c1e`, outer radius `12px`, inner display radius `4px`.
- **Top notch:** centered, `180×24px`, `#000`, radius `0 0 8px 8px`.
- **Base / keyboard:** a separate `<div>` below the lid, `720×24px`, `#cccccc → #777` linear gradient bottom, no key detail (don't draw key caps — reads as toy).
- **Trackpad hint:** `220×4px` darker line on the base, centered.

### Browser frame ("Chrome-ish")

- **Outer:** flexible width, `aspect-ratio` set by content. Frame `1px solid var(--border)`, radius `12px`, soft shadow `0 24px 56px rgba(0,0,0,0.18)`.
- **Top bar:** `40px` tall, `var(--surface)` background. Three traffic-light dots: `12px` circles, colors `#ff5f57 / #febc2e / #28c840`, left-padded `12px`, gap `8px`.
- **URL pill:** centered or left-aligned, `var(--surface-2)` background, `8px` radius, `28px` height, padding `0 12px`, monospace caption.
- **Body:** `var(--surface)` rendering the real product UI inside.

---

## Concrete examples — two full mockups

### Example 1 — iPhone 15 Pro with a real fintech app screen

```html
<style>
  .iphone-stage { display: grid; place-items: center; padding: 64px 24px; background: radial-gradient(ellipse at top, #1f1f24, #0a0a0f 70%); }
  .iphone { position: relative; width: 320px; aspect-ratio: 393/852; background: #a8a8ad; border-radius: 56px; padding: 4px; box-shadow: inset 0 0 0 1px #d5d5d8, 0 24px 56px rgba(0,0,0,0.5); }
  .iphone .screen { position: relative; width: 100%; height: 100%; background: #000; border-radius: 52px; overflow: hidden; color: #fff; font: 14px/1.4 -apple-system, "SF Pro", system-ui; }
  .iphone .island { position: absolute; top: 12px; left: 50%; transform: translateX(-50%); width: 120px; height: 34px; background: #000; border-radius: 999px; z-index: 2; }
  .status { display: flex; justify-content: space-between; padding: 16px 22px 0; font-size: 13px; font-weight: 600; }
  .app-body { padding: 56px 18px 24px; }
  .balance { font-size: 42px; font-weight: 700; letter-spacing: -0.02em; margin: 12px 0 4px; }
  .balance-sub { color: #8e8e93; font-size: 13px; }
  .actions { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; margin: 24px 0; }
  .actions button { background: #1c1c1e; color: #fff; border: 0; border-radius: 12px; padding: 14px 8px; font-size: 12px; }
  .tx { padding: 12px 0; border-top: 1px solid #1c1c1e; display: flex; justify-content: space-between; }
</style>

<section class="iphone-stage" data-cx-id="iphone-hero">
  <div class="iphone">
    <div class="screen">
      <div class="island"></div>
      <div class="status"><span>9:41</span><span>•••</span></div>
      <div class="app-body">
        <div class="balance-sub">Acme · Personal</div>
        <div class="balance">$12,438.20</div>
        <div class="balance-sub">+ $214 this week</div>
        <div class="actions">
          <button>Send</button><button>Receive</button><button>Swap</button><button>Card</button>
        </div>
        <div class="tx"><span>Stripe payout</span><span>+ $2,800</span></div>
        <div class="tx"><span>Whole Foods</span><span>− $48.12</span></div>
        <div class="tx"><span>Lyft</span><span>− $14.30</span></div>
      </div>
    </div>
  </div>
</section>
```

Notice: numbers and labels are real. No "Your balance here." If the user hasn't supplied data, use defensible neutral examples (Stripe payout, Whole Foods, Lyft) — recognizable enough to read as a real account, generic enough to not impersonate.

### Example 2 — MacBook lid with a dashboard inside

```html
<style>
  .macbook-stage { padding: 80px 6vw; background: linear-gradient(180deg, #f3f3f5, #e8e8eb); display: grid; justify-items: center; }
  .macbook { width: 720px; max-width: 100%; }
  .macbook .lid { position: relative; aspect-ratio: 16/10; background: #1c1c1e; border-radius: 12px; padding: 12px 12px 12px; box-shadow: 0 30px 80px rgba(0,0,0,0.25); }
  .macbook .notch { position: absolute; top: 0; left: 50%; transform: translateX(-50%); width: 180px; height: 24px; background: #000; border-radius: 0 0 8px 8px; z-index: 2; }
  .macbook .screen { width: 100%; height: 100%; background: #fafafa; border-radius: 4px; overflow: hidden; font: 13px/1.5 "Inter", system-ui; color: #111; }
  .macbook .base { width: 720px; max-width: 100%; height: 18px; margin-top: -2px; background: linear-gradient(180deg, #cfcfd2, #8a8a8d); border-radius: 0 0 18px 18px; box-shadow: 0 12px 24px rgba(0,0,0,0.18); position: relative; }
  .macbook .base::after { content: ""; position: absolute; left: 50%; bottom: 4px; transform: translateX(-50%); width: 220px; height: 4px; background: #6e6e72; border-radius: 4px; }
  .dash { padding: 24px 28px; }
  .dash h2 { margin: 0 0 16px; font-size: 18px; }
  .kpis { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; }
  .kpi { background: #fff; border: 1px solid #e5e5e5; border-radius: 8px; padding: 14px 16px; }
  .kpi-label { color: #6b6b6b; font-size: 12px; }
  .kpi-value { font-size: 22px; font-weight: 600; margin-top: 4px; }
</style>

<section class="macbook-stage" data-cx-id="macbook-hero">
  <div class="macbook">
    <div class="lid">
      <div class="notch"></div>
      <div class="screen">
        <div class="dash">
          <h2>Q3 — Revenue overview</h2>
          <div class="kpis">
            <div class="kpi"><div class="kpi-label">MRR</div><div class="kpi-value">$184k</div></div>
            <div class="kpi"><div class="kpi-label">Net new</div><div class="kpi-value">+$12.4k</div></div>
            <div class="kpi"><div class="kpi-label">Churn</div><div class="kpi-value">2.1%</div></div>
            <div class="kpi"><div class="kpi-label">Trials</div><div class="kpi-value">412</div></div>
          </div>
        </div>
      </div>
    </div>
    <div class="base"></div>
  </div>
</section>
```

The base sits *below* the lid as a separate element — much more honest than trying to draw a hinge with a `box-shadow` trick. The trackpad hint is one `::after` line; resist the urge to draw the keyboard.

---

## Anti-patterns

- **Embedding a `https://...mockuuups.../iphone.png` URL.** Stop. External mockup PNGs are stock assets — the page reads as templated. CSS-built devices look bespoke.
- **`text-7xl` inside an iPhone screen.** Stop. Mobile body is `14–16px`. If the type is loud, it's because the device is small, not because the type is big.
- **Drawing keyboard keys on the MacBook base.** Stop. Reads as toy. A single trackpad-hint line is enough.
- **Three iPhones in a row in the hero.** Stop. One hero device, full size; secondary devices live in feature rows further down.
- **Lorem ipsum or "Your text here" inside the screen.** Stop. Use the user's real content. If they haven't given any, use defensible neutral examples (Stripe payout, Whole Foods) — never `Lorem dolor sit amet`.
- **Wrong frame radius (`24px` on an iPhone).** Stop. iPhone 15 Pro is `56px` outer, `52px` inner screen. Use those.
- **Made-up frame colors.** Stop. Titanium silver `#a8a8ad`, space black `#262626`, gold `#dcc7a1`. Anything else looks fake.
- **Forgetting `overflow: hidden` on the screen.** Stop. Inner UI bleeds past the corners; the illusion breaks instantly.
- **Animating a turntable without a reduced-motion guard.** Stop. Spinning devices on a vestibular-sensitive user is a fail. Gate on `prefers-reduced-motion`.
- **Reaching for `/threejs-scene` to build a 2D device frame.** Stop. CSS is enough. Three.js is for actual 3D scenes — particle fields, rotating logos, low-poly objects — not for a tilted iPhone.
