/**
 * Shell integration — VS Code-style OSC 633 markers for the agent shell.
 *
 * The agent shell is a shared INTERACTIVE shell (the human can watch / take
 * over). Injecting a `printf` sentinel as a command is fragile there (the line
 * editor drops bytes, mangles echo). The robust answer — what VS Code / Roo /
 * Windsurf do — is to have the shell emit structured markers from its own
 * `preexec`/`precmd` hooks:
 *
 *   ESC ] 633 ; C ; <nonce>          BEL   command start (pre-exec)
 *   ESC ] 633 ; D ; <nonce> ; <code> BEL   command finished + exit code (precmd)
 *
 * The markers are invisible escape sequences, so the command echo stays clean
 * AND the runner reads exit code + output boundaries deterministically — no
 * sentinel to drop, no echo to guess. The per-session `nonce` means command
 * output can't forge a marker.
 *
 * Injection (zsh): we point `ZDOTDIR` at a small static rc dir whose startup
 * files (a) source the USER's real config so PATH / aliases / nvm survive, then
 * (b) install the hooks, set a clean minimal prompt (no host/path noise), and
 * disable bracketed paste. The nonce is passed via `$CORTEX_SHELL_NONCE` so the
 * rc files are static (written once, reused). The user's `ZDOTDIR` is forwarded
 * as `$CORTEX_USER_ZDOTDIR`.
 *
 * Only zsh is integrated here (the macOS default). Other shells fall back to the
 * runner's Stage-1 marker protocol — still reliable, just without the clean
 * prompt / invisible markers.
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { basename } from 'node:path'
import { randomBytes } from 'node:crypto'

/** Spawn config + nonce for an integrated shell. */
export interface ShellIntegration {
  readonly nonce: string
  readonly shell: string
  readonly args: readonly string[]
  /** Env overrides to merge on top of the process env at spawn. */
  readonly env: Record<string, string>
}

/** Per-session random nonce. Hex only → safe to embed in a RegExp. */
export function makeShellNonce(): string {
  return `cx${randomBytes(8).toString('hex')}`
}

/** Matches the OSC 633 command-start marker for `nonce`. */
export function oscCommandStart(nonce: string): RegExp {
  return new RegExp(`\\x1b\\]633;C;${nonce}\\x07`)
}

/** Matches the OSC 633 command-done marker for `nonce`, capturing the exit code. */
export function oscCommandDone(nonce: string): RegExp {
  return new RegExp(`\\x1b\\]633;D;${nonce};(-?\\d+)\\x07`)
}

// ── zsh integration rc files (static; nonce comes from $CORTEX_SHELL_NONCE) ──

const ZSHENV = `# Cortex agent-shell integration (.zshenv) — source the user's first.
if [[ -n "\${CORTEX_USER_ZDOTDIR:-}" && -f "$CORTEX_USER_ZDOTDIR/.zshenv" ]]; then
  source "$CORTEX_USER_ZDOTDIR/.zshenv"
elif [[ -z "\${CORTEX_USER_ZDOTDIR:-}" && -f "$HOME/.zshenv" ]]; then
  source "$HOME/.zshenv"
fi
`

const ZPROFILE = `# Cortex agent-shell integration (.zprofile) — source the user's first.
if [[ -n "\${CORTEX_USER_ZDOTDIR:-}" && -f "$CORTEX_USER_ZDOTDIR/.zprofile" ]]; then
  source "$CORTEX_USER_ZDOTDIR/.zprofile"
elif [[ -z "\${CORTEX_USER_ZDOTDIR:-}" && -f "$HOME/.zprofile" ]]; then
  source "$HOME/.zprofile"
fi
`

const ZLOGIN = `# Cortex agent-shell integration (.zlogin) — source the user's first.
if [[ -n "\${CORTEX_USER_ZDOTDIR:-}" && -f "$CORTEX_USER_ZDOTDIR/.zlogin" ]]; then
  source "$CORTEX_USER_ZDOTDIR/.zlogin"
elif [[ -z "\${CORTEX_USER_ZDOTDIR:-}" && -f "$HOME/.zlogin" ]]; then
  source "$HOME/.zlogin"
fi
`

