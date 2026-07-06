---
name: chat-ui-design
description: 'Chat composer, message bubble, inline tool-call rendering, streaming caret, empty chat state — the five components that make an AI or 1:1 chat surface readable. META skill: Ownware ITSELF is a chat interface, so the agent has unique insight from designing what it lives inside. Use for any chat surface — AI assistant, support widget, team-chat panel. Pairs with /artifact and /copy-refiner. Skip for email (use /email-design).'
trigger: /chat-ui-design
---

# Chat UI Design — composer, bubble, tool-call, caret, empty

## Overview

Chat UIs look easy and are full of small wrong defaults: send-on-Enter that traps newlines, a "thinking..." spinner that never resolves, a "Hello, I'm Atlas!" greeting that nobody asked for, a gradient mesh background imported from a Lottie file. Every one of those is a tell that the team copied the surface from a screenshot, not designed it.

This skill catalogues the five components a chat UI is made of and the canonical shape for each. It's also the meta-skill: Ownware itself runs inside a chat interface, and the Designer agent should know its own anatomy. Pairs with `/artifact` (file structure) and `/copy-refiner` (bubble copy density).

---

## Critical Constraints — read these first, every time

1. **Composer min-height 44px.** Below that you've lost the touch target on mobile and the visual weight on desktop. Single-line is 44px; auto-expand up to ~200px on wrap; scroll past that.
2. **Enter sends. Shift+Enter inserts a newline.** This is the convention every messaging app shares — Slack, iMessage, Discord, WhatsApp Web, Linear. Deviating costs the user a relearning curve they didn't ask for. The one exception: composer in a documentation form where Enter would interrupt prose — there, Cmd+Enter sends.
3. **Bubble max-width 65ch.** Lines wider than 65ch lose return-sweep accuracy. 65ch ≈ 680px at 16px. Names + timestamps live outside the bubble, not in it.
4. **Streaming caret 8–12 chars/sec.** Eye reads at roughly that rate. Faster looks like a buffer dump; slower wastes the user's time and reads as performative slowness. Token-by-token from an LLM is already in this range — pass it through, don't add artificial delay.
5. **No fake greeting on empty.** Per Ownware's RULES.md: an empty chat is blank, not "Hello, I'm X, how can I help today?" The first message comes from the user. The agent introduces itself by responding.
6. **Tool-call renders inline, not in a sidebar.** Web-search results, file-reads, citations — they belong inside the message stream where they were generated, anchored to the agent turn that called them. A separate "tool runs" panel forces context-switching.

---

## Component 1 — Composer

The input bar at the bottom. Five affordances, in this order: text input, attach (paperclip or `+`), formatting (optional, bold/italic/code), submit button, and a status indicator (streaming, queued, idle).

```html
<form class="composer" data-cx-id="composer">
  <button class="attach" type="button" aria-label="Attach file">+</button>
  <textarea
    name="message"
    placeholder="Send a message…"
    rows="1"
    aria-label="Message"
    style="min-height:44px; max-height:200px; resize:none;"></textarea>
  <button class="send" type="submit" aria-label="Send">→</button>
</form>
```

```css
.composer {
  display: flex; gap: 8px; align-items: end;
  padding: 8px 12px;
  background: var(--surface); border: 1px solid var(--border);
  border-radius: 14px;
}
.composer textarea {
  flex: 1; border: 0; background: transparent; color: var(--fg);
  font: 15px/1.5 var(--font-body); padding: 10px 4px;
  outline: none;
}
.composer .send {
  width: 36px; height: 36px; border-radius: 999px;
  background: var(--accent); color: var(--accent-fg); border: 0;
  display: grid; place-items: center;
  cursor: pointer; transition: opacity 0.15s;
}
.composer .send:disabled { opacity: 0.4; cursor: not-allowed; }
```

Paste-image inline: hook `onpaste` on the textarea, detect `clipboardData.files`, insert a preview chip above the textarea, attach the file to the next submit.

### Composer keyboard contract

