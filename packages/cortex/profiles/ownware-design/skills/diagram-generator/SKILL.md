---
name: diagram-generator
description: Produce hand-drawn-style diagrams — architecture, flowcharts, sequence, state machines — as an Excalidraw JSON file the user opens in excalidraw.com, OR as a single self-contained HTML file embedding the diagram as inline SVG. Use when the user asks for a diagram, flow, system map, sequence, "draw me a…", or whiteboard sketch. Do NOT use for production charts (KPI dashboards) — that's `report-builder`. Do NOT use for branded illustrations — out of scope.
trigger: /diagram-generator
---

# Diagram Generator — hand-drawn diagrams as JSON or inline SVG

## Overview

The Designer ships two diagram shapes: an **Excalidraw JSON** file (`writeFile` produces `diagram.excalidraw` — the user double-clicks or drags into excalidraw.com to edit further) and an **HTML+SVG** single file (drop-in for embedding in an artifact, no external dependency). Pick one path per turn; do not mix. The choice is made before writing.

Hand-drawn aesthetic comes from: rough-edged strokes, slight rotation jitter on shapes, monospace or hand-style font labels, off-black ink, off-white paper. It is NOT cartoony — restrained, technical, the Excalidraw look.

---

## Critical Constraints — read these first

1. **Pick ONE output path per turn.** Either `diagram.excalidraw` (JSON) OR `diagram.html` (inline SVG). Mixing the two doubles maintenance and confuses the user.
2. **Max 7 primary nodes per diagram.** Anything beyond 7 must split into a second diagram (`diagram-overview.excalidraw` + `diagram-detail-auth.excalidraw`). A 12-node spider trap is unreadable — write two clear diagrams, not one busy one.
3. **One layout direction.** Left-to-right OR top-to-bottom. Never mix. Sequence diagrams = top-to-bottom (time flows down). Architecture = left-to-right (request flows right). State machines = either, pick once.
4. **Every arrow has a label OR is obvious.** Unlabeled arrows in a 5+ node diagram make the reader guess. Label is 1-3 words ("HTTP", "publishes", "fails"). Empty label is allowed only when the relationship is structural (e.g. "contains").
5. **Labels go INSIDE shapes, not next to them.** Excalidraw `containerId` binds text to shape. HTML+SVG: text element centered inside the rect with `text-anchor: middle, dominant-baseline: middle`.
6. **No emoji, no icons inline.** This is a structural diagram, not a brand asset. Text labels only. If the user wants icons, that is a `prompt-designer` artifact, not a diagram.
7. **Color is semantic, not decorative.** Default ink = `#1a1a1a` on paper `#fafaf7`. Use ONE accent (typically `#c92a2a` red for "error path" or `#2f6feb` blue for "active") and only when the diagram has a story beat. Three-color rainbow diagrams scream "I tried."

---

## Excalidraw JSON shape (the workhorse path)

Excalidraw reads a JSON file with this exact top-level shape. The user opens excalidraw.com, drags the file in, edits further if they want.

```json
{
  "type": "excalidraw",
  "version": 2,
  "source": "https://excalidraw.com",
  "elements": [
    {
      "id": "node-api",
      "type": "rectangle",
      "x": 100,
      "y": 100,
      "width": 200,
      "height": 80,
      "strokeColor": "#1a1a1a",
      "backgroundColor": "#ffffff",
      "fillStyle": "solid",
      "strokeWidth": 2,
      "strokeStyle": "solid",
      "roughness": 1,
      "roundness": { "type": 3 },
      "boundElements": [{ "type": "text", "id": "label-api" }]
    },
    {
      "id": "label-api",
      "type": "text",
      "x": 130,
      "y": 130,
      "width": 140,
      "height": 25,
      "text": "API Gateway",
      "fontSize": 20,
      "fontFamily": 1,
      "textAlign": "center",
      "verticalAlign": "middle",
      "containerId": "node-api"
    },
    {
      "id": "arrow-api-to-worker",
      "type": "arrow",
      "x": 300,
      "y": 140,
      "width": 200,
      "height": 0,
      "points": [[0, 0], [200, 0]],
      "startBinding": { "elementId": "node-api", "focus": 0, "gap": 1 },
      "endBinding":   { "elementId": "node-worker", "focus": 0, "gap": 1 },
      "endArrowhead": "arrow",
      "strokeColor": "#1a1a1a",
      "strokeWidth": 2,
      "roughness": 1
    }
  ],
  "appState": {
    "viewBackgroundColor": "#fafaf7",
    "gridSize": null
  },
  "files": {}
}
```

