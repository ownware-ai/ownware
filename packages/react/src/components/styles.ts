/**
 * Self-contained styles for <OwnwareChat>.
 *
 * Ownware's Carbon · Bone · Cobalt palette. Tokens are namespaced `--ow-*`
 * so they never collide with the host app's CSS variables. Override any
 * `--ow-*` on an ancestor (or through the component's `style` prop) to fit
 * the host application.
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
.ow-tool-verb { font-size: 13px; font-weight: 600; color: var(--ow-ink); flex: none; }
.ow-tool-arg { font-family: var(--ow-mono); font-size: 12px; color: var(--ow-ink-2); min-width: 0;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ow-tool-line { display: flex; align-items: center; gap: 8px; font-size: 12.5px; color: var(--ow-ink-3); padding: 1px 2px; }
.ow-tool-line .ow-tool-verb { font-size: 12.5px; font-weight: 600; color: var(--ow-ink-2); }
.ow-tool-open { font-size: 11.5px; color: var(--ow-accent); text-decoration: none; flex: none; }
.ow-tool-open:hover { text-decoration: underline; }
.ow-diff-add { color: var(--ow-success); }
.ow-diff-del { color: var(--ow-danger); }
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

/** Styles for <OwnwareStudio> — the shell (sidebar + chat). Reuses the same
 *  --ow-* tokens; inject alongside ownwareChatCss. */
export const OW_STUDIO_STYLE_ID = 'ow-studio-styles'

export const ownwareStudioCss = `
.ow-studio {
  --ow-bg: #0F0F0E; --ow-surface: #181817; --ow-surface-2: #1F1F1E;
  --ow-hairline: rgba(255,255,255,.09); --ow-hairline-2: rgba(255,255,255,.16);
  --ow-ink: #F4F3F0; --ow-ink-2: #B4B3AE; --ow-ink-3: #8C8B86;
  --ow-accent: #93A9F9; --ow-accent-wash: rgba(147,169,249,.13);
  --ow-action: #F4F3F0; --ow-on-action: #141414; --ow-action-hover: #E7E5E0;
  --ow-font: "Instrument Sans","Helvetica Neue",Helvetica,system-ui,sans-serif;
  --ow-mono: "IBM Plex Mono",ui-monospace,"SF Mono",Menlo,monospace;
  display: grid; grid-template-columns: 250px 1fr; height: 100%; width: 100%;
  background: var(--ow-bg); color: var(--ow-ink); font-family: var(--ow-font); font-size: 15px;
  border: 1px solid var(--ow-hairline); border-radius: 12px; overflow: hidden; box-sizing: border-box;
}
.ow-studio[data-ow-theme="light"] {
  --ow-bg: #F4F3F0; --ow-surface: #FFFFFF; --ow-surface-2: #F0EFEC;
  --ow-hairline: rgba(0,0,0,.10); --ow-hairline-2: rgba(0,0,0,.15);
  --ow-ink: #141414; --ow-ink-2: #565654; --ow-ink-3: #83827E;
  --ow-accent: #2A45C6; --ow-accent-wash: rgba(42,69,198,.08);
  --ow-action: #141414; --ow-on-action: #F4F3F0; --ow-action-hover: #282827;
}
.ow-studio *, .ow-studio *::before, .ow-studio *::after { box-sizing: border-box; }
.ow-studio button, .ow-studio select { font: inherit; cursor: pointer; }
.ow-studio select { color: var(--ow-ink); }
.ow-studio .ow-chat { border: none; border-radius: 0; height: 100%; }

.ow-side { display: flex; flex-direction: column; min-height: 0; padding: 12px;
  border-right: 1px solid var(--ow-hairline); background: var(--ow-surface); }
.ow-side-brand { display: flex; align-items: center; gap: 8px; padding: 4px 6px 14px; }
.ow-side-brand .ow-mark { width: 20px; height: 20px; color: var(--ow-accent); }
.ow-side-brand b { font-weight: 700; letter-spacing: -.01em; }
.ow-new { display: flex; align-items: center; justify-content: center; gap: 7px; height: 36px;
  border-radius: 8px; background: var(--ow-action); color: var(--ow-on-action);
  font-weight: 600; font-size: 13.5px; border: none; }
.ow-new:hover { background: var(--ow-action-hover); }
.ow-side-label { font-family: var(--ow-mono); font-size: 10.5px; letter-spacing: .08em;
  text-transform: uppercase; color: var(--ow-ink-3); padding: 14px 6px 5px; }
.ow-profile { width: 100%; height: 34px; padding: 0 10px; border-radius: 7px;
  background: var(--ow-bg); color: var(--ow-ink); border: 1px solid var(--ow-hairline);
  font-size: 13.5px; }
.ow-convos { display: flex; flex-direction: column; gap: 2px; overflow-y: auto; min-height: 0; margin-top: 4px; }
.ow-convo { text-align: left; padding: 8px 10px; border-radius: 7px; font-size: 13.5px;
  color: var(--ow-ink-2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  position: relative; border: none; background: none; width: 100%; }
.ow-convo:hover { background: var(--ow-surface-2); }
.ow-convo.active { background: var(--ow-accent-wash); color: var(--ow-ink); }
.ow-convo.active::before { content: ""; position: absolute; left: 0; top: 50%; width: 2px;
  height: 14px; margin-top: -7px; background: var(--ow-accent); border-radius: 2px; }
.ow-side-foot { margin-top: auto; padding: 10px 6px 2px; font-size: 11px; color: var(--ow-ink-3);
  border-top: 1px solid var(--ow-hairline); }
.ow-side-foot b { color: var(--ow-ink-2); font-weight: 600; }
.ow-main { min-width: 0; min-height: 0; display: flex; }
.ow-main > * { flex: 1; min-width: 0; }
.ow-hidden { display: none !important; }
`