| Key                | Action                                |
| ------------------ | ------------------------------------- |
| Enter              | Submit (if not empty)                 |
| Shift+Enter        | Insert newline                        |
| Cmd/Ctrl+Enter     | Submit (alt path, works mid-line)     |
| ArrowUp (when empty) | Edit last own message               |
| Escape (mid-edit)  | Cancel edit                           |
| Tab                | Move focus to next interactive element|

---

## Component 2 — Message bubble

```html
<div class="msg msg-user" data-cx-id="msg">
  <div class="bubble">What's the latest on the integration?</div>
  <div class="meta">9:42 AM</div>
</div>

<div class="msg msg-agent">
  <div class="avatar">A</div>
  <div class="bubble">
    Here's the current status — three open PRs, one merged this morning.
  </div>
  <div class="meta">9:42 AM</div>
</div>
```

```css
.msg { display: grid; gap: 4px; margin: 12px 0; max-width: 65ch; }
.msg-user  { justify-self: end; text-align: right; }
.msg-agent { justify-self: start; grid-template-columns: 32px 1fr; gap: 8px; }
.msg .bubble {
  padding: 10px 14px; border-radius: 14px;
  font: 15px/1.55 var(--font-body); text-wrap: pretty;
}
.msg-user .bubble  { background: var(--accent); color: var(--accent-fg); }
.msg-agent .bubble { background: var(--surface-2); color: var(--fg); }
.msg .meta { font-size: 12px; color: var(--muted); }
.msg .meta { opacity: 0; transition: opacity 0.15s; }
.msg:hover .meta { opacity: 1; }   /* timestamp on hover */
.msg .avatar {
  width: 32px; height: 32px; border-radius: 50%;
  background: var(--accent); color: var(--accent-fg);
  display: grid; place-items: center; font-weight: 600; font-size: 13px;
}
```

User bubble right-aligned and accent-coloured; agent bubble left-aligned with an avatar and a neutral surface. Timestamps appear on hover, not always — they clutter the read pass.

---

## Component 3 — Inline tool-call rendering (the cite-chip pattern)

When the agent calls a tool mid-response (web search, file read, calculator), the result renders inline as a "cite chip" — a compact, expandable affordance anchored to the sentence that referenced it.

```html
<div class="msg msg-agent">
  <div class="avatar">A</div>
  <div class="bubble">
    Cambridge's population is roughly
    <a class="cite-chip" data-cx-id="cite-1" href="#cite-1" aria-label="Source: Cambridge City Council 2024">
      145,700<sup>1</sup>
    </a>.
    Most of that growth is post-pandemic.
  </div>
</div>

<details class="tool-call" id="cite-1" data-cx-id="tool-call">
  <summary>web_search — "Cambridge UK population 2024"</summary>
  <div class="tool-result">
    <div class="result-source">Cambridge City Council · 2024</div>
    <blockquote>The estimated population of Cambridge city is 145,700 as of mid-2023.</blockquote>
  </div>
</details>
```

```css
.cite-chip {
  display: inline-flex; align-items: baseline; gap: 2px;
  padding: 0 4px; border-radius: 4px;
  background: var(--surface-2); color: var(--fg);
  text-decoration: none; font-weight: 500;
  border-bottom: 1px dotted var(--muted);
}
.cite-chip sup { font-size: 10px; color: var(--accent); margin-left: 2px; }
.tool-call {
  margin: 8px 0; padding: 10px 14px;
  background: var(--surface-2); border-left: 3px solid var(--accent);
  border-radius: 0 8px 8px 0; font-size: 13px;
}
.tool-call summary { cursor: pointer; color: var(--muted); font-family: var(--font-mono); }
```

The chip is small and inline; the full result is collapsible underneath. The user reads the prose; if they want the citation, they click. The agent never has to flush to a sidebar.

---

## Component 4 — Streaming caret

