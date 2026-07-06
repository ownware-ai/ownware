---
version: "alpha"
name: "Nexus - Deep focus, unlocked."
description: "Nexus Deep Login Section is designed for authenticating users through a focused access flow. Key features include reusable structure, responsive behavior, and production-ready presentation. It is suitable for authentication screens in web products."
colors:
  primary: "#9CA3AF"
  secondary: "#4ADE80"
  tertiary: "#1F2937"
  neutral: "#FFFFFF"
  background: "#000000"
  surface: "#FFFFFF"
  text-primary: "#6B7280"
  text-secondary: "#FFFFFF"
  border: "#1F2937"
  accent: "#9CA3AF"
typography:
  display-lg:
    fontFamily: "DotGothic16"
    fontSize: "72px"
    fontWeight: 400
    lineHeight: "72px"
    letterSpacing: "-0.05em"
  body-md:
    fontFamily: "JetBrains Mono"
    fontSize: "18px"
    fontWeight: 300
    lineHeight: "28px"
  label-md:
    fontFamily: "JetBrains Mono"
    fontSize: "14px"
    fontWeight: 500
    lineHeight: "20px"
rounded:
  md: "6px"
spacing:
  base: "4px"
  sm: "1px"
  md: "2px"
  lg: "4px"
  xl: "6px"
  gap: "6px"
  card-padding: "9px"
  section-padding: "32px"
components:
  button-primary:
    backgroundColor: "{colors.background}"
    textColor: "{colors.neutral}"
    typography: "{typography.label-md}"
    rounded: "{rounded.md}"
    padding: "10px"
  button-link:
    textColor: "{colors.text-primary}"
    rounded: "0px"
    padding: "0px"
---

## Overview

- **Composition cues:**
  - Layout: Flex
  - Content Width: Bounded
  - Framing: Glassy
  - Grid: Minimal

## Colors

The color system uses light mode with #9CA3AF as the main accent and #FFFFFF as the neutral foundation.

- **Primary (#9CA3AF):** Main accent and emphasis color.
- **Secondary (#4ADE80):** Supporting accent for secondary emphasis.
- **Tertiary (#1F2937):** Reserved accent for supporting contrast moments.
- **Neutral (#FFFFFF):** Neutral foundation for backgrounds, surfaces, and supporting chrome.

- **Usage:** Background: #000000; Surface: #FFFFFF; Text Primary: #6B7280; Text Secondary: #FFFFFF; Border: #1F2937; Accent: #9CA3AF

- **Gradients:** bg-gradient-to-r from-transparent to-transparent via-gray-300, bg-gradient-to-r from-gray-300 to-gray-300 via-gray-400, bg-gradient-to-b from-transparent to-black/10, bg-gradient-to-b from-gray-400 to-gray-800 via-gray-600

## Typography

Typography pairs DotGothic16 for display hierarchy with JetBrains Mono for supporting content and interface copy.

- **Display (`display-lg`):** DotGothic16, 72px, weight 400, line-height 72px, letter-spacing -0.05em.
- **Body (`body-md`):** JetBrains Mono, 18px, weight 300, line-height 28px.
- **Labels (`label-md`):** JetBrains Mono, 14px, weight 500, line-height 20px.

## Layout

Layout follows a flex composition with reusable spacing tokens. Preserve the flex, bounded structural frame before changing ornament or component styling. Use 4px as the base rhythm and let larger gaps step up from that cadence instead of introducing unrelated spacing values.

Treat the page as a flex / bounded composition, and keep that framing stable when adding or remixing sections.

- **Layout type:** Flex
- **Content width:** Bounded
- **Base unit:** 4px
- **Scale:** 1px, 2px, 4px, 6px, 8px, 10px, 12px, 20px
- **Section padding:** 32px, 104px
- **Card padding:** 9px, 22px, 32px
- **Gaps:** 6px, 8px, 12px, 16px

## Elevation & Depth

Depth is communicated through glass, border contrast, and reusable shadow or blur treatments. Keep those recipes consistent across hero panels, cards, and controls so the page reads as one material system.

Surfaces should read as glass first, with borders, shadows, and blur only reinforcing that material choice.

- **Surface style:** Glass
- **Borders:** 1px #1F2937; 1px #FFFFFF
- **Shadows:** rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0.05) 0px 1px 2px 0px; rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(168, 85, 247, 0.6) 0px 0px 15px 0px; rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0.4) 0px 10px 20px -5px, rgba(0, 0, 0, 0.1) 0px 0px 15px 0px
- **Blur:** 12px

### Techniques
- **Gradient border shell:** Use a thin gradient border shell around the main card. Wrap the surface in an outer shell with 1px padding and a 16px radius. Drive the shell with linear-gradient(rgb(156, 163, 175), rgb(75, 85, 99), rgb(31, 41, 55)) so the edge reads like premium depth instead of a flat stroke. Keep the actual stroke understated so the gradient shell remains the hero edge treatment. Inset the real content surface inside the wrapper with a slightly smaller radius so the gradient only appears as a hairline frame.

## Shapes

Shapes rely on a tight radius system anchored by 6px and scaled across cards, buttons, and supporting surfaces. Icon geometry should stay compatible with that soft-to-controlled silhouette.

Use the radius family intentionally: larger surfaces can open up, but controls and badges should stay within the same rounded DNA instead of inventing sharper or pill-only exceptions.

- **Corner radii:** 6px, 8px, 16px, 32px, 9999px
- **Icon treatment:** Linear
- **Icon sets:** Solar

## Components

Anchor interactions to the detected button styles.

### Buttons
- **Primary:** background #000000, text #FFFFFF, radius 6px, padding 10px, border 1px solid rgb(31, 41, 55).
- **Links:** text #6B7280, radius 0px, padding 0px, border 0px solid rgb(229, 231, 235).

### Iconography
- **Treatment:** Linear.
- **Sets:** Solar.

## Do's and Don'ts

Use these constraints to keep future generations aligned with the current system instead of drifting into adjacent styles.

### Do
- Do use the primary palette as the main accent for emphasis and action states.
- Do keep spacing aligned to the detected 4px rhythm.
- Do reuse the Glass surface treatment consistently across cards and controls.
- Do keep corner radii within the detected 6px, 8px, 16px, 32px, 9999px family.

### Don't
- Don't introduce extra accent colors outside the core palette roles unless the page needs a new semantic state.
- Don't mix unrelated shadow or blur recipes that break the current depth system.
- Don't exceed the detected expressive motion intensity without a deliberate reason.

## Motion

Motion feels expressive but remains focused on interface, text, and layout transitions. Timing clusters around 150ms and 1000ms. Easing favors ease and 0. Hover behavior focuses on text and shadow changes. Scroll choreography uses GSAP ScrollTrigger for section reveals and pacing.

**Motion Level:** expressive

**Durations:** 150ms, 1000ms, 300ms

**Easings:** ease, 0, 0.2, 1), cubic-bezier(0.4, cubic-bezier(0

**Hover Patterns:** text, shadow, color, transform

**Scroll Patterns:** gsap-scrolltrigger