// .zshrc — source the user's config, THEN install our hooks + clean prompt so we
// win over whatever the user set. Markers use printf octal escapes (\033 ESC,
// \007 BEL). `add-zsh-hook` is the supported way to add hooks without clobbering
// the user's existing preexec/precmd.
const ZSHRC = `# Cortex agent-shell integration (.zshrc) — source the user's first.
if [[ -n "\${CORTEX_USER_ZDOTDIR:-}" && -f "$CORTEX_USER_ZDOTDIR/.zshrc" ]]; then
  source "$CORTEX_USER_ZDOTDIR/.zshrc"
elif [[ -z "\${CORTEX_USER_ZDOTDIR:-}" && -f "$HOME/.zshrc" ]]; then
  source "$HOME/.zshrc"
fi

# --- Cortex command markers (OSC 633) + clean prompt ---
if [[ -n "\${CORTEX_SHELL_NONCE:-}" ]]; then
  __cortex_preexec() { printf '\\033]633;C;%s\\007' "$CORTEX_SHELL_NONCE" }
  __cortex_precmd()  { local __cx_ec=$?; printf '\\033]633;D;%s;%d\\007' "$CORTEX_SHELL_NONCE" "$__cx_ec" }
  autoload -Uz add-zsh-hook 2>/dev/null
  add-zsh-hook preexec __cortex_preexec 2>/dev/null
  add-zsh-hook precmd __cortex_precmd 2>/dev/null
  # Clean, minimal prompt — no host/path noise when the agent runs commands.
  PROMPT='%# '
  RPROMPT=''
  # Don't let bracketed paste / ZLE mangle programmatic input.
  unset zle_bracketed_paste 2>/dev/null
  # Disable the partial-line "%" marker (PROMPT_EOL_MARK) + its padding — zsh
  # prints it BEFORE precmd, so it would land inside the C..D output slice.
  unsetopt PROMPT_SP 2>/dev/null
  PROMPT_EOL_MARK=''
fi

# Restore the user's ZDOTDIR so later subshells / sourced rc find their files.
ZDOTDIR="\${CORTEX_USER_ZDOTDIR:-$HOME}"
`

/** Where the static zsh rc files live (written once, reused across sessions). */
function integrationDir(): string {
  return join(tmpdir(), 'cortex-shell-integration', 'zsh')
}

/** Write the static zsh rc files (idempotent). */
function ensureZshRcFiles(dir: string): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, '.zshenv'), ZSHENV, 'utf8')
  writeFileSync(join(dir, '.zprofile'), ZPROFILE, 'utf8')
  writeFileSync(join(dir, '.zlogin'), ZLOGIN, 'utf8')
  writeFileSync(join(dir, '.zshrc'), ZSHRC, 'utf8')
}

/**
 * Build the integrated-shell spawn config for the user's shell, or `null` when
 * the shell isn't supported (→ caller spawns normally and the runner uses its
 * Stage-1 fallback protocol).
 *
 * @param shell    The shell executable to integrate (defaults to $SHELL).
 * @param processEnv  The ambient env (for $SHELL / $ZDOTDIR).
 */
export function prepareShellIntegration(opts: {
  readonly shell?: string | undefined
  readonly processEnv?: NodeJS.ProcessEnv
}): ShellIntegration | null {
  const processEnv = opts.processEnv ?? process.env
  const shell = opts.shell ?? processEnv['SHELL'] ?? ''
  // Only zsh is integrated today (macOS default). Anything else → fallback.
  if (basename(shell) !== 'zsh') return null

  const nonce = makeShellNonce()
  const dir = integrationDir()
  try {
    ensureZshRcFiles(dir)
  } catch {
    // Can't write the rc files → no integration; runner falls back.
    return null
  }

  const env: Record<string, string> = {
    ZDOTDIR: dir,
    CORTEX_SHELL_NONCE: nonce,
    // Forward the user's real ZDOTDIR ('' = they used $HOME) so our rc can
    // source their config from the right place.
    CORTEX_USER_ZDOTDIR: processEnv['ZDOTDIR'] ?? '',
  }

  // Login + interactive so the user's full env (zprofile/zshrc) loads.
  return { nonce, shell, args: ['-l', '-i'], env }
}