```css
.streaming::after {
  content: "▍"; display: inline-block; margin-left: 2px;
  color: var(--accent);
  animation: caret 1.1s steps(2) infinite;
}
@keyframes caret { 50% { opacity: 0; } }
```

Add `.streaming` to the in-progress bubble; remove it on stream end. Pacing comes from the token stream itself — don't slice and re-emit at fixed intervals. Eye reads at 8–12 chars/sec; LLM token streams are already close to that range.

If the stream is genuinely fast (large code blocks, JSON dumps), DO NOT throttle to look "natural." Throttling is performative — the user paid for the speed.

---

## Component 5 — Empty chat state

No greeting. No "Hi, I'm Atlas!". No three suggested prompts in glass-card buttons unless they're genuinely useful for the user's product (see RULES.md). The clean empty:

```html
<section class="empty-chat" data-cx-id="empty-chat">
  <!-- Optional: a single faint icon, 80px max, in --muted -->
  <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor"
       stroke-width="1" style="opacity:0.3; color:var(--muted);">
    <path d="M3 12c0-5 4-9 9-9s9 4 9 9-4 9-9 9c-2 0-4-1-5-2L3 21l1-4z"/>
  </svg>
</section>
```

That's the whole empty state. The composer is below. The user types. The conversation starts.

If your product genuinely benefits from suggested prompts (a research agent, a code assistant), show 2–3 as plain text links beneath the icon — not in heavy buttons. "Summarize a PDF" / "Find a function in my repo" / "Plan a trip to Lisbon".

---

## AI chat tropes to avoid

These are the patterns that mark a chat UI as "shipped by someone who hasn't lived inside one":

- **Glass-card bubbles with backdrop-blur.** Reads as decoration; costs paint performance on long threads.
- **Generic robot avatar.** Use a wordmark, a first letter, or a flat shape. Robots have been a UI cliché since the 1990s.
- **"Thinking..." with three bouncing dots that never resolve.** Either show a typing indicator with a known timeout, or stream the actual response. The infinite spinner is the spiritual cousin of the loading screen that never finishes.
- **Gradient mesh background imported from Lottie.** The user is reading text. The background should disappear.
- **Hero illustration on first open.** The first thing a chat user wants is to type. A 400px tall hero asking them to "say hi" is a wall in front of the value.
- **Auto-suggested follow-ups as 8 large pill buttons.** 2–3 is the ceiling. Anything more reads as "we don't know what to offer you, here is everything."

---

## Concrete examples

