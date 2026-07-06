---
name: macos-notif-frame
description: 'macOS Big Sur-style notification banner as a CSS+HTML drop-in. 350×80px, rounded 12px, frosted glass backdrop, app icon left + title and body center + dismiss right. Use for product mocks, marketing screenshots, video overlays showing an app announcement. Skip for full OS chrome (use /device-mockup) or for in-product toast notifications (those follow your app''s design system, not macOS).'
trigger: /macos-notif-frame
---

# macOS Notification Frame — frosted-glass banner drop-in

## Overview

A single visual element: the macOS Big Sur+ notification banner. Drop it into a product mock, a marketing screenshot, or a video frame to show "your app just sent a notification". This skill ships the exact CSS — frosted glass, real values, the same shadow stack Apple uses.

For full OS-chrome around an app screenshot use `/device-mockup`. For a stack of banners with stagger animation use the worked example below.

---

## Critical Constraints

1. **Exact dimensions: 350×80px** (compact) or **350×104px** (with body line). Anything wider reads as "fake macOS"; the real OS banner is 350px.
2. **Border radius is 12px.** Not 8px (that's iOS). Not 16px (that's Material). 12px corners are the macOS Big Sur convention.
3. **Backdrop is real frosted glass.** `backdrop-filter: blur(20px) saturate(180%);` plus a translucent layer color. Both `backdrop-filter` and `-webkit-backdrop-filter` so Safari works.
4. **Type sizes are non-negotiable.** App name `13px / 600 / +0.01em`. Body `12px / 400`. Timestamp `11px / 400 / muted`. Title (when present) `13px / 600`. All in SF Pro / Inter / system-ui.
5. **App icon is 32×32px, rounded 7px.** Not a circle, not square. macOS app icons sit on a 7px-rounded squircle when scaled to 32.
6. **Shadow stack is layered, not single.** `0 10px 40px rgba(0,0,0,0.18), 0 2px 6px rgba(0,0,0,0.08)` — the close shadow grounds, the far shadow lifts.
7. **Light vs dark mode.** Light = `rgba(245,245,247,0.78)` over light backgrounds. Dark = `rgba(28,28,30,0.78)` over dark. Pick by surrounding context, not by toggle.

---

## The CSS — paste-ready

```html
<style>
:root {
  --notif-bg: rgba(245, 245, 247, 0.78);
  --notif-bg-dark: rgba(28, 28, 30, 0.78);
  --notif-fg: #1d1d1f;
  --notif-fg-dark: #f5f5f7;
  --notif-muted: rgba(60, 60, 67, 0.6);
  --notif-muted-dark: rgba(235, 235, 245, 0.6);
  --notif-border: rgba(0, 0, 0, 0.06);
  --notif-border-dark: rgba(255, 255, 255, 0.08);
}

.macos-notif {
  width: 350px;
  border-radius: 12px;
  padding: 12px 14px;
  display: grid;
  grid-template-columns: 32px 1fr auto;
  gap: 10px;
  align-items: center;
  background: var(--notif-bg);
  -webkit-backdrop-filter: blur(20px) saturate(180%);
  backdrop-filter: blur(20px) saturate(180%);
  border: 1px solid var(--notif-border);
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.5),
    0 2px 6px rgba(0, 0, 0, 0.08),
    0 10px 40px rgba(0, 0, 0, 0.18);
  font-family: -apple-system, "SF Pro Text", Inter, system-ui, sans-serif;
  color: var(--notif-fg);
}

.macos-notif.dark {
  background: var(--notif-bg-dark);
  border-color: var(--notif-border-dark);
  color: var(--notif-fg-dark);
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.08),
    0 2px 6px rgba(0, 0, 0, 0.32),
    0 10px 40px rgba(0, 0, 0, 0.5);
}

.macos-notif__icon {
  width: 32px;
  height: 32px;
  border-radius: 7px;
  display: grid;
  place-items: center;
  font-size: 18px;
  background: linear-gradient(135deg, #4f46e5, #7c3aed);
  color: white;
}

.macos-notif__body { min-width: 0; }
.macos-notif__top {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  font-size: 13px;
  font-weight: 600;
  letter-spacing: 0.01em;
}
.macos-notif__time { font-size: 11px; font-weight: 400; color: var(--notif-muted); }
.macos-notif.dark .macos-notif__time { color: var(--notif-muted-dark); }
.macos-notif__title { font-size: 13px; font-weight: 600; margin-top: 2px; }
.macos-notif__text  { font-size: 12px; font-weight: 400; line-height: 1.35; margin-top: 2px;
                      overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
.macos-notif__close { width: 22px; height: 22px; border-radius: 50%; border: 0;
                      background: rgba(0,0,0,0.06); color: var(--notif-muted);
                      font-size: 14px; line-height: 1; cursor: pointer; align-self: start; }
.macos-notif.dark .macos-notif__close { background: rgba(255,255,255,0.08); color: var(--notif-muted-dark); }
</style>
```

