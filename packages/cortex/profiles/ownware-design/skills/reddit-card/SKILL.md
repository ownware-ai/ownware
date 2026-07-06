---
name: reddit-card
description: 'Reddit-friendly link previews + organic post bodies — 1200×630 link-preview image (Reddit prefers 16:9 OR portrait 1080×1350), no og:type required, plus the post-body markdown rules that perform better than marketing copy on community-native subs. Ships as one HTML preview file + the meta tags + the post-body markdown. Use when the deliverable is "share this on Reddit". Skip for Twitter / X cards — use /twitter-card. Skip for self-promotional formats; Reddit will downvote and / or remove.'
trigger: /reddit-card
---

# Reddit Card — link preview + community-native post body

## Overview

Reddit is two design problems at once. **First**, the link preview that appears when a URL is pasted into a post or comment — Reddit's crawler reads OG tags (with quirks) and caches aggressively. **Second**, the post body itself, which is where the real engagement happens — Reddit users downvote anything that smells like marketing, and the format that actually performs (long-form, first-person, community-aware) is the opposite of every other social card.

This skill covers both. The image side echoes `/twitter-card` (OG meta tags, 1200×630-ish canvas) but with Reddit-specific quirks. The post-body side is unique to Reddit and the part most agents skip.

For Twitter / X cards, use `/twitter-card`. For decks or generic OG images, use `/artifact` directly.

---

## Critical Constraints — read these first, every time

1. **Canvas: 1200×630 (16:9, default) OR 1080×1350 (portrait, mobile-feed friendly).** Reddit's mobile clients render portrait cards much taller in-feed, giving more thumbprint real estate. Use 16:9 by default; switch to portrait when the post is explicitly mobile-first or when the content is long-form text-on-image.
2. **Reddit's crawler caches HARD.** Once it indexes the OG image for a URL, it can hold that cache for hours. There's no manual purge. If you ship a card and discover a typo, you have to wait or post the link to a test subreddit first, let Reddit re-fetch, then move to the target sub.
3. **`og:type` is NOT required.** Reddit ignores it. `og:image`, `og:title`, `og:description`, and `og:url` are the four that matter. Setting `og:type: "article"` doesn't hurt; setting it to something exotic is a waste.
4. **Avoid `twitter:` tags on Reddit-only links.** Reddit reads `og:` exclusively. Twitter tags don't cause harm, but they're noise — keep the meta block focused.
5. **Post-body rule #1: NO marketing voice.** Reddit users smell it instantly. First-person, conversational, no superlatives, no "we're excited to announce", no emoji crown 👑.
6. **Post-body rule #2: lead with the story or the question, not the link.** The link goes near the bottom of the post body, after the context. Self-posts (text posts) that drop a link at the top read as ads and get removed by most subs' auto-mod.
7. **Subreddit fit is the design.** A `r/programming` post that reads great gets removed on `r/SaaS`. The agent must ask which subreddit before designing voice. If unknown, ship the post in a style the user can edit.
8. **Image with NO text-on-image performs better on most subs.** Reddit's image-heavy subs reward clean photography or diagrams; text-overlay cards (Twitter style) often get downvoted as "spam graphic." When the card IS text-led, keep it spare — one line of headline, brand mark, that's it.

---

## Framework — the four-part Reddit delivery

Every Reddit-targeted share gets all four:

1. **The link preview image** — 1200×630 PNG, screenshotted from the HTML preview file.
2. **The OG meta tags** — four lines, paste into parent `<head>`.
3. **The post title** — Reddit's headline. Plain, descriptive, no clickbait. 60–100 chars.
4. **The post body markdown** — Reddit's flavored markdown. First-person, contextual, link near the bottom.

Skipping any of (3) or (4) leaves the user without a launchable post.

---

## Concrete examples — two full patterns

### Example 1 — Open-source release announcement (text-led card + r/programming post body)