### Example 1 — a 1:1 chat UI, generic but Ownware-flavoured

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8"><title>Atlas Chat</title>
  <style>
    :root {
      --bg:#fafafa; --surface:#ffffff; --surface-2:#f1f1f0;
      --fg:#111; --muted:#6b6b6b; --border:#e5e5e5;
      --accent:#2f6feb; --accent-fg:#fff;
      --font-body:-apple-system,system-ui,sans-serif;
      --font-mono:ui-monospace,Menlo,monospace;
    }
    *,*::before,*::after { box-sizing: border-box; }
    body {
      margin:0; background:var(--bg); color:var(--fg);
      font:15px/1.55 var(--font-body);
      display:grid; grid-template-rows:1fr auto; height:100vh;
    }
    .thread {
      max-width:760px; margin:0 auto; padding:24px 16px;
      width:100%; overflow-y:auto;
    }
    .msg { display:grid; gap:4px; margin:14px 0; max-width:65ch; }
    .msg-user  { justify-self:end; }
    .msg-agent { justify-self:start; grid-template-columns:32px 1fr; gap:8px; }
    .bubble { padding:10px 14px; border-radius:14px; text-wrap:pretty; }
    .msg-user .bubble  { background:var(--accent); color:var(--accent-fg); border-radius:14px 14px 4px 14px; }
    .msg-agent .bubble { background:var(--surface-2); }
    .avatar { width:32px; height:32px; border-radius:50%; background:var(--accent); color:#fff;
              display:grid; place-items:center; font-weight:600; font-size:13px; }
    .cite-chip { display:inline-flex; padding:0 4px; border-radius:4px;
                 background:#e8eefc; color:#1a4cb8; text-decoration:none;
                 border-bottom:1px dotted #1a4cb8; }
    .cite-chip sup { font-size:10px; margin-left:2px; }
    .streaming::after { content:"▍"; color:var(--accent); animation:caret 1.1s steps(2) infinite; }
    @keyframes caret { 50% { opacity:0; } }
    .composer-wrap { padding:12px 16px 16px; background:linear-gradient(to top, var(--bg) 70%, transparent); }
    .composer { max-width:760px; margin:0 auto; display:flex; gap:8px; align-items:end;
                padding:8px 12px; background:var(--surface); border:1px solid var(--border); border-radius:14px; }
    .composer textarea { flex:1; border:0; background:transparent; color:var(--fg);
                         font:inherit; padding:10px 4px; outline:none; resize:none;
                         min-height:44px; max-height:200px; }
    .composer button.send { width:36px; height:36px; border-radius:999px;
                            background:var(--accent); color:var(--accent-fg); border:0;
                            display:grid; place-items:center; cursor:pointer; font-size:18px; }
  </style>
</head>
<body>
  <main class="thread" data-cx-id="thread">
    <div class="msg msg-user">
      <div class="bubble">What's the latest on Cambridge's population?</div>
    </div>
    <div class="msg msg-agent">
      <div class="avatar">A</div>
      <div class="bubble streaming">
        Cambridge's population is roughly
        <a class="cite-chip" href="#cite-1">145,700<sup>1</sup></a>
        — most of the recent growth is post-pandemic, with the biotech corridor
      </div>
    </div>
  </main>

  <div class="composer-wrap">
    <form class="composer" data-cx-id="composer">
      <textarea rows="1" placeholder="Send a message…" aria-label="Message"></textarea>
      <button class="send" type="submit" aria-label="Send">→</button>
    </form>
  </div>
</body>
</html>
```

Clean canvas, real bubble pair, real cite-chip in the agent reply, streaming caret on the in-progress bubble, real composer with the right keyboard contract.

### Example 2 — the wrong way, annotated

```html
<!-- DON'T SHIP THIS -->
<div class="hero-greeting" style="text-align:center; padding:80px;">
  <img src="/robot-mascot.svg" width="200">
  <h1>Hi, I'm Atlas! 👋</h1>
  <p>How can I help you today?</p>
  <div class="suggestions">
    <button class="suggestion-card glass">📊 Analyze data</button>
    <button class="suggestion-card glass">✍️ Write a draft</button>
    <button class="suggestion-card glass">🔍 Research a topic</button>
    <button class="suggestion-card glass">🎯 Brainstorm ideas</button>
    <button class="suggestion-card glass">📅 Plan an event</button>
    <button class="suggestion-card glass">🐛 Debug code</button>
  </div>
</div>
```

What's wrong: greeting the user has not asked for, 200px robot mascot, six glass-card suggestions (ceiling is 3, and they should be plain links), emoji prefixes on every label. The user wanted to type a message; they got a homepage.

---

## Anti-patterns

- **Three-dot "thinking" indicator with no timeout.** Stop. Stream the response, or show "still working — N seconds" with a cancel button. An indicator that never resolves is a broken contract.
- **Hero greeting on every open.** Stop. The user just opened the chat to type something. Make space for that, not for a mascot.
- **Glass-card backdrop-blur bubbles.** Stop. Solid surface, real contrast. Backdrop-blur kills paint performance once the thread is 100+ messages.
- **Send-on-Enter without Shift+Enter newline.** Stop. Multi-line messages are normal; trapping them costs the user.
- **Tool calls in a sidebar.** Stop. Inline cite-chips. The user reads the prose; the sidebar splits attention.
- **Auto-suggested follow-ups as 6+ buttons.** Stop. Cap at 3, render as text links not heavy buttons.
- **Slowing the stream to look "natural."** Stop. The token rate is already the right rate; throttling reads as performative.
