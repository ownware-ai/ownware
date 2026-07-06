# Tech Utility

> Category: tech
> Dense, dark, information-rich. The operator's surface.

## 1. Visual theme & atmosphere

The "the agent works here" system. Dark surface, tight density, monospace-leaning numerals, single restrained accent. This is the design vocabulary of developer dashboards, ops consoles, log viewers, terminals, internal admin tools, observability platforms, container orchestrators — surfaces where the user is *doing work*, not browsing.

Density is the headline. Body type lands at 13–14px, line-height tightens to 1.4–1.45, table cells run at 12–13px with tabular numerals. Cards have small padding (10–14px), borders are explicit and visible, dividers run hard. The surface is dark not for mood but for *signal isolation* — colored states (red errors, green successes, blue links) read crisply against `#0d1117`; on white they wash.

The system has two surface tiers: `--surface` (the card / panel background) and `--surface-2` (an elevated step for popovers, modals, hover states). The contrast between them is small (`#161b22` vs `#1f242c`) — just enough to differentiate without breaking the visual rest the dark canvas provides.

This system is the right answer when:

- The user is an operator, an SRE, a developer, a data analyst. Power-user audiences.
- The artifact is dense — many small components, not a few large ones.
- The eye will scan rather than read.

It is the **wrong** answer for marketing pages aimed at non-technical buyers, consumer products, and anywhere a casual user has to decide whether to trust the product. Dark surfaces still trigger "this isn't for me" in mainstream audiences; respect that.

## 2. Color palette & roles

- **Background** (`--bg`, `#0d1117`): the deep base. GitHub-dark adjacent. Never pure black — pure black eats the gaps between surface tiers.
- **Surface** (`--surface`, `#161b22`): primary card / panel surface. One step up from `--bg`.
- **Surface-2** (`--surface-2`, `#1f242c`): elevated surface — popovers, modals, sticky chrome, table header rows.
- **Foreground** (`--fg`, `#e6edf3`): primary text. Off-white, slightly cool.
- **Muted** (`--muted`, `#8b949e`): secondary text, captions, tertiary labels.
- **Border** (`--border`, `#30363d`): explicit borders. In this system, borders are *visible*, not hairline — the eye uses them to parse dense layouts.
- **Accent** (`--accent`, `#58a6ff`): a bright cool blue. Links, focus rings, primary CTA outline-fill. Stays cool to match the surface temperature.
- **Accent fg** (`--accent-fg`, `#0d1117`): dark base used on the rare filled-accent button. In practice, accent buttons here are outline-style.
- **Semantic** (`--good` `#3fb950`, `--warn` `#d29922`, `--bad` `#f85149`): bright on dark, intentionally vivid. State color is load-bearing in operator tools — make it readable.

## 3. Typography rules

- **Display:** `-apple-system, system-ui, "Helvetica Neue", Arial, sans-serif`. No serif here — serif breaks the utility register.
- **Body:** same as display, used at 13–14px. System sans is faster to render and matches the OS-native feel operators expect.
- **Mono:** `ui-monospace, 'JetBrains Mono', SF Mono, Menlo, Consolas, monospace`. Used liberally — code, logs, IDs, timestamps, tabular numerals.
- **Scale (px):** 11 / 12 / 13 / 14 / 16 / 20 / 24 / 32 / 40. Note: 11px and 12px exist for very small labels (column headers, metadata). Use sparingly.
- **Line height:** 1.4 on body, 1.35 on table rows, 1.15 on headings.
- **Letter-spacing:** 0 on body. 0.06em on uppercase column headers ("STATUS", "OWNER").
- **text-wrap:** `pretty` on prose paragraphs; off on table cells (default wrapping).
- **Numerals:** `font-variant-numeric: tabular-nums` on every numeric column. Non-negotiable in this system.

## 4. Spacing & density

- **Section padding:** 24–32px desktop, 16px mobile. Dense — this is admin, not marketing.
- **Component padding:** cards 12–18px, buttons 6×12, inputs 6×10, table cells 8×12.
- **Radius:** 6px on cards, 6px on buttons, 4px on inputs. Small radii match utility register.
- **Pills:** 999px, used for status chips (`active`, `error`, `pending`).
- **Gutters:** 8–12px between cards. Tighter than modern-minimal.
- **Borders:** 1px visible, often everywhere. The dense layout depends on them.

## 5. Signature moves & avoid list

**The one decisive flourish per artifact:** in this system, the flourish is *information density done well*. A dashboard that shows 12 KPIs at once, legibly, without feeling like a war room — that's the move. Or a single inline sparkline rendered with restraint. Or a status table with perfect tabular alignment, mono numerals, and color-coded pills that pop against the dark surface.

**Avoid:**

- Light-on-dark *and* dark-on-light in the same artifact. Pick a temperature. Mixed surface modes in one artifact read as un-designed.
- Bright pastel accents. The cool blue is identity-defining; pinks, oranges, magentas drift into the `experimental` zone.
- Generous radii (12px+). The system's identity is tight; rounded corners soften it into the wrong feel.
- Generous whitespace. Section padding above 40px reads as marketing-bleed.
- Serif anywhere. Even for hero numbers — sans only.
- Drop shadows. Borders carry separation; shadows here read as iOS-2014.
- Hero illustrations. This is admin; illustrate less, label more.
- Body type at 16px+. The system breaks above 15px body — too marketing-feeling.