Field cheat sheet (memorize):

- `roughness: 1` — the hand-drawn feel. `0` = clean (don't use for this skill), `2` = cartoonish (don't use either).
- `fontFamily: 1` — Virgil (Excalidraw's hand-drawn). `2` = Helvetica (clean), `3` = Cascadia (mono).
- `roundness: { "type": 3 }` — slight rounded corners. Omit for hard corners.
- Rectangle node defaults: **200×80px**. Diamond (decision) defaults: **160×100px**. Ellipse (start/end): **140×60px**.
- Arrow `endArrowhead: "arrow"` for direction. `"triangle"` for emphasis. Omit for "association" lines.
- `startBinding` / `endBinding` glue arrow ends to shapes so the arrow follows when the user drags. Always set these — disconnected arrows drift.
- `gridSize: 20` instead of `null` if the user is going to edit further. Snap helps.

Spacing rules:

- Horizontal gap between adjacent shapes (left-to-right): **220px** (200px shape + 20 gap, plus arrow room).
- Vertical gap between rows: **140px** (80px shape + 60 gap).
- Diagram bounding box must start at `x: 80, y: 80` minimum — Excalidraw clips elements close to (0,0).

---

## HTML + inline SVG shape (the embedded path)

When the diagram must live inside an existing artifact (e.g. inside a `report-builder` page) or the user wants no external tool, write a single HTML file with the diagram as inline `<svg>`.

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Architecture — auth flow</title>
  <style>
    :root {
      --paper: #fafaf7;
      --ink: #1a1a1a;
      --accent: #c92a2a;
      --muted: #6b6b6b;
    }
    body { margin: 0; background: var(--paper); color: var(--ink);
           font: 14px/1.4 -apple-system, system-ui, sans-serif;
           display: grid; place-items: center; min-height: 100vh; }
    .diagram { max-width: 960px; padding: 32px; }
    .diagram h1 { font: 600 24px/1.2 Georgia, serif; margin: 0 0 24px; }
    svg .node      { fill: #ffffff; stroke: var(--ink); stroke-width: 2; }
    svg .node-text { fill: var(--ink); font: 600 16px "Caveat", "Comic Sans MS", cursive; text-anchor: middle; dominant-baseline: middle; }
    svg .edge      { stroke: var(--ink); stroke-width: 2; fill: none;
                     stroke-dasharray: 0; }
    svg .edge.dim  { stroke: var(--muted); stroke-dasharray: 4 4; }
    svg .edge.bad  { stroke: var(--accent); }
    svg .edge-label{ fill: var(--ink); font: 500 13px "Caveat", cursive; text-anchor: middle; }
  </style>
</head>
<body>
  <div class="diagram" data-cx-id="diagram-root">
    <h1>Auth flow — login</h1>
    <svg viewBox="0 0 920 360" width="100%">
      <!-- Use Excalidraw-style: each node = a `<g>` with rect + text -->
      <g data-cx-id="node-client" transform="translate(40, 140)">
        <rect class="node" width="200" height="80" rx="6" ry="6" />
        <text class="node-text" x="100" y="40">Browser</text>
      </g>
      <g data-cx-id="node-api" transform="translate(360, 140)">
        <rect class="node" width="200" height="80" rx="6" ry="6" />
        <text class="node-text" x="100" y="40">API Gateway</text>
      </g>
      <g data-cx-id="node-auth" transform="translate(680, 140)">
        <rect class="node" width="200" height="80" rx="6" ry="6" />
        <text class="node-text" x="100" y="40">Auth Service</text>
      </g>
      <!-- Edges. Path d="M start L end". Arrowhead marker for direction. -->
      <defs>
        <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5"
                markerWidth="8" markerHeight="8" orient="auto-start-reverse">
          <path d="M0,0 L10,5 L0,10 z" fill="var(--ink)" />
        </marker>
      </defs>
      <path class="edge" d="M 240,180 L 360,180" marker-end="url(#arrow)" />
      <text class="edge-label" x="300" y="170">POST /login</text>
      <path class="edge" d="M 560,180 L 680,180" marker-end="url(#arrow)" />
      <text class="edge-label" x="620" y="170">verify</text>
      <path class="edge bad" d="M 680,220 Q 480,300 280,220" marker-end="url(#arrow)" />
      <text class="edge-label" x="480" y="290">401 → retry</text>
    </svg>
  </div>
</body>
</html>
```

SVG-specific rules:

- `viewBox` width/height set the coordinate space. Pick `0 0 920 360` for a 4-step horizontal flow, `0 0 600 720` for a 6-step vertical flow.
- Use `<g transform="translate(x, y)">` per node, then everything inside the group uses local coords (0,0 at top-left of the node). This makes layout edits trivial — change the `translate` value to move the whole node.
- Curved edges (`Q` quadratic Bézier in path `d`) only when a straight line would cross another node. Default is a straight `M … L …`.
- `data-cx-id` on every node group so a later edit (e.g. "change Auth Service to Auth0") is one surgical `editFile` on that group.

---

## Concrete examples — two complete diagrams

### Example 1 — system architecture (Excalidraw JSON)

User: "Diagram the SSE-driven chat: client connects to gateway, gateway streams from model, both also talk to a Postgres for history."

Agent writes `chat-architecture.excalidraw`:

```json
{
  "type": "excalidraw",
  "version": 2,
  "source": "https://excalidraw.com",
  "elements": [
    { "id": "n1", "type": "rectangle", "x": 80, "y": 80, "width": 200, "height": 80, "strokeColor": "#1a1a1a", "backgroundColor": "#ffffff", "fillStyle": "solid", "strokeWidth": 2, "roughness": 1, "roundness": { "type": 3 }, "boundElements": [{ "type": "text", "id": "n1-t" }] },
    { "id": "n1-t", "type": "text", "x": 110, "y": 105, "width": 140, "height": 30, "text": "Client (renderer)", "fontSize": 18, "fontFamily": 1, "textAlign": "center", "verticalAlign": "middle", "containerId": "n1" },
    { "id": "n2", "type": "rectangle", "x": 380, "y": 80, "width": 200, "height": 80, "strokeColor": "#1a1a1a", "backgroundColor": "#ffffff", "fillStyle": "solid", "strokeWidth": 2, "roughness": 1, "roundness": { "type": 3 }, "boundElements": [{ "type": "text", "id": "n2-t" }] },
    { "id": "n2-t", "type": "text", "x": 410, "y": 105, "width": 140, "height": 30, "text": "Cortex gateway", "fontSize": 18, "fontFamily": 1, "textAlign": "center", "verticalAlign": "middle", "containerId": "n2" },
    { "id": "n3", "type": "rectangle", "x": 680, "y": 80, "width": 200, "height": 80, "strokeColor": "#1a1a1a", "backgroundColor": "#ffffff", "fillStyle": "solid", "strokeWidth": 2, "roughness": 1, "roundness": { "type": 3 }, "boundElements": [{ "type": "text", "id": "n3-t" }] },
    { "id": "n3-t", "type": "text", "x": 710, "y": 105, "width": 140, "height": 30, "text": "Model provider", "fontSize": 18, "fontFamily": 1, "textAlign": "center", "verticalAlign": "middle", "containerId": "n3" },
    { "id": "n4", "type": "rectangle", "x": 380, "y": 260, "width": 200, "height": 80, "strokeColor": "#1a1a1a", "backgroundColor": "#f6f3ee", "fillStyle": "solid", "strokeWidth": 2, "roughness": 1, "roundness": { "type": 3 }, "boundElements": [{ "type": "text", "id": "n4-t" }] },
    { "id": "n4-t", "type": "text", "x": 410, "y": 285, "width": 140, "height": 30, "text": "SQLite\n(history)", "fontSize": 16, "fontFamily": 1, "textAlign": "center", "verticalAlign": "middle", "containerId": "n4" },
    { "id": "a1", "type": "arrow", "x": 280, "y": 120, "width": 100, "height": 0, "points": [[0, 0], [100, 0]], "startBinding": { "elementId": "n1", "focus": 0, "gap": 1 }, "endBinding": { "elementId": "n2", "focus": 0, "gap": 1 }, "endArrowhead": "arrow", "strokeColor": "#1a1a1a", "strokeWidth": 2, "roughness": 1 },
    { "id": "a2", "type": "arrow", "x": 580, "y": 120, "width": 100, "height": 0, "points": [[0, 0], [100, 0]], "startBinding": { "elementId": "n2", "focus": 0, "gap": 1 }, "endBinding": { "elementId": "n3", "focus": 0, "gap": 1 }, "endArrowhead": "arrow", "strokeColor": "#1a1a1a", "strokeWidth": 2, "roughness": 1 },
    { "id": "a3", "type": "arrow", "x": 480, "y": 160, "width": 0, "height": 100, "points": [[0, 0], [0, 100]], "startBinding": { "elementId": "n2", "focus": 0, "gap": 1 }, "endBinding": { "elementId": "n4", "focus": 0, "gap": 1 }, "endArrowhead": "arrow", "strokeColor": "#1a1a1a", "strokeWidth": 2, "roughness": 1 }
  ],
  "appState": { "viewBackgroundColor": "#fafaf7", "gridSize": 20 },
  "files": {}
}
```

Then in the reply: "Wrote `chat-architecture.excalidraw`. Open excalidraw.com and drag the file in, or `npx @excalidraw/excalidraw-cli render chat-architecture.excalidraw out.png` if installed."

### Example 2 — login sequence (HTML + SVG, top-to-bottom)

User: "Sketch the login sequence as a flowchart I can embed in our spec doc."

Agent writes `login-flow.html` with viewBox `0 0 600 720`, 6 nodes vertically (`User` → `Browser` → `Gateway` → `Auth` → success branch + failure branch). Failure edge uses `class="edge bad"` (red). Each node group has its own `data-cx-id` (`node-user`, `node-browser`, `node-gateway`, `node-auth`, `node-success`, `node-fail`) so later edits are surgical.

---

## Anti-patterns

- **Reaching for Mermaid / Graphviz / d3-graph.** Stop. The Designer ships JSON-or-SVG; Mermaid produces ugly default-rendered output and depends on a runtime parser the user might not have. Excalidraw JSON IS the output, not a step before it.
- **Stuffing 10+ nodes into one canvas.** Stop, split. `diagram-overview.excalidraw` (5 nodes) + `diagram-detail-{area}.excalidraw` (5 nodes each).
- **Decorative color rainbows.** If you used three colors and none of them mean anything, you're decorating, not communicating. Reset to ink + paper, add ONE accent if there's a story.
- **Mixing layout directions in one diagram.** Half horizontal, half vertical = unreadable. Pick one before placing the first shape.
- **Floating arrows with no `startBinding` / `endBinding`.** They drift when the user edits. Always bind both ends.
- **Tiny labels.** `fontSize: 12` is unreadable when zoomed out. Floor is **16px** for labels, **20px** for node text.