The card is spare on purpose — a clean dark frame, the project name, the one-line description, the URL bottom-right.

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Reddit share · Ownware 0.4</title>
  <style>
    body { margin: 0; font-family: -apple-system, system-ui, "Segoe UI", sans-serif; }
    .card {
      width: 1200px; height: 630px;
      background: #0d1117; color: #e6edf3;
      padding: 64px 80px; box-sizing: border-box;
      position: relative;
      display: flex; flex-direction: column; justify-content: space-between;
    }
    .card-tag {
      font-size: 13px; letter-spacing: 0.20em; text-transform: uppercase;
      color: #58a6ff; font-weight: 600;
    }
    .card-title {
      font-size: 60px; font-weight: 700; line-height: 1.05; letter-spacing: -0.015em;
      margin: 16px 0 24px; max-width: 18ch; text-wrap: balance;
    }
    .card-desc {
      font-size: 22px; color: #8b949e; line-height: 1.45; max-width: 42ch; margin: 0;
    }
    .card-footer {
      display: flex; align-items: center; justify-content: space-between;
      font-size: 16px; color: #8b949e;
    }
    .card-brand { display: flex; align-items: center; gap: 10px; color: #e6edf3; }
    .card-brand-mark { width: 24px; height: 24px; background: #58a6ff; border-radius: 5px; transform: rotate(45deg); }
    .card-brand-name { font-weight: 600; }
    .card-url { letter-spacing: 0.08em; }
  </style>
</head>
<body>
  <div class="card" data-cx-id="card">
    <div>
      <div class="card-tag">v0.4 · Release</div>
      <h1 class="card-title">Ownware now runs your agents on your own machine.</h1>
      <p class="card-desc">Local-first. Ownware never sees your data or your keys. MIT-licensed.</p>
    </div>
    <div class="card-footer">
      <div class="card-brand">
        <span class="card-brand-mark"></span>
        <span class="card-brand-name">Ownware</span>
      </div>
      <span class="card-url">github.com/ownware/ownware</span>
    </div>
  </div>
</body>
</html>
```

The matching meta-tag block (four lines, the only four that matter on Reddit):

```html
<meta property="og:title"       content="Ownware 0.4 — local-first agent OS now stable" />
<meta property="og:description" content="Your keys stay encrypted on your machine — Ownware never sees them. MIT-licensed. v0.4 is what we use ourselves." />
<meta property="og:image"       content="https://ownware.so/share/v0.4.png" />
<meta property="og:url"         content="https://github.com/ownware/ownware" />
```

And the post body markdown — this is the part agents usually skip. Title and body for `r/programming`:

```markdown
**Title:** I shipped v0.4 of a local-first agent runtime I've been working on for 6 months — happy to answer questions

**Body:**

Started this because I got tired of agents that route my Gmail through somebody else's servers. Ownware is an OS for AI agents that runs entirely on your machine — Electron desktop today, your own Vercel project tomorrow. Zero data on our servers. No centralized OAuth.

What v0.4 actually does:

- Wraps any LLM you have an API key for (Anthropic, OpenAI, OpenRouter, local Ollama).
- Manages credentials in your OS keychain — never plaintext.
- Lets you give an agent a real shell on your own filesystem (gated by permission prompts).
- Streams everything through a typed SSE gateway you can also consume from a mobile client.

Stuff that's still rough: the design product (HTML artifact generator) is in flux. Connector OAuth flows for Slack and Notion are working but the UX needs another pass.

Repo: https://github.com/ownware/ownware

Happy to answer questions on architecture choices, why I went Electron instead of CLI, or anything else.
```

That post body is the design. First-person, names real limitations, no emoji, no "we're excited", link near the bottom after context, ends with an invitation. That's what passes the Reddit smell test on developer subs.

### Example 2 — Portrait image card for r/SideProject (1080×1350)

When the post is mobile-led — a side project showcase, a "look what I made" — switch to portrait. The card has more vertical real estate; use it for two stacked elements.

```html
<style>
  .card-portrait {
    width: 1080px; height: 1350px;
    background: linear-gradient(180deg, #0d1117 0%, #1a2233 100%);
    color: #e6edf3; padding: 80px 80px; box-sizing: border-box;
    display: flex; flex-direction: column; justify-content: center; gap: 48px;
    font-family: -apple-system, system-ui, sans-serif; position: relative;
  }
  .card-portrait-shot {
    width: 100%; height: 580px;
    background: linear-gradient(135deg, #1a2233 0%, #58a6ff 100%);
    border-radius: 14px;
    /* In a real ship, replace with <img src="/screenshot.png" /> at 1024×580. */
  }
  .card-portrait-h1 { font-size: 72px; font-weight: 700; line-height: 1.05; letter-spacing: -0.02em;
                      margin: 0; max-width: 20ch; text-wrap: balance; }
  .card-portrait-desc { font-size: 26px; color: #8b949e; line-height: 1.4; margin: 0; }
  .card-portrait-brand { position: absolute; bottom: 60px; left: 80px; font-size: 18px; color: #8b949e; }
</style>
<div class="card-portrait" data-cx-id="card">
  <div class="card-portrait-shot"></div>
  <h1 class="card-portrait-h1">A note-taking app that respects the keyboard.</h1>
  <p class="card-portrait-desc">No mouse menus. Markdown in, Markdown out. ~2MB binary, runs offline.</p>
  <div class="card-portrait-brand">made by @alex · open source · keysnote.app</div>
</div>
```

Post body for `r/SideProject` — even lighter on marketing, more emphasis on "I made this" and the build story:

```markdown
**Title:** Made a keyboard-first markdown editor after I got fed up clicking through menus all day

**Body:**

Solo project, ~3 months on weekends. The pitch: every action in the editor is a keystroke. No mouse menus. Markdown source, markdown output, no proprietary file format.

Stack: Electron (yes I know), Codemirror 6, ~2MB binary, runs fully offline. Settings live in a TOML file you can edit.

Why not just use VS Code: I wanted something that opens in 80ms and forgets I exist between sessions. VS Code is great but it has 47 menus.

Open source: https://github.com/alex/keysnote

Demo (download Mac + Linux): https://keysnote.app

Genuine feedback welcome — what's the smallest annoyance that would make you not use this?
```

The closing question is the design — it invites comments instead of upvotes, which is how `r/SideProject` ranks. Without that question, the post reads as an announcement; with it, it reads as a conversation.

---

## Anti-patterns

- **Designing only the image.** Stop. Reddit shipping = image + meta tags + post title + post body. Four parts. Skipping the body leaves the user holding an empty Reddit post.
- **Marketing voice in the body.** Stop. "We're excited to announce" / "introducing" / "the future of" / emoji headers — all get downvoted on developer and side-project subs. First-person, plain.
- **Link at the top of the body.** Stop. Self-promotion auto-mod removes those. Link goes near the bottom after context.
- **Setting `twitter:card` for a Reddit-only share.** Stop. Noise. Use `og:` only.
- **Re-uploading the image after a typo without testing on a throwaway sub.** Stop. Reddit's cache holds for hours. Test on a personal sub first, let Reddit fetch, then post to the target subreddit.
- **Text-heavy graphic for image-heavy subs (`r/Art`, `r/dataisbeautiful`).** Stop. Those subs reward the visual itself, not graphic-design overlays. Match the sub's culture.
- **Not knowing the subreddit before designing.** Stop. `r/programming` voice ≠ `r/marketing` voice ≠ `r/AskReddit` voice. If unknown, ask the user or build in the neutral-developer style and flag the assumption.
- **`og:image` at the wrong aspect ratio.** Stop. Use 1200×630 (16:9) OR 1080×1350 (4:5 portrait). Square 1080×1080 looks broken in Reddit's feed.
- **Forgetting `og:url`.** Stop. Without it, Reddit may attach the card to the wrong destination on share.
