---
name: resume-design
description: Single-page HTML resume artifact, A4 or US Letter, print-clean. Two-column layout, ATS-friendly text, real role bullets, accent-color section rules. Use when the brief is "make me a resume", "redo my CV", "modernize my resume", or "format these notes as a CV". Skip for portfolios with case studies (that's a multi-page artifact) and for LinkedIn-style profiles (different surface).
trigger: /resume-design
---

# Resume Design — single page, ATS-safe, print-clean

## Overview

A resume is read in 30 seconds by a recruiter, then five minutes by the hiring manager, then never again. The discipline: one page (almost always), ATS-parseable as plain text, two-column structure that puts the eye on roles + dates first. This skill ships the resume as a single self-contained HTML file with `@media print` rules so the same artifact previews on screen AND prints as a clean PDF via the browser's print dialog.

For tightening the copy on the bullets themselves, lean on `/copy-refiner`. This skill owns the LAYOUT, the typography, and the print discipline.

---

## Critical Constraints — read these first, every time

1. **Single page. Almost always.** Two pages allowed only for 15+ years of experience or for academic / scientific CVs. Three pages is wrong. If the user has more content than fits, the answer is to cut, not to spill.
2. **Exact page dimensions.** A4 is 210×297mm @ 96 DPI = 794×1123px. US Letter is 8.5×11in @ 96 DPI = 816×1056px. Default to A4 unless the user is US-based or specifies Letter. Set on the `.page` wrapper.
3. **Two-column structure, 30/70 or 35/65.** Left rail (30–35%): name, contact, skills, education, languages, optional photo (regional norm). Right column (65–70%): work experience, projects, publications. This is the standard recruiter scan path.
4. **ATS-safe text — no images for type, no tables for layout, no icons replacing words.** Applicant Tracking Systems strip graphics and parse text. If the email address is in an SVG, the ATS never finds it. CSS grid for layout is fine; `<table>` for layout is not.
5. **Type scale: name 28px, section headers 11px caps tracked +0.06em, job titles 14px medium, body 11px regular, line-height 1.5.** Smaller and the recruiter squints; bigger and you lose the page.
6. **Maximum six bullets per role. Each bullet ≤ 2 lines.** A 12-bullet role is a memory dump, not a resume. The reader skips it.
7. **`@media print` rules included.** Hide screen-only chrome (background grays, hover states), force `print-color-adjust: exact` so the accent color survives, set explicit `@page { size: A4; margin: 0; }`. Without this, the printed PDF has white borders and missing accent rules.

---

## File shape — paste-ready skeleton

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>{Name} — Resume</title>
  <style>
    :root {
      --bg: #f4f4f3;          /* screen-only chrome */
      --paper: #ffffff;
      --fg: #1a1a1a;
      --muted: #6b6b6b;
      --border: #e5e5e5;
      --accent: #1f3a8a;       /* deep navy — a calm professional default */
      --font-display: "Inter", -apple-system, system-ui, sans-serif;
      --font-body: "Inter", -apple-system, system-ui, sans-serif;
      --font-mono: ui-monospace, "JetBrains Mono", Menlo, monospace;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { background: var(--bg); font: 11px/1.5 var(--font-body); color: var(--fg); display: grid; place-items: center; padding: 32px 16px; }
    .page {
      width: 794px;            /* A4 @ 96 DPI */
      min-height: 1123px;
      background: var(--paper);
      box-shadow: 0 8px 32px rgba(0,0,0,0.08);
      display: grid;
      grid-template-columns: 30% 70%;
      column-gap: 28px;
      padding: 48px 44px;
    }
    /* SHARED ----------------------------------------------------------- */
    .section-label {
      font-size: 10px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: var(--accent);
      margin: 24px 0 8px;
      padding-bottom: 4px;
      border-bottom: 1px solid var(--border);
    }
    .section-label:first-child { margin-top: 0; }
    /* LEFT RAIL ------------------------------------------------------- */
    .rail { font-size: 11px; line-height: 1.55; }
    .rail .name {
      font-family: var(--font-display);
      font-size: 28px;
      font-weight: 700;
      letter-spacing: -0.02em;
      line-height: 1.1;
      margin-bottom: 4px;
    }
    .rail .title { font-size: 13px; color: var(--muted); margin-bottom: 20px; }
    .rail .contact-row { margin-bottom: 4px; }
    .rail .contact-row span.k { color: var(--muted); display: inline-block; width: 60px; }
    .rail ul { list-style: none; margin: 0; padding: 0; }
    .rail li { margin-bottom: 4px; }
    .skills li::before { content: "·"; color: var(--accent); margin-right: 6px; }
    /* RIGHT COLUMN --------------------------------------------------- */
    .main { font-size: 11px; line-height: 1.55; }
    .role { margin-bottom: 18px; break-inside: avoid; }
    .role-head {
      display: flex;
      justify-content: space-between;
      align-items: baseline;
      margin-bottom: 2px;
    }
    .role-title { font-size: 14px; font-weight: 600; letter-spacing: -0.01em; }
    .role-dates { font-size: 11px; color: var(--muted); font-variant-numeric: tabular-nums; }
    .role-company { font-size: 12px; color: var(--muted); margin-bottom: 8px; }
    .role-bullets { list-style: none; padding: 0; margin: 0; }
    .role-bullets li {
      position: relative;
      padding-left: 14px;
      margin-bottom: 4px;
    }
    .role-bullets li::before {
      content: "";
      position: absolute;
      left: 0; top: 8px;
      width: 6px; height: 1px;
      background: var(--accent);
    }
    /* PRINT ----------------------------------------------------------- */
    @page { size: A4; margin: 0; }
    @media print {
      body { background: white; padding: 0; }
      .page { box-shadow: none; width: 210mm; min-height: 297mm; padding: 18mm 16mm; }
      * { print-color-adjust: exact; -webkit-print-color-adjust: exact; }
    }
  </style>
</head>
<body>
  <section class="page" data-cx-id="page">
    <aside class="rail" data-cx-id="rail">
      <div class="name">Lena Rivas</div>
      <div class="title">Senior Product Engineer</div>

      <div class="section-label">Contact</div>
      <div class="contact-row"><span class="k">email</span>lena@rivas.dev</div>
      <div class="contact-row"><span class="k">phone</span>+1 (415) 555-0142</div>
      <div class="contact-row"><span class="k">site</span>rivas.dev</div>
      <div class="contact-row"><span class="k">github</span>github.com/lrivas</div>
      <div class="contact-row"><span class="k">city</span>Brooklyn, NY</div>

      <div class="section-label">Skills</div>
      <ul class="skills">
        <li>TypeScript · Node · React</li>
        <li>Postgres · Redis</li>
        <li>AWS · Terraform · GitHub Actions</li>
        <li>System design · API contracts</li>
      </ul>

      <div class="section-label">Education</div>
      <div><strong>BS Computer Science</strong></div>
      <div style="color: var(--muted)">NYU · 2014 — 2018</div>
    </aside>

    <main class="main" data-cx-id="main">
      <div class="section-label">Experience</div>

      <div class="role">
        <div class="role-head">
          <div class="role-title">Senior Engineer</div>
          <div class="role-dates">2022 — Present</div>
        </div>
        <div class="role-company">Stripe · payments platform</div>
        <ul class="role-bullets">
          <li>Owned the merchant-onboarding refactor that cut median time-to-first-charge from 48h to 2h across 14k merchants.</li>
          <li>Designed and shipped the v2 webhook delivery system; reduced peak-hour event lag from 90s to 4s.</li>
          <li>Led a 4-engineer team rebuilding the dispute API; absorbed 6× the prior traffic with same p95 latency.</li>
          <li>Mentored 3 engineers from L3 to L4; one is now a tech lead on the same team.</li>
        </ul>
      </div>

      <div class="role">
        <div class="role-head">
          <div class="role-title">Software Engineer</div>
          <div class="role-dates">2018 — 2022</div>
        </div>
        <div class="role-company">Linear · issue tracking</div>
        <ul class="role-bullets">
          <li>Built the offline sync engine that ships in every Linear client; backed by CRDTs over WebSocket.</li>
          <li>Implemented the cycle-velocity calculation now used by 40k+ teams for sprint planning.</li>
        </ul>
      </div>
    </main>
  </section>
</body>
</html>
```

Two columns, navy accent, six section labels max per side, six bullets max per role. That's the canonical shape.

---

## Bullet writing — the discipline

Every bullet should pass three filters:

1. **Starts with a strong verb.** "Owned." "Designed." "Shipped." "Led." Not "responsible for", not "worked on", not "helped with".
2. **Has a number, ratio, or specific scope.** "Cut median onboarding from 48h to 2h across 14k merchants" beats "improved onboarding speed". If there's no number, the bullet is weaker than its neighbors and is a candidate to cut.
3. **Names the outcome, not the activity.** "Built the offline sync engine that ships in every Linear client" — the outcome is "ships in every client". "Worked on offline sync" is the activity. Always the outcome.

A bullet that fails all three is filler. Cut it. A resume of six tight outcome-bullets reads stronger than a resume of fifteen activity-bullets.

---

## Regional variations

- **United States.** No photo, no date of birth, no marital status. Single page strongly preferred under 10 years experience.
- **United Kingdom / Ireland / Australia.** No photo. Two pages acceptable. "CV" is the term.
- **Germany / Switzerland / Austria.** Photo conventional (top-right of rail), date of birth conventional. "Lebenslauf". Often two pages with a separate cover letter.
- **France / Italy / Spain.** Photo conventional. One or two pages.
- **Japan.** Highly structured `rirekisho` form — this skill is NOT the right surface for that; tell the user to use the standard form.
- **Tech industry, global.** GitHub URL, personal site, optional. No photo (US/UK norms dominate tech hiring globally).

Default to the user's stated geography. If unstated and the role is tech, default to no photo, single page.

---

## Concrete examples

### Example 1 — front-end engineer, 5 years experience, A4

- **Direction:** Modern Minimal token block, navy accent `#1f3a8a`.
- **Page:** 794×1123px, two-column 30/70.
- **Left rail:** Name 28px, title "Senior Front-End Engineer", contact rows (email/phone/site/github/city), skills list (TypeScript, React, CSS architecture, design systems, Storybook), Education (BS, NYU 2014–18), Languages (English native, Spanish conversational).
- **Right column:** Experience (3 roles, 6/4/3 bullets each), Selected projects (2 projects with one-line description), Speaking (1 talk).
- **Print test:** Cmd+P, save as PDF, confirm accent rules render and the layout doesn't break across two pages.

### Example 2 — career-switcher, 2 years in tech after 8 years in a different industry, single page A4

- **Direction:** Editorial Monocle token block, deep burgundy accent `#8b0000` for elegance.
- **Two-column 35/65** to give the rail more room for the longer non-tech background.
- **Left rail:** Name, title "Software Engineer", contact, skills (focus on the new skills), Education, "Previously: 8 years in supply-chain operations" as a single rail block.
- **Right column:** Experience — the two tech roles in full (6 bullets each), then a single condensed "Earlier career" block with two prior roles in 2 bullets each. Each prior bullet emphasizes the transferable system thinking, not the supply-chain content.

That's how a career-switcher gets a single page: most-recent in full, prior compressed, transferable signal across both.

---

## Anti-patterns

- **Two-column layouts built with `<table>` or floats.** ATS parsers can't unwind that. Use CSS Grid (`grid-template-columns: 30% 70%`). All major ATS systems in 2026 handle CSS-rendered text from semantic HTML.
- **Heavy use of icons replacing words.** A phone icon next to a number is fine; an icon replacing the word "Email" or "Skills" is unsafe — the ATS misses the section label.
- **Photos / charts / graphic skill bars.** "JavaScript ████████░░ 80%" is a meme, not a resume. The bar tells the recruiter nothing they can rank. Just list the skill. Or drop the skills list entirely and let the bullets prove it.
- **Three-column layouts.** Cramped. The eye doesn't know where to start. Always two columns or one.
- **Buzzword soup: "passionate", "results-driven", "team player", "synergy", "hands-on".** Cut all of them. The bullets prove the trait; the adjective doesn't.
- **Bullets that span 3+ lines.** Re-write tighter or split into two bullets. A long bullet hides the outcome inside the wording.
- **No `@media print` rules.** The PDF prints with screen-only background gray, no accent color, and gaps. Always include `@page` and `print-color-adjust: exact`.
- **Forgetting to set `width: 794px` on the page wrapper for screen preview.** The preview looks like a full-bleed web page, not a resume; the user can't tell what it'll print like. Lock the dimensions explicitly.
