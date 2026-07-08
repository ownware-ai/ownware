/**
 * Self-contained styles for <OwnwareChat>.
 *
 * Design-system-v2 (Carbon · Bone · Cobalt), the same skin as the Studio
 * screens (.catalyst/design-system-v2). Tokens are namespaced `--ow-*` so
 * they NEVER collide with the host app's CSS variables — that's what makes
 * the component safe to embed anywhere. Override any `--ow-*` on an ancestor
 * (or via the component's `style` prop) to white-label.
 *
 * Dark is the default; `data-ow-theme="light"` flips it. Injected once.
 */

export const OW_STYLE_ID = 'ow-chat-styles'

export const ownwareChatCss = `
.ow-chat {
  --ow-bg: #0F0F0E; --ow-surface: #181817; --ow-surface-2: #1F1F1E; --ow-wash: #282827;
  --ow-hairline: rgba(255,255,255,.09); --ow-hairline-2: rgba(255,255,255,.16);
  --ow-ink: #F4F3F0; --ow-ink-2: #B4B3AE; --ow-ink-3: #8C8B86;
  --ow-accent: #93A9F9; --ow-accent-wash: rgba(147,169,249,.13);
  --ow-action: #F4F3F0; --ow-on-action: #141414; --ow-action-hover: #E7E5E0;
  --ow-success: #3FB950; --ow-warning: #D29922; --ow-warning-wash: rgba(210,153,34,.13);
  --ow-danger: #F85149; --ow-danger-wash: rgba(248,81,73,.13);
  --ow-radius: 12px; --ow-radius-sm: 7px; --ow-radius-pill: 999px;
  --ow-font: "Instrument Sans","Helvetica Neue",Helvetica,system-ui,sans-serif;
  --ow-mono: "IBM Plex Mono",ui-monospace,"SF Mono",Menlo,monospace;

  display: flex; flex-direction: column;
  height: 100%; min-height: 0; width: 100%;
  background: var(--ow-bg); color: var(--ow-ink);
  font-family: var(--ow-font); font-size: 15px; line-height: 1.55;
  border: 1px solid var(--ow-hairline); border-radius: var(--ow-radius);
  overflow: hidden; box-sizing: border-box;
}
.ow-chat[data-ow-theme="light"] {
  --ow-bg: #F4F3F0; --ow-surface: #FFFFFF; --ow-surface-2: #F0EFEC; --ow-wash: #E7E6E2;
  --ow-hairline: rgba(0,0,0,.10); --ow-hairline-2: rgba(0,0,0,.15);
  --ow-ink: #141414; --ow-ink-2: #565654; --ow-ink-3: #83827E;
  --ow-accent: #2A45C6; --ow-accent-wash: rgba(42,69,198,.08);
  --ow-action: #141414; --ow-on-action: #F4F3F0; --ow-action-hover: #282827;
  --ow-success: #1A7F37; --ow-warning: #9A6700; --ow-warning-wash: rgba(154,103,0,.10);
  --ow-danger: #CF222E; --ow-danger-wash: rgba(207,34,46,.09);
}
.ow-chat *, .ow-chat *::before, .ow-chat *::after { box-sizing: border-box; }
.ow-chat button { font: inherit; color: inherit; cursor: pointer; background: none; border: none; }

/* header */
.ow-header {
  display: flex; align-items: center; gap: 10px;
  padding: 12px 16px; border-bottom: 1px solid var(--ow-hairline);
  background: var(--ow-surface); flex: none;
}
.ow-mark { width: 22px; height: 22px; color: var(--ow-accent); flex: none; }
.ow-header-name { font-weight: 650; letter-spacing: -.01em; }
.ow-header-meta { margin-left: auto; display: flex; align-items: center; gap: 10px; }
.ow-live { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: var(--ow-ink-3); }
.ow-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--ow-ink-3); flex: none; }
.ow-live.on .ow-dot { background: var(--ow-success); }
.ow-model { font-family: var(--ow-mono); font-size: 11px; color: var(--ow-ink-3);
  background: var(--ow-surface-2); border: 1px solid var(--ow-hairline);
  padding: 2px 8px; border-radius: var(--ow-radius-pill); }

/* message list */
.ow-msgs { flex: 1 1 auto; min-height: 0; overflow-y: auto; padding: 20px 16px;
  display: flex; flex-direction: column; gap: 16px; }
.ow-empty { margin: auto; text-align: center; color: var(--ow-ink-3); max-width: 34ch;
  display: flex; flex-direction: column; align-items: center; gap: 12px; }
.ow-empty .ow-mark { width: 34px; height: 34px; }

.ow-row { display: flex; gap: 10px; max-width: 100%; }
.ow-row.user { justify-content: flex-end; }
.ow-avatar { width: 26px; height: 26px; border-radius: var(--ow-radius-sm); flex: none;
  display: grid; place-items: center; background: var(--ow-surface-2);
  border: 1px solid var(--ow-hairline); color: var(--ow-accent); }
.ow-avatar .ow-mark { width: 15px; height: 15px; }
.ow-body { min-width: 0; display: flex; flex-direction: column; gap: 8px; }
.ow-row.user .ow-body { align-items: flex-end; }
.ow-bubble { padding: 10px 14px; border-radius: var(--ow-radius);
  white-space: pre-wrap; word-wrap: break-word; overflow-wrap: anywhere; }
.ow-row.user .ow-bubble { background: var(--ow-accent-wash); color: var(--ow-ink);
  border: 1px solid var(--ow-hairline); max-width: 80%; }
.ow-row.assistant .ow-bubble { padding-left: 0; padding-right: 0; }

.ow-caret { display: inline-block; width: 2px; height: 1.05em; margin-left: 1px;
  vertical-align: -2px; background: var(--ow-accent); animation: ow-blink 1s steps(2) infinite; }
@keyframes ow-blink { 50% { opacity: 0; } }

/* tool cards */
.ow-tools { display: flex; flex-direction: column; gap: 6px; }
.ow-tool { border: 1px solid var(--ow-hairline); border-radius: var(--ow-radius-sm);
  background: var(--ow-surface); overflow: hidden; }
.ow-tool-head { display: flex; align-items: center; gap: 8px; padding: 8px 11px; }
.ow-tool-name { font-family: var(--ow-mono); font-size: 12.5px; color: var(--ow-ink); }
.ow-tool-arg { font-size: 12.5px; color: var(--ow-ink-3); min-width: 0; overflow: hidden;
  text-overflow: ellipsis; white-space: nowrap; }
.ow-tool-status { margin-left: auto; display: inline-flex; align-items: center; gap: 5px;
  font-size: 11.5px; color: var(--ow-ink-3); flex: none; }
.ow-tool-status.done { color: var(--ow-success); }
.ow-tool-status.error { color: var(--ow-danger); }
.ow-spin { width: 11px; height: 11px; border-radius: 50%;
  border: 1.5px solid var(--ow-hairline-2); border-top-color: var(--ow-accent);
  animation: ow-rot .7s linear infinite; }
@keyframes ow-rot { to { transform: rotate(360deg); } }
.ow-tool-result { border-top: 1px solid var(--ow-hairline); padding: 8px 11px;
  font-family: var(--ow-mono); font-size: 12px; color: var(--ow-ink-2);
  background: var(--ow-surface-2); max-height: 220px; overflow: auto;
  white-space: pre-wrap; word-break: break-word; }
.ow-tool details > summary { list-style: none; cursor: pointer; padding: 6px 11px;
  font-size: 11.5px; color: var(--ow-ink-3); border-top: 1px solid var(--ow-hairline); }
.ow-tool details > summary::-webkit-details-marker { display: none; }

/* approval card */
.ow-approval { border: 1px solid var(--ow-warning); border-left-width: 3px;
  border-radius: var(--ow-radius); background: var(--ow-warning-wash);
  padding: 14px 16px; display: flex; flex-direction: column; gap: 6px; }
.ow-approval-title { display: flex; align-items: center; gap: 8px; font-weight: 650; }
.ow-approval-title svg { width: 16px; height: 16px; color: var(--ow-warning); flex: none; }
.ow-approval-reason { font-size: 13.5px; color: var(--ow-ink-2); }
.ow-approval-actions { display: flex; gap: 8px; margin-top: 6px; }
.ow-btn { height: 34px; padding: 0 16px; border-radius: var(--ow-radius-sm);
  font-size: 13.5px; font-weight: 600; }
.ow-btn.primary { background: var(--ow-action); color: var(--ow-on-action); }
.ow-btn.primary:hover { background: var(--ow-action-hover); }
.ow-btn.ghost { background: transparent; color: var(--ow-ink-2);
  border: 1px solid var(--ow-hairline-2); }
.ow-btn.ghost:hover { color: var(--ow-ink); }

/* error line */
.ow-error { font-size: 13px; color: var(--ow-danger); padding: 4px 2px; }

/* composer */
.ow-composer { flex: none; border-top: 1px solid var(--ow-hairline);
  background: var(--ow-surface); padding: 12px 12px 12px 16px;
  display: flex; align-items: flex-end; gap: 10px; }
.ow-composer textarea { flex: 1; resize: none; border: none; outline: none; background: none;
  color: var(--ow-ink); font: inherit; line-height: 1.5; max-height: 160px;
  padding: 6px 0; }
.ow-composer textarea::placeholder { color: var(--ow-ink-3); }
.ow-send { width: 34px; height: 34px; border-radius: var(--ow-radius-pill); flex: none;
  display: grid; place-items: center; background: var(--ow-action); color: var(--ow-on-action); }
.ow-send:hover { background: var(--ow-action-hover); }
.ow-send:disabled { opacity: .4; cursor: default; }
.ow-send svg { width: 15px; height: 15px; }

@media (prefers-reduced-motion: reduce) {
  .ow-caret, .ow-spin { animation: none !important; }
}
`
