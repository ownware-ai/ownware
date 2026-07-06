---
name: release-notes
description: 'Single-page HTML release notes for a software product. Hero with version + date + one-sentence summary, then grouped sections (Added / Improved / Fixed / Deprecated / Breaking). One-line entries with at most three lines of context. Total body under 500 words. Use when the brief is "release notes", "changelog", "what''s new", "version update". Skip for long-form announcements (use article-layout) or marketing landing pages (use artifact + web-guidelines).'
trigger: /release-notes
---

# Release Notes — one page, five sections, under 500 words

## Overview

A release notes page exists for one reader: the engineer or admin who needs to know what changed before they upgrade. They are scanning, not reading. This skill is the recipe for a single self-contained HTML page that respects that scanning behavior — a hero with version + date + one-line summary, then five grouped sections (Added, Improved, Fixed, Deprecated, Breaking), each entry a single line with ≤3 lines of context underneath.

File shape: same as `artifact` (one HTML, `:root` tokens, `data-cx-id` regions). The discipline below is what stops release notes turning into a marketing page or a blog post — neither of which the scanner-reader wants.

If the brief is a long-form announcement ("we shipped X, here's the journey"), that's `/article-layout`, not this one.

---

## Critical Constraints — read these first, every time

1. **Total body copy under 500 words.** Count includes section headings and entry context. If you're over 500, you're writing a blog post — extract the narrative to a separate post and link to it from the summary.
2. **Five sections, in this order:** Added, Improved, Fixed, Deprecated, Breaking. Skip a section if empty — don't print "Added: nothing." If everything is empty except Fixed, ship a one-section page.
3. **Each entry is one line.** The line is the change, in past tense, lowercase verb, present-tense impact. "Added bulk-edit shortcut to the table view — select rows with shift-click, edit with `e`." If the line wraps past two visual lines on desktop, it's too long.
4. **Context paragraph is optional and capped at three lines.** Use it only when the change has a footgun (migration step, behavior change, deprecation timeline). Most entries don't earn one.
5. **Breaking changes get a migration block.** Every breaking entry must include the migration step inline — what to grep for, what to change, before-after code if the swap is non-obvious. If you can't write the migration in three lines, the change needs its own doc; link to it.
6. **Version + date in the hero, both required.** `v2.3.1 · February 14, 2026`. Never `v2.3.1 · TBD` — if the date isn't known, the notes aren't ready to ship.
7. **No marketing voice.** "We're thrilled to announce" / "delighted" / "excited" — cut. The reader is here for a delta, not for your feelings.

---

## The structural sections

Top to bottom:

1. **`data-cx-id="hero"`** — version badge, release date, one-sentence summary of the release's theme ("performance pass" / "billing system rewrite" / "monthly maintenance"). 1–2 lines max.
2. **`data-cx-id="added"`** — net-new features and surfaces.
3. **`data-cx-id="improved"`** — existing features made better (faster, clearer, fewer clicks).
4. **`data-cx-id="fixed"`** — bug fixes. Most entries live here.
5. **`data-cx-id="deprecated"`** — features still working but scheduled for removal. Each entry names the removal version.
6. **`data-cx-id="breaking"`** — features removed or contract-changed in this release. Every entry has a migration block.
7. **`data-cx-id="upgrade"`** — short list of actions the operator must take. If none, write `No upgrade actions required.` Don't omit the section — its presence is a signal.
8. **`data-cx-id="footer"`** — link to full changelog, previous version, support. One line, muted.

---

## Entry shape — the rubric

Every entry follows the same pattern:

```html
<li class="entry">
  <span class="entry-tag">UI</span>
  <span class="entry-line">Added bulk-edit shortcut to the table view — select rows with shift-click, edit with <code>e</code>.</span>
  <p class="entry-context">First action edits the focused column; subsequent edits apply to the same column until escape. Skips read-only columns.</p>
</li>
```

- **Tag** — 2–4 letter scope (UI, API, CLI, DB, AUTH, BILLING). Pick one. Don't tag every entry; tag entries that span multiple surfaces or that one reader-class cares about more.
- **Line** — single sentence, past-tense verb, ends with a period.
- **Context** — optional `<p>`, three lines max, present-tense, names the footgun.

---

## Concrete examples

### Example 1 — worked: a real-shaped v2.3.1 release for a fictional product

Product is "Mole", a CLI/dashboard for self-hosted database backups. Version 2.3.1, theme: "billing rewrite + scheduler fixes." Body under 500 words.

