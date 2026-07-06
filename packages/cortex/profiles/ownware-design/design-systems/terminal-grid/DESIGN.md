# Terminal Grid

> Category: tech
> HUD / dev-console aesthetic — near-black canvas, mono everywhere, neon-green telemetry. The developer-tools / infra-dashboard / gaming zone.

## 1. Visual theme & atmosphere

This is the "engineered, not designed" system. It belongs on surfaces that want to look operated rather than marketed — a CLI homepage, an observability dashboard, a game studio's dev-tools page, a self-hosted infra product. Every element looks like it could be a real terminal window: monospace everywhere, visible gridlines, sharp corners, dense numerics, a neon telemetry accent that pulses like a status LED. The system says *"someone serious built this."*

The difference from `tech-utility` (dense dark dev UI) is intent. Tech-utility is dense-but-balanced — proportional body sans, mono only in data cells. Terminal Grid commits fully: **mono everywhere**, gridlines visible, the chrome itself reads as a HUD. Reach for this when the artifact's brief is "this is for engineers, who are proud of being engineers, and want the tool to telegraph that."

Two genre variants exist — *green telemetry* (this default; reads as a UNIX terminal / sci-fi HUD) and *amber CRT* (reads as DOS / 80s defense console). Pick one per artifact; mixing them dilutes both.

## 2. Color palette & roles

- **Background** (`--bg`, `#070b10`): near-black canvas, faintly cool. The deepest layer.
- **Surface** (`--surface`, `#0d1218`): panel and card tier, one step up from `--bg`. Both are dark enough that the gridlines do the structural work.
- **Foreground** (`--fg`, `#d8f5e0`): cool green-white. Pure white reads as too clinical; the very faint green cast matches the telemetry accent and warms the system slightly.
- **Muted** (`--muted`, `#5d6b78`): metadata, timestamps, secondary readouts. Cool steel grey.
- **Border** (`--border`, `#1c2530`): the gridline color. **Borders are VISIBLE in this system, not subliminal.** Most cards have a 1px outline; tables have visible inner gridlines; the system reads as a grid of cells.
- **Accent** (`--accent`, `#3df57c`): neon telemetry green. Used on the primary CTA, active row highlights, focus rings, status LEDs ("ONLINE", "LIVE"), and one hero number per artifact.
- **Accent hover** (`--accent-hover`, `#5cff97`): lighten-on-hover. The accent is luminous; darkening it on hover reads wrong — buttons should glow more, not dim.
- **Accent fg** (`--accent-fg`, `#070b10`): the dark canvas as text-on-accent. White on neon-green is hard to read.
- **Semantic** (`--good` `#3df57c`, `--warn` `#f5c83d`, `--bad` `#ff5d6c`): CRT-saturated. Yes — `--good` equals `--accent`. In Terminal Grid, "positive state" and "primary action" share the same green; the genre conflates them deliberately.

The discipline: **mono is non-negotiable, gridlines are non-negotiable**. The accent color is the only choice the agent gets to make per-artifact — green for terminal/sci-fi feel, amber (`#ffb000`) for retro DOS/CRT feel, cyan (`#3df5e8`) for cold infrastructure feel. Pick one accent before laying out the first component; switching mid-design breaks the LED-status reading.

## 3. Typography rules

- **Font stack:** JetBrains Mono primary, IBM Plex Mono and SF Mono as fallbacks. Same family for display, body, and code — that's the genre.
- **Scale (px):** 11 / 12 / 13 / 14 / 16 / 20 / 28 / 40 / 56.
- **Body:** 13–14px (mono renders larger than sans at the same px). Weight 400 default, 500 for emphasis, 600 for headings.
- **Display:** weight 600 for headlines, 700 for the single oversized telemetry number.
- **Line height:** 1.45 on body (mono needs slightly more leading), 1.1 on display.
- **Letter spacing:** `letter-spacing: 0.04em` on uppercase labels and status pills. This is the only place the system uses uppercase — labels, status, eyebrows. Body text stays sentence-case.
- **Tabular numerics:** `font-variant-numeric: tabular-nums` on every numeric cell. Non-tabular nums in this system look broken.
- **No proportional sans anywhere.** Not in nav, not in captions, not in tooltips. The moment a sans appears, this becomes a different system.

## 4. Spacing & density

- **Section padding:** 64px vertical on desktop, 40px on mobile. Density runs tighter than the other systems — Terminal Grid telegraphs "lots of info, fast read."
- **Card padding:** 16–20px. Tight; the panels are working surfaces, not landing-page tiles.
- **Radius:** 4px on cards and buttons. Pills are also 4px (`--radius-pill` reuses the radius value) — no rounded badges in this genre.
- **Gutters:** 12–16px between cards. Tight grid spacing reinforces the cell-of-readouts feel.

Density runs tight throughout. This is a dense-info system; padding it out to "modern marketing breathe" defeats the purpose.

## 5. Signature moves & avoid list

**Visible gridlines are mandatory.** Tables have inner borders. Cards have 1px outlines. Dashboard surfaces often have a faint repeating grid background (`background-image: linear-gradient(var(--border) 1px, transparent 1px), linear-gradient(90deg, var(--border) 1px, transparent 1px); background-size: 32px 32px; opacity: 0.4;`). Without visible gridlines, this system collapses into "regular dark theme."

**The blinking status LED.** One element per artifact wears a small (8px) circular accent-color dot that pulses (CSS `@keyframes pulse { 50% { opacity: 0.4; } }` at 1.5s). This is the system's signature. It usually lives on the primary status label ("ONLINE", "LIVE", "BUILDING") or beside the active session marker. Without it, the artifact looks like a static screenshot of a HUD; with it, the HUD reads as live.

**The one decisive flourish per artifact:** in this system, the flourish is usually *one oversized telemetry number* (a single 40–80px green number like "98.7%" or "12,408") with the system's tightest tracking and weight 700, *a scanline overlay* on the hero (1px green lines at 4px intervals, very low alpha), or *one terminal-style cursor block* on the headline (`▌` rendered as an accent-green block, blinking). Pick one; layering all three reads as parody.

**Avoid:**

- Proportional sans anywhere. Mono is the genre. Use mono.
- Soft / rounded corners. 4px is the ceiling.
- Pastel or warm accents. Stick to green / amber / cyan — anything else reads as "designer trying to make a HUD" rather than "engineer who built a HUD."
- Invisible borders (alpha-on-dark hairlines). Borders are structural here, not decorative.
- Marketing-loose density. Tight gridlines, tight padding, tight leading. If the page breathes too much it stops reading as a tool.
- Multiple telemetry accents. If green is the chosen accent, every status pulse / LED / active state uses green. Mixing green + amber in one artifact reads as broken.
- Drop shadows. Terminal Grid uses gridlines and 1px borders for structure, never shadows. A box-shadow in this system reads as a Material card imported by mistake.
- Photography. The genre is text-and-numbers. A hero photo of a smiling person in this system breaks the whole brand.