/** Styles for <ChatGPTConnection>. Kept separate so account management can be
 * embedded without pulling in the chat or studio layout. */
export const OW_CONNECTION_STYLE_ID = 'ow-connection-styles'

export const ownwareConnectionCss = `
.ow-connection {
  --ow-bg: #0F0F0E; --ow-surface: #181817; --ow-surface-2: #1F1F1E; --ow-wash: #282827;
  --ow-hairline: rgba(255,255,255,.09); --ow-hairline-2: rgba(255,255,255,.16);
  --ow-ink: #F4F3F0; --ow-ink-2: #B4B3AE; --ow-ink-3: #8C8B86;
  --ow-accent: #93A9F9; --ow-accent-wash: rgba(147,169,249,.13);
  --ow-action: #F4F3F0; --ow-on-action: #141414; --ow-action-hover: #E7E5E0;
  --ow-success: #3FB950; --ow-danger: #F85149; --ow-danger-wash: rgba(248,81,73,.13);
  --ow-font: "Instrument Sans","Helvetica Neue",Helvetica,system-ui,sans-serif;
  --ow-mono: "IBM Plex Mono",ui-monospace,"SF Mono",Menlo,monospace;
  width: 100%; max-width: 760px; padding: 24px; color: var(--ow-ink); background: var(--ow-bg);
  border: 1px solid var(--ow-hairline); border-radius: 14px; font-family: var(--ow-font);
  font-size: 15px; line-height: 1.5; box-sizing: border-box;
}
.ow-connection[data-ow-theme="light"] {
  --ow-bg: #F4F3F0; --ow-surface: #FFFFFF; --ow-surface-2: #F0EFEC; --ow-wash: #E7E6E2;
  --ow-hairline: rgba(0,0,0,.10); --ow-hairline-2: rgba(0,0,0,.15);
  --ow-ink: #141414; --ow-ink-2: #565654; --ow-ink-3: #83827E;
  --ow-accent: #2A45C6; --ow-accent-wash: rgba(42,69,198,.08);
  --ow-action: #141414; --ow-on-action: #F4F3F0; --ow-action-hover: #282827;
  --ow-success: #1A7F37; --ow-danger: #CF222E; --ow-danger-wash: rgba(207,34,46,.09);
}
.ow-connection *, .ow-connection *::before, .ow-connection *::after { box-sizing: border-box; }
.ow-connection button { font: inherit; cursor: pointer; }
.ow-connection button:disabled { cursor: default; opacity: .52; }
.ow-connection a { color: var(--ow-accent); font-weight: 650; text-underline-offset: 3px; }
.ow-connection :is(button, a):focus-visible { outline: 2px solid var(--ow-accent); outline-offset: 3px; }
.ow-connection-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 20px; }
.ow-connection-eyebrow { margin: 0 0 4px; color: var(--ow-accent); font-family: var(--ow-mono);
  font-size: 10.5px; font-weight: 700; letter-spacing: .1em; text-transform: uppercase; }
.ow-connection-head h2 { margin: 0; font-size: 24px; line-height: 1.2; letter-spacing: -.025em; }
.ow-connection-head p:not(.ow-connection-eyebrow) { max-width: 48ch; margin: 8px 0 0; color: var(--ow-ink-2); }
.ow-connection-state { display: inline-flex; align-items: center; gap: 7px; flex: none; padding: 5px 9px;
  color: var(--ow-ink-3); background: var(--ow-surface); border: 1px solid var(--ow-hairline);
  border-radius: 999px; font-family: var(--ow-mono); font-size: 10.5px; }
.ow-connection-state > span { width: 7px; height: 7px; border-radius: 50%; background: var(--ow-ink-3); }
.ow-connection-state.connected { color: var(--ow-success); }
.ow-connection-state.connected > span { background: var(--ow-success); }
.ow-route-list { display: grid; gap: 10px; margin-top: 22px; }
.ow-route { display: flex; align-items: center; justify-content: space-between; gap: 20px; min-width: 0;
  padding: 16px; background: var(--ow-surface); border: 1px solid var(--ow-hairline); border-radius: 10px; }
.ow-route.active { border-color: var(--ow-hairline-2); }
.ow-route.unavailable { opacity: .66; }
.ow-route-copy { min-width: 0; }
.ow-route-title { display: flex; align-items: center; gap: 8px; }
.ow-route-title h3 { margin: 0; font-size: 15px; letter-spacing: -.01em; }
.ow-route-copy p { margin: 5px 0 0; color: var(--ow-ink-2); font-size: 13.5px; }
.ow-route-copy .ow-route-meta { color: var(--ow-ink-3); font-family: var(--ow-mono); font-size: 10.5px; }
.ow-badge { padding: 2px 7px; color: var(--ow-accent); background: var(--ow-accent-wash);
  border-radius: 999px; font-family: var(--ow-mono); font-size: 9.5px; font-weight: 700; letter-spacing: .04em; text-transform: uppercase; }
.ow-badge.muted { color: var(--ow-ink-3); background: var(--ow-surface-2); }
.ow-route-action, .ow-connection-actions { display: flex; flex: none; gap: 8px; }
.ow-connection-btn { min-height: 36px; padding: 0 13px; border-radius: 7px; font-size: 13px; font-weight: 650; }
.ow-connection-btn.primary { color: var(--ow-on-action); background: var(--ow-action); border: 1px solid var(--ow-action); }
.ow-connection-btn.primary:hover:not(:disabled) { background: var(--ow-action-hover); }
.ow-connection-btn.ghost { color: var(--ow-ink-2); background: transparent; border: 1px solid var(--ow-hairline-2); }
.ow-connection-btn.ghost:hover:not(:disabled) { color: var(--ow-ink); background: var(--ow-surface-2); }
.ow-login-panel { display: grid; justify-items: start; gap: 8px; margin-top: 12px; padding: 16px;
  color: var(--ow-ink-2); background: var(--ow-accent-wash); border: 1px solid var(--ow-hairline-2); border-radius: 10px; }
.ow-login-panel strong { color: var(--ow-ink); }
.ow-login-panel p { margin: 0; }
.ow-login-panel code { padding: 8px 11px; color: var(--ow-ink); background: var(--ow-bg);
  border: 1px solid var(--ow-hairline); border-radius: 6px; font-family: var(--ow-mono); font-size: 17px;
  font-weight: 700; letter-spacing: .08em; user-select: all; }
.ow-login-panel .ow-connection-wait { color: var(--ow-ink-3); font-size: 12px; }
.ow-connected-detail { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 1px;
  margin-top: 12px; overflow: hidden; background: var(--ow-hairline); border: 1px solid var(--ow-hairline); border-radius: 10px; }
.ow-connected-detail > div { min-width: 0; padding: 13px; background: var(--ow-surface); }
.ow-connected-detail span { display: block; color: var(--ow-ink-3); font-size: 11px; }
.ow-connected-detail strong { display: block; margin-top: 3px; overflow: hidden; color: var(--ow-ink);
  font-family: var(--ow-mono); font-size: 12px; text-overflow: ellipsis; white-space: nowrap; }
.ow-connection-note { margin: 12px 0 0; color: var(--ow-ink-2); font-size: 13px; }
.ow-connection-error { display: flex; align-items: center; justify-content: space-between; gap: 12px;
  margin-top: 12px; padding: 10px 12px; color: var(--ow-danger); background: var(--ow-danger-wash);
  border: 1px solid var(--ow-danger); border-radius: 8px; font-size: 13px; }
.ow-connection-error button { padding: 2px; color: inherit; background: none; border: none; font-weight: 700; text-decoration: underline; }
.ow-connection-foot { margin-top: 16px; padding-top: 14px; color: var(--ow-ink-3); border-top: 1px solid var(--ow-hairline);
  font-size: 11.5px; }
@media (max-width: 640px) {
  .ow-connection { padding: 18px; }
  .ow-connection-head, .ow-route { align-items: stretch; flex-direction: column; }
  .ow-connection-state { align-self: flex-start; }
  .ow-route-action, .ow-connection-actions { width: 100%; }
  .ow-connection-actions { flex-direction: column; }
  .ow-connection-btn { width: 100%; }
  .ow-connected-detail { grid-template-columns: 1fr; }
}
`