```html
<section data-cx-id="hero">
  <span class="version">v2.3.1</span>
  <time>February 14, 2026</time>
  <h1>Billing rewrite, scheduler fixes</h1>
  <p>The billing engine moved to per-minute metering; the scheduler stopped double-firing on DST transitions. One breaking change on the <code>backups list</code> output format.</p>
</section>

<section data-cx-id="added">
  <h2>Added</h2>
  <ul>
    <li class="entry">
      <span class="entry-tag">BILLING</span>
      <span class="entry-line">Per-minute metering with a 5-minute minimum charge.</span>
      <p class="entry-context">Bills now include a per-backup line item with start, duration, and the metered rate. Old hourly bills remain visible under <a>Billing → History</a>.</p>
    </li>
    <li class="entry">
      <span class="entry-tag">CLI</span>
      <span class="entry-line">Added <code>mole backups tail</code> to stream live backup progress to the terminal.</span>
    </li>
  </ul>
</section>

<section data-cx-id="improved">
  <h2>Improved</h2>
  <ul>
    <li class="entry"><span class="entry-line">Dashboard initial paint is 2.3× faster on warm cache (1.1s → 480ms median).</span></li>
    <li class="entry"><span class="entry-line">Scheduler now logs the resolved cron expression alongside the next-run time.</span></li>
  </ul>
</section>

<section data-cx-id="fixed">
  <h2>Fixed</h2>
  <ul>
    <li class="entry"><span class="entry-line">Scheduler fired twice on DST spring-forward in zones with a 02:00 rule.</span></li>
    <li class="entry"><span class="entry-line">Restore from S3-compatible providers (Backblaze B2, Wasabi) failed when the bucket name contained a period.</span></li>
    <li class="entry"><span class="entry-line">CLI <code>--json</code> output included a trailing newline that broke piped <code>jq</code> consumers.</span></li>
  </ul>
</section>

<section data-cx-id="deprecated">
  <h2>Deprecated</h2>
  <ul>
    <li class="entry">
      <span class="entry-line">The <code>--legacy-paths</code> flag is deprecated and will be removed in v2.5.</span>
      <p class="entry-context">If your scripts pass <code>--legacy-paths</code>, drop it and let Mole auto-detect. The migration is a no-op for installs created after v2.0.</p>
    </li>
  </ul>
</section>

<section data-cx-id="breaking">
  <h2>Breaking</h2>
  <ul>
    <li class="entry">
      <span class="entry-line"><code>mole backups list --json</code> emits an array, not an NDJSON stream.</span>
      <p class="entry-context">Migration: pipe through <code>jq -c '.[]'</code> if your downstream tooling expects one object per line. Plain (non-JSON) output is unchanged.</p>
    </li>
  </ul>
</section>

<section data-cx-id="upgrade">
  <h2>Upgrade</h2>
  <p>Run <code>mole upgrade</code> as usual. Existing billing data migrates automatically on first start; expect a 10–30s pause at version bump. No DB migration is required.</p>
</section>
```

Word count: ~340. Five sections present, deprecated and breaking each have one entry with context. Upgrade section names the one operator action.

### Example 2 — minimal patch release (Fixed-only)

For a 2.3.2 patch that only fixes bugs, ship one-section notes. Hero, then `<section data-cx-id="fixed">` with 3–6 entries, then upgrade block reading "No upgrade actions required." Don't print empty Added/Improved/Deprecated/Breaking sections — their absence is the signal that this is a patch.

### Example 3 — token block for the page

```css
:root {
  --bg: #fafafa;
  --surface: #ffffff;
  --fg: #111111;
  --muted: #6b6b6b;
  --border: #e5e5e5;
  --accent: #2f6feb;
  --good: #17a34a;
  --warn: #eab308;
  --bad: #dc2626;
  --radius: 8px;
  --font-display: "Inter", -apple-system, system-ui, sans-serif;
  --font-body: "Inter", -apple-system, system-ui, sans-serif;
  --font-mono: ui-monospace, "JetBrains Mono", Menlo, monospace;
}
.entry-tag {
  display: inline-block; padding: 2px 8px; margin-right: 8px;
  font: 600 11px/1 var(--font-mono); letter-spacing: 0.06em; text-transform: uppercase;
  border: 1px solid var(--border); border-radius: var(--radius); color: var(--muted);
}
.entry-context { font-size: 14px; color: var(--muted); margin: 6px 0 0 0; line-height: 1.55; }
[data-cx-id="breaking"] .entry-tag { color: var(--bad); border-color: var(--bad); }
[data-cx-id="deprecated"] .entry-tag { color: var(--warn); border-color: var(--warn); }
```

Restrained palette, mono tags, color only on breaking and deprecated tags.

---

## Anti-patterns

- **Marketing voice in release notes.** Stop. "We're thrilled to ship per-minute metering" — cut "thrilled", lead with the change. The reader didn't open this page to feel emotion.
- **A single section called "Changes" with everything mixed in.** Stop. Added vs. Improved vs. Fixed vs. Breaking serve four different reader actions — separate them.
- **Breaking change without a migration block.** Stop. Every breaking entry includes the migration step inline. If the migration is too long for three lines, link to a dedicated migration doc.
- **Version with no date, or "TBD" date.** Stop. If the date isn't known, the notes aren't ready. Hold the page until both fields are real.
- **Hero photo, marketing imagery, illustration.** Stop. Release notes are a text page. The reader scans; chrome eats scan time.
- **More than 500 words.** Stop. If you're at 700, two-thirds of your text is narrative. Extract the narrative to a blog post; keep the notes as a delta.