```html
<div class="macos-notif" data-cx-id="notif-1">
  <div class="macos-notif__icon">T</div>
  <div class="macos-notif__body">
    <div class="macos-notif__top"><span>Ownware</span><span class="macos-notif__time">now</span></div>
    <div class="macos-notif__title">Agent finished compiling the report</div>
    <div class="macos-notif__text">Q3 review is ready — 12 KPI tiles, 3 wins, 3 misses. Open to review.</div>
  </div>
  <button class="macos-notif__close" aria-label="Dismiss">×</button>
</div>
```

That's the unit. 350×80, frosted, real shadow stack, dismissable.

---

## Concrete example — 3-notification stack with stagger-in animation

For marketing reels: three notifications drop in from the right edge with 200ms stagger between them.

```html
<style>
.notif-stack { position: fixed; top: 32px; right: 32px; display: flex; flex-direction: column; gap: 8px; }
.notif-stack .macos-notif {
  animation: notif-in 360ms cubic-bezier(0.16, 1, 0.3, 1) both;
  transform-origin: top right;
}
.notif-stack .macos-notif:nth-child(2) { animation-delay: 200ms; }
.notif-stack .macos-notif:nth-child(3) { animation-delay: 400ms; }
@keyframes notif-in {
  from { transform: translateX(110%) scale(0.94); opacity: 0; }
  to   { transform: translateX(0)    scale(1);    opacity: 1; }
}
@media (prefers-reduced-motion: reduce) {
  .notif-stack .macos-notif { animation: none; }
}
</style>

<div class="notif-stack" data-cx-id="notif-stack">
  <div class="macos-notif">
    <div class="macos-notif__icon" style="background:linear-gradient(135deg,#22c55e,#16a34a)">M</div>
    <div class="macos-notif__body">
      <div class="macos-notif__top"><span>Mail</span><span class="macos-notif__time">now</span></div>
      <div class="macos-notif__title">3 new messages</div>
      <div class="macos-notif__text">Maya, Jonas, and Priya replied to your interview synthesis.</div>
    </div>
    <button class="macos-notif__close">×</button>
  </div>

  <div class="macos-notif">
    <div class="macos-notif__icon" style="background:linear-gradient(135deg,#8b5cf6,#6d28d9)">L</div>
    <div class="macos-notif__body">
      <div class="macos-notif__top"><span>Linear</span><span class="macos-notif__time">1m</span></div>
      <div class="macos-notif__title">DES-184 marked Done</div>
      <div class="macos-notif__text">Quarterly review deck ships Friday. Reviewer: sam.</div>
    </div>
    <button class="macos-notif__close">×</button>
  </div>

  <div class="macos-notif dark">
    <div class="macos-notif__icon" style="background:linear-gradient(135deg,#0ea5e9,#0369a1)">S</div>
    <div class="macos-notif__body">
      <div class="macos-notif__top"><span>Slack · #design</span><span class="macos-notif__time">2m</span></div>
      <div class="macos-notif__title">Priya tagged you</div>
      <div class="macos-notif__text">Can you take Frame 03's stat from the synthesis doc?</div>
    </div>
    <button class="macos-notif__close">×</button>
  </div>
</div>
```

Three banners drop in over 600ms. Light banners over a light backdrop, the dark variant (`.macos-notif dark`) over a dark Slack context. Honest contrast, honest backdrop blur.

---

## Anti-patterns

- **Solid background instead of frosted glass.** Defeats the entire point — the macOS look IS the blur. Always `backdrop-filter`.
- **Forgetting `-webkit-backdrop-filter`.** Safari is the OS this lives on; missing the prefix kills the effect on the platform that matters.
- **Using a circular app icon.** macOS uses a 7px-rounded squircle at 32px. Circle reads as iOS chat avatar, not as macOS notification.
- **Body text smaller than 12px.** 11px reads as caption; macOS notifications are 12px body. Don't shrink.
- **Stacking 6 notifications.** Real macOS shows max 3 visible; the rest collapse into the Notification Center. Mock the same: 1–3 stacked, never more.
- **External-URL image for the icon.** Mocks fail when offline. Use CSS gradient + emoji or monogram, every time.
