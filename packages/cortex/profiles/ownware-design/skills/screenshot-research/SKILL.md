---
name: screenshot-research
description: Write a runnable Playwright script that captures competitor / inspiration pages at multiple viewports, so the user has a local research folder of reference screenshots before any direction is picked. Use when the brief calls for "study how Stripe / Linear / Vercel does X", "competitor sweep", or "match what these three sites do". Skip when one manually-pasted reference URL is enough — just open it and describe it back.
trigger: /screenshot-research
---

# Screenshot Research — Playwright scripts written to disk

## Overview

This skill writes a Playwright script. Ownware does not drive headless browsers in-product yet — the agent produces `./scripts/screenshot.mjs` (and optionally `./scripts/playwright.config.mjs`); the user runs `npm install playwright @playwright/test && npx playwright install chromium && node scripts/screenshot.mjs`. Output lands in `./research/*.png`. When in-product browser driving ships, this skill stays the same and a new tool will execute it.

A screenshot sweep earns its place when the next design choice depends on seeing how peers ship the same surface — competitor hero density, pricing-table conventions, dashboard layouts, mobile-first nav. One URL is not a sweep; that's just a reference paste. Three to six URLs at two viewports each (desktop + mobile) is the sweet spot.

---

## Critical Constraints — read these first, every time

1. **The agent writes; the user runs.** Never invoke `shell_execute` to run Playwright. The user installs the browser binaries (~150MB) and runs the script.
2. **Output folder is `./research/`.** Create it in the script with `fs.mkdirSync('./research', { recursive: true })`. Naming convention: `<vendor>-<surface>-<device>.png` — `stripe-pricing-desktop.png`, `linear-home-mobile.png`. Lowercase, kebab-case.
3. **Pin Playwright.** `playwright@^1.48.0` in the install line. A newer Playwright might bundle a Chromium that breaks the site under capture.
4. **Three viewports, one canonical set.** Desktop `1440×900`, mobile `390×844` (iPhone 15 reference), tablet `1024×768`. Don't invent new sizes unless the brief calls for them — a wall of inconsistent sizes is hard to read.
5. **Wait properly.** `waitUntil: 'networkidle'` THEN an extra `await page.waitForTimeout(800)` for paint races and font swap. Most marketing pages have a 200–500ms hydration jitter you'll otherwise capture mid-flight.
6. **`fullPage: false` for hero captures, `fullPage: true` for whole-page sweeps.** Default to `fullPage: true` since the value is "see how they laid it out" — but cap height to ~6000px (`clip`) when a page is infinite-scroll, otherwise the file balloons.
7. **Block third-party junk before capture.** Cookies banners and chat widgets ruin the shot. Route-block obvious ones (`*.cookiebot.com`, `*.intercom.io`, `*.drift.com`); leave the rest for the user to dismiss on a second pass.
8. **No headless: false.** Always headless. Faster, no flicker, identical output to the user.

---

## The canonical script — produce this, every time

The agent writes ONE file: `./scripts/screenshot.mjs`. A second file `./scripts/playwright.config.mjs` is optional and only worth writing if the user will run `@playwright/test` style assertions later — for a one-off research sweep, skip it.

```js
// scripts/screenshot.mjs
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const OUT = './research';
mkdirSync(OUT, { recursive: true });

const VIEWPORTS = {
  desktop: { width: 1440, height: 900 },
  mobile:  { width: 390,  height: 844 },
  // add tablet only if the brief calls for it
  // tablet:  { width: 1024, height: 768 },
};

const TARGETS = [
  { slug: 'stripe-pricing',  url: 'https://stripe.com/pricing' },
  { slug: 'linear-home',     url: 'https://linear.app' },
  { slug: 'vercel-pricing',  url: 'https://vercel.com/pricing' },
];

// Hosts to block — kills cookie banners and chat widgets that would ruin the shot.
const BLOCK = [
  /cookiebot\.com/, /onetrust\.com/, /intercom\.io/, /drift\.com/,
  /hotjar\.com/, /usercentrics\.eu/, /trustarc\.com/,
];

const browser = await chromium.launch({ headless: true });

try {
  for (const target of TARGETS) {
    for (const [device, viewport] of Object.entries(VIEWPORTS)) {
      const context = await browser.newContext({
        viewport,
        deviceScaleFactor: 2,           // retina-quality PNG
        userAgent: device === 'mobile'
          ? 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15'
          : undefined,
      });

      await context.route('**/*', route => {
        const url = route.request().url();
        if (BLOCK.some(rx => rx.test(url))) return route.abort();
        return route.continue();
      });

      const page = await context.newPage();
      try {
        await page.goto(target.url, { waitUntil: 'networkidle', timeout: 30_000 });
      } catch (err) {
        console.error(`[skip] ${target.slug}/${device}: ${err.message}`);
        await context.close();
        continue;
      }

      // Paint settle — wait for font swap + lazy-loaded above-the-fold images.
      await page.waitForTimeout(800);

      const out = join(OUT, `${target.slug}-${device}.png`);
      await page.screenshot({
        path: out,
        fullPage: true,
        animations: 'disabled',          // freeze GSAP / Framer mid-state
      });
      console.log(`[ok]   ${out}`);

      await context.close();
    }
  }
} finally {
  await browser.close();
}
```

`deviceScaleFactor: 2` is mandatory — without it, screenshots come out 72dpi and look fuzzy when the user opens them at full size. `animations: 'disabled'` freezes any in-flight motion at the moment of capture, which is what you want for reference shots; otherwise a Linear or Stripe hero animation captures mid-fade and looks broken.

---

## Concrete examples — two end-to-end runs

### Example 1 — Three competitor pricing pages at two viewports

User: "Sweep Stripe, Linear, and Vercel pricing pages at desktop and mobile so I can study how they handle tier comparison."

Agent writes `./scripts/screenshot.mjs` with:

- `TARGETS = [{ slug: 'stripe-pricing', url: '...' }, { slug: 'linear-pricing', url: '...' }, { slug: 'vercel-pricing', url: '...' }]`
- `VIEWPORTS = { desktop: {1440×900}, mobile: {390×844} }`
- Output: 6 PNGs in `./research/`.

Reply ends with: "Wrote `./scripts/screenshot.mjs` — 3 vendors × 2 viewports = 6 captures. Run `npm install playwright@^1.48.0 && npx playwright install chromium && node scripts/screenshot.mjs`. Files land in `./research/{vendor}-pricing-{device}.png`. The script blocks the usual cookie/chat junk, but if a vendor pops a region-specific banner you may need to dismiss once manually."

### Example 2 — Single-vendor mobile-first sweep across five surfaces

User: "I want to study Notion's whole mobile surface — home, pricing, integrations, templates, AI page — for the new responsive design."

Agent writes the same `screenshot.mjs` but with one viewport (`mobile: 390×844`) and five targets:

```js
const TARGETS = [
  { slug: 'notion-home',         url: 'https://www.notion.so' },
  { slug: 'notion-pricing',      url: 'https://www.notion.so/pricing' },
  { slug: 'notion-integrations', url: 'https://www.notion.so/integrations' },
  { slug: 'notion-templates',    url: 'https://www.notion.so/templates' },
  { slug: 'notion-ai',           url: 'https://www.notion.so/product/ai' },
];
const VIEWPORTS = { mobile: { width: 390, height: 844 } };
```

Output: 5 mobile PNGs. Reply: "Wrote `./scripts/screenshot.mjs` — Notion across 5 surfaces, mobile only. Same install/run command. Naming convention: `notion-<surface>-mobile.png`."

---

## Anti-patterns

- **Calling `shell_execute` to run Playwright.** Stop. The user installs the browser binaries; the agent only writes the script. Ownware's canvas doesn't drive headless browsers yet.
- **`waitUntil: 'load'` only.** Stop. `load` fires when DOMContentLoaded + load events are done, often BEFORE hydration / React mount / font swap. Use `networkidle` + the 800ms settle.
- **Inventing viewport sizes.** Stop. `1440×900`, `390×844`, `1024×768` — three canonical sizes, no `1366×768`, no `412×915`. Consistency matters when comparing six screenshots side by side.
- **Forgetting `deviceScaleFactor: 2`.** Stop. Standard-DPI screenshots look soft. Retina captures are crisp at the same resolution the user views them in.
- **Capturing animated state without `animations: 'disabled'`.** Stop. Hero animations captured mid-fade are useless references.
- **Hardcoding output to absolute paths.** Stop. `./research/` is relative to the user's `cwd`; portable across machines.
- **Skipping route-blocking and complaining when the user sees a cookie banner.** Stop. Block the obvious ones (Cookiebot, OneTrust, Intercom, Drift, Hotjar, Usercentrics) up front.
- **Capturing 15 sites in one run.** Stop. 3–6 vendors at 2 viewports is the sweet spot. More than 12 captures and the user can't actually compare them — the working memory is gone.
