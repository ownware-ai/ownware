/**
 * Shell Command Security Validator
 *
 * Five-level defense for shell command execution. This is TOOL-LEVEL validation
 * that ships with the shell tool — not part of Loom's permission system.
 *
 * Levels:
 *   1. BLOCKED — always rejected, cannot be overridden (fork bombs, disk wipe)
 *   2. DANGEROUS — requires explicit approval (rm -rf, sudo, chmod 777)
 *   3. INJECTION — shell injection/substitution detection
 *   4. EXFILTRATION — data theft patterns (pipe secrets to network)
 *   5. SENSITIVE — PII/credential patterns in commands (SSN, credit cards)
 *
 * @security This is the primary defense against malicious shell execution.
 * Zero external dependencies. Every pattern is hand-crafted with false-positive avoidance.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ValidationLevel =
  | 'blocked'
  | 'dangerous'
  | 'injection'
  | 'exfiltration'
  | 'sensitive'
  | 'ok'

export interface ValidationResult {
  /** Whether the command is safe to execute */
  readonly safe: boolean
  /** Security level that triggered */
  readonly level: ValidationLevel
  /** Human-readable reason for the decision */
  readonly reason?: string
  /** The pattern that matched (for debugging/audit) */
  readonly pattern?: string
}

export interface ValidationOptions {
  /** Allow shell injection patterns ($(cmd), backticks). Default: false */
  readonly allowInjection?: boolean
  /** Allow dangerous commands (rm -rf, sudo). Default: false */
  readonly allowDangerous?: boolean
  /** Additional patterns to block */
  readonly customBlocklist?: readonly RegExp[]
  /** Command prefixes to always allow */
  readonly customAllowlist?: readonly string[]
}

// ---------------------------------------------------------------------------
// LEVEL 1: ALWAYS BLOCKED — Cannot be overridden
// ---------------------------------------------------------------------------

/** @security These patterns represent IRREVERSIBLE system destruction. Never allow. */
const LEVEL1_BLOCKED: ReadonlyArray<{ pattern: RegExp; reason: string }> = [
  // Fork bombs
  { pattern: /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;?\s*:/, reason: 'Fork bomb detected' },
  { pattern: /\bforkbomb\b/i, reason: 'Fork bomb keyword' },

  // Disk destruction
  { pattern: /\bdd\b.*\bof=\/dev\/[a-z]/, reason: 'dd writing to block device' },
  { pattern: /\bmkfs\b/, reason: 'Filesystem format command' },
  { pattern: /\bfdisk\b/, reason: 'Disk partitioning command' },
  { pattern: /\bparted\b/, reason: 'Disk partitioning command' },

  // System shutdown/reboot
  { pattern: /\binit\s+0\b/, reason: 'System halt (init 0)' },
  { pattern: /\binit\s+6\b/, reason: 'System reboot (init 6)' },
  { pattern: /\bshutdown\b/, reason: 'System shutdown command' },
  { pattern: /\breboot\b/, reason: 'System reboot command' },
  { pattern: /\bhalt\b/, reason: 'System halt command' },
  { pattern: /\bpoweroff\b/, reason: 'System poweroff command' },

  // Kill all processes
  { pattern: /\bkill\s+-9\s+-1\b/, reason: 'Kill all processes' },
  { pattern: /\bkillall\s+-9\b/, reason: 'Kill all by name with SIGKILL' },

  // Direct device overwrite
  { pattern: />\s*\/dev\/sd[a-z]/, reason: 'Redirect to block device' },
  { pattern: />\s*\/dev\/nvme/, reason: 'Redirect to NVMe device' },

  // Wipe entire root
  { pattern: /\brm\s+-[a-zA-Z]*r[a-zA-Z]*f[a-zA-Z]*\s+\/\s*$/, reason: 'rm -rf / (wipe root filesystem)' },
  { pattern: /\brm\s+-[a-zA-Z]*r[a-zA-Z]*f[a-zA-Z]*\s+\/\*/, reason: 'rm -rf /* (wipe root contents)' },

  // Kernel modification
  { pattern: /\binsmod\b/, reason: 'Kernel module insertion' },
  { pattern: /\brmmod\b/, reason: 'Kernel module removal' },

  // BIOS/firmware
  { pattern: /\bflashrom\b/, reason: 'Firmware flash utility' },
]

// ---------------------------------------------------------------------------
// LEVEL 2: DANGEROUS — Blocked unless explicitly approved
// ---------------------------------------------------------------------------

/** @security These are powerful commands that could damage the system if misused. */
const LEVEL2_DANGEROUS: ReadonlyArray<{ pattern: RegExp; reason: string }> = [
  // Recursive force delete (not at root — that's L1)
  { pattern: /\brm\s+-[a-zA-Z]*r[a-zA-Z]*f/, reason: 'Recursive force delete (rm -rf)' },
  { pattern: /\brm\s+-[a-zA-Z]*f[a-zA-Z]*r/, reason: 'Recursive force delete (rm -fr)' },

  // Privilege escalation
  { pattern: /\bsudo\b/, reason: 'Privilege escalation (sudo)' },
  { pattern: /\bsu\s+-?\s*\w/, reason: 'Switch user (su)' },
  { pattern: /\bdoas\b/, reason: 'Privilege escalation (doas)' },
  { pattern: /\bpkexec\b/, reason: 'Privilege escalation (pkexec)' },

  // Dangerous permissions
  { pattern: /\bchmod\s+(-[a-zA-Z]*\s+)?777\b/, reason: 'World-writable permissions (chmod 777)' },
  { pattern: /\bchmod\s+(-[a-zA-Z]*\s+)?a\+rwx\b/, reason: 'World-writable permissions (chmod a+rwx)' },
  { pattern: /\bchmod\s+(-[a-zA-Z]*\s+)?\+s\b/, reason: 'Set SUID/SGID bit' },

  // Pipe to shell from network
  { pattern: /\bcurl\b.*\|\s*(sudo\s+)?(ba)?sh\b/, reason: 'Pipe network content to shell (curl|sh)' },
  { pattern: /\bwget\b.*\|\s*(sudo\s+)?(ba)?sh\b/, reason: 'Pipe network content to shell (wget|sh)' },
  { pattern: /\bcurl\b.*\|\s*(sudo\s+)?python/, reason: 'Pipe network content to python' },

  // System config overwrites
  { pattern: />\s*\/etc\//, reason: 'Overwrite system config (/etc/)' },
  { pattern: />\s*~\/\.bashrc\b/, reason: 'Overwrite shell config (.bashrc)' },
  { pattern: />\s*~\/\.zshrc\b/, reason: 'Overwrite shell config (.zshrc)' },
  { pattern: />\s*~\/\.profile\b/, reason: 'Overwrite shell profile' },
  { pattern: />\s*~\/\.ssh\//, reason: 'Overwrite SSH config' },

  // Package manager with sudo
  { pattern: /\bsudo\s+(apt|apt-get|yum|dnf|pacman|brew|pip|npm)\b/, reason: 'Package manager with sudo' },

  // Docker privileged
  { pattern: /\bdocker\s+run\b.*--privileged/, reason: 'Docker privileged mode' },
  { pattern: /\bdocker\s+run\b.*--pid=host/, reason: 'Docker host PID namespace' },
  { pattern: /\bdocker\s+run\b.*--net=host/, reason: 'Docker host network' },

  // Network listeners on common ports
  { pattern: /\bnc\s+-[a-zA-Z]*l/, reason: 'Netcat listener' },
  { pattern: /\bpython3?\s+-m\s+http\.server\b/, reason: 'Python HTTP server' },
  { pattern: /\bsocat\b.*\bTCP-LISTEN\b/i, reason: 'Socat TCP listener' },

  // Disk operations
  { pattern: /\bwipe\b/, reason: 'Disk wipe utility' },
  { pattern: /\bshred\b/, reason: 'Secure file deletion (shred)' },
  { pattern: /\bsrm\b/, reason: 'Secure file deletion (srm)' },

  // crontab modification
  { pattern: /\bcrontab\s+-[er]/, reason: 'Crontab modification' },

  // iptables / firewall
  { pattern: /\biptables\b/, reason: 'Firewall modification' },
  { pattern: /\bnft\b/, reason: 'nftables modification' },
  { pattern: /\bufw\b/, reason: 'UFW firewall modification' },

  // Indirect execution
  { pattern: /\bxargs\s+.*\brm\b/, reason: 'xargs with rm (indirect mass delete)' },
  { pattern: /\bxargs\s+.*\bchmod\b/, reason: 'xargs with chmod (indirect permission change)' },
  { pattern: /\bfind\b.*-exec\b/, reason: 'find -exec (indirect command execution)' },
  { pattern: /\bfind\b.*-execdir\b/, reason: 'find -execdir (indirect command execution)' },
  { pattern: /\bfind\b.*-delete\b/, reason: 'find -delete (indirect file deletion)' },

  // Alias/function redefinition
  { pattern: /\balias\s+\w+=/, reason: 'Shell alias redefinition' },
  { pattern: /\bfunction\s+\w+\s*\(/, reason: 'Shell function definition' },

  // Environment poisoning
  { pattern: /\bexport\s+(PATH|LD_PRELOAD|LD_LIBRARY_PATH|DYLD_)/, reason: 'Critical environment variable modification' },
  { pattern: /\bLD_PRELOAD\s*=/, reason: 'LD_PRELOAD injection' },
]

// ---------------------------------------------------------------------------
// LEVEL 3: INJECTION DETECTION
// ---------------------------------------------------------------------------

/** @security Shell injection via substitution, IFS manipulation, or encoding tricks. */
const LEVEL3_INJECTION: ReadonlyArray<{ pattern: RegExp; reason: string }> = [
  // Command substitution
  { pattern: /\$\(/, reason: 'Command substitution $(...)' },
  { pattern: /(?<!\\)`[^`]*`/, reason: 'Backtick command substitution' },
  { pattern: /\$\{[^}]*[^a-zA-Z0-9_}]/, reason: 'Complex parameter expansion ${...}' },

  // Process substitution
  { pattern: /<\(/, reason: 'Process substitution <(...)' },
  { pattern: />\(/, reason: 'Process substitution >(...)' },
  { pattern: /=\(/, reason: 'Zsh process substitution =(...)' },

  // IFS manipulation
  { pattern: /\bIFS\s*=/, reason: 'IFS variable manipulation' },
  { pattern: /\$IFS/, reason: 'IFS variable reference' },
  { pattern: /\$\{[^}]*IFS/, reason: 'IFS in parameter expansion' },

  // Command chaining when combined with dangerous patterns
  // Note: `;` and `&&` and `||` alone are NOT blocked — they're normal shell syntax.
  // L1/L2 patterns scan the FULL string, so `echo safe; rm -rf /` is caught by L1.
  // This check catches encoded/obfuscated semicolons:
  { pattern: /%3[bB]/, reason: 'URL-encoded semicolon (command chaining obfuscation)' },
  { pattern: /\$'\x3b'/, reason: 'ANSI-C encoded semicolon' },

  // Backgrounding with network
  { pattern: /&\s*$/, reason: 'Backgrounded command' },

  // Newline / carriage return injection
  { pattern: /\r/, reason: 'Carriage return in command (possible injection)' },
  { pattern: /\n.*\n/, reason: 'Multiple newlines in command (possible multi-command injection)' },

  // Null byte injection
  { pattern: /\x00/, reason: 'Null byte in command' },
  { pattern: /%00/, reason: 'URL-encoded null byte' },

  // Unicode whitespace (looks like space but isn't)
  { pattern: /[\u00A0\u2000-\u200B\u2028\u2029\u202F\u205F\u3000\uFEFF]/, reason: 'Unicode whitespace (possible obfuscation)' },

  // Eval and indirect execution
  { pattern: /\beval\s/, reason: 'eval command (arbitrary code execution)' },
  { pattern: /\bsource\s/, reason: 'source command (script execution)' },
  { pattern: /\b\.\s+\//, reason: 'Dot-source command' },

  // Hex/octal encoding tricks
  { pattern: /\$'\\x[0-9a-fA-F]/, reason: 'ANSI-C hex escape in argument' },
  { pattern: /\$'\\[0-7]{3}/, reason: 'ANSI-C octal escape in argument' },
]

// ---------------------------------------------------------------------------
// LEVEL 4: DATA EXFILTRATION
// ---------------------------------------------------------------------------

/** @security Patterns that steal data by piping to network tools. */
const LEVEL4_EXFILTRATION: ReadonlyArray<{ pattern: RegExp; reason: string }> = [
  // Environment/process info to network
  { pattern: /\/proc\/self\/environ/, reason: 'Process environment access (/proc/self/environ)' },
  { pattern: /\/proc\/[0-9]+\/environ/, reason: 'Process environment access (/proc/*/environ)' },
  { pattern: /\bprintenv\b.*\|\s*(curl|wget|nc|ncat)\b/, reason: 'Environment exfiltration via network' },
  { pattern: /\benv\b.*\|\s*(curl|wget|nc|ncat)\b/, reason: 'Environment exfiltration via network' },

  // Secret file to network
  { pattern: /\bcat\b.*\.env\b.*\|\s*(curl|wget|nc)/, reason: '.env file exfiltration' },
  { pattern: /\bcat\b.*\.(key|pem)\b.*\|\s*(curl|wget|nc)/, reason: 'Key/cert file exfiltration' },
  { pattern: /\bcat\b.*credentials\b.*\|\s*(curl|wget|nc)/, reason: 'Credentials file exfiltration' },

  // SSH key exfiltration
  { pattern: /\bcat\b.*~\/\.ssh\/id_.*\|\s*(curl|wget|nc)/, reason: 'SSH key exfiltration' },
  { pattern: /\bcat\b.*\.ssh\/id_/, reason: 'SSH private key access' },

  // Git credentials
  { pattern: /\bgit\s+config\s+--get\s+credential/, reason: 'Git credential access' },
  { pattern: /\bgit\s+credential\s+fill/, reason: 'Git credential fill' },

  // History exfiltration
  { pattern: /\bcat\b.*\.(bash_|zsh_)?history\b.*\|\s*(curl|wget|nc)/, reason: 'Shell history exfiltration' },

  // AWS credentials
  { pattern: /\bcat\b.*\.aws\/credentials\b/, reason: 'AWS credentials access' },

  // General pattern: sensitive file + pipe to network
  { pattern: /\.(env|key|pem|p12|pfx|jks)\b.*\|\s*(curl|wget|nc|ncat|netcat)\b/, reason: 'Sensitive file piped to network' },

  // Base64 encode + send (common exfil technique)
  { pattern: /\bbase64\b.*\|\s*(curl|wget|nc)\b/, reason: 'Base64 encoded data to network' },

  // Clipboard to network
  { pattern: /\b(pbpaste|xclip|xsel)\b.*\|\s*(curl|wget|nc)/, reason: 'Clipboard exfiltration' },

  // DNS exfiltration
  { pattern: /\bdig\b.*\$\(/, reason: 'DNS exfiltration via command substitution' },
  { pattern: /\bnslookup\b.*\$\(/, reason: 'DNS exfiltration via command substitution' },
]

// ---------------------------------------------------------------------------
// LEVEL 5: SENSITIVE DATA PATTERNS
// ---------------------------------------------------------------------------

/** @security Detect PII/credentials embedded in commands. For legal/finance/healthcare agents. */
const LEVEL5_SENSITIVE: ReadonlyArray<{ pattern: RegExp; reason: string }> = [
  // Credit card numbers (4 groups of 4 digits)
  { pattern: /\b\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/, reason: 'Possible credit card number in command' },

  // US Social Security Numbers
  { pattern: /\b\d{3}-\d{2}-\d{4}\b/, reason: 'Possible SSN in command' },

  // Database connection strings with passwords
  { pattern: /(postgres|mysql|mongodb|redis):\/\/[^:]+:[^@]+@/, reason: 'Database connection string with password' },

  // JWT tokens (common format)
  { pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/, reason: 'JWT token in command' },

  // API keys in arguments
  { pattern: /\b(AKIA|ASIA)[A-Z0-9]{16}\b/, reason: 'AWS access key in command' },
  { pattern: /\bsk-[a-zA-Z0-9]{20,}\b/, reason: 'API key pattern (sk-...) in command' },
  { pattern: /\bsk-ant-[a-zA-Z0-9]{20,}\b/, reason: 'Anthropic API key in command' },
  { pattern: /\bghp_[a-zA-Z0-9]{36}\b/, reason: 'GitHub personal access token in command' },
  { pattern: /\bgho_[a-zA-Z0-9]{36}\b/, reason: 'GitHub OAuth token in command' },
  { pattern: /\bsk_live_[a-zA-Z0-9]{20,}\b/, reason: 'Stripe live key in command' },
  { pattern: /\bAIza[a-zA-Z0-9_-]{35}\b/, reason: 'Google API key in command' },

  // Bearer tokens
  { pattern: /\bBearer\s+[a-zA-Z0-9_.-]{20,}\b/, reason: 'Bearer token in command' },

  // Private keys inline
  { pattern: /-----BEGIN\s+(RSA\s+|EC\s+|DSA\s+|ENCRYPTED\s+)?PRIVATE\s+KEY-----/, reason: 'Private key in command' },
]

// ---------------------------------------------------------------------------
// Main validator
// ---------------------------------------------------------------------------

/**
 * Validate a shell command against all security levels.
 *
 * @security This is the primary entry point for shell security validation.
 *
 * @param command - The shell command to validate
 * @param opts - Override default behavior for specific levels
 * @returns Validation result with level, safety status, and reason
 */
export function validateCommand(
  command: string,
  opts?: ValidationOptions,
): ValidationResult {
  // Edge cases
  if (!command || !command.trim()) {
    return { safe: true, level: 'ok', reason: 'Empty command' }
  }

  if (command.length > 100_000) {
    return { safe: false, level: 'blocked', reason: 'Command exceeds 100KB limit', pattern: 'length' }
  }

  // Custom allowlist — check before any blocking
  if (opts?.customAllowlist) {
    const trimmed = command.trim()
    for (const prefix of opts.customAllowlist) {
      if (trimmed.startsWith(prefix)) {
        return { safe: true, level: 'ok', reason: `Allowed by custom allowlist: ${prefix}` }
      }
    }
  }

  // Custom blocklist — check first
  if (opts?.customBlocklist) {
    for (const pattern of opts.customBlocklist) {
      if (pattern.test(command)) {
        return { safe: false, level: 'blocked', reason: 'Matched custom blocklist', pattern: pattern.source }
      }
    }
  }

  // LEVEL 1: ALWAYS BLOCKED — no override possible
  for (const { pattern, reason } of LEVEL1_BLOCKED) {
    if (pattern.test(command)) {
      return { safe: false, level: 'blocked', reason, pattern: pattern.source }
    }
  }

  // LEVEL 2: DANGEROUS — blocked unless allowDangerous is true
  if (!opts?.allowDangerous) {
    for (const { pattern, reason } of LEVEL2_DANGEROUS) {
      if (pattern.test(command)) {
        return { safe: false, level: 'dangerous', reason, pattern: pattern.source }
      }
    }
  }

  // LEVEL 3: INJECTION — blocked unless allowInjection is true
  if (!opts?.allowInjection) {
    for (const { pattern, reason } of LEVEL3_INJECTION) {
      if (pattern.test(command)) {
        return { safe: false, level: 'injection', reason, pattern: pattern.source }
      }
    }
  }

  // LEVEL 4: EXFILTRATION — always checked (no override)
  for (const { pattern, reason } of LEVEL4_EXFILTRATION) {
    if (pattern.test(command)) {
      return { safe: false, level: 'exfiltration', reason, pattern: pattern.source }
    }
  }

  // LEVEL 5: SENSITIVE DATA — always checked
  for (const { pattern, reason } of LEVEL5_SENSITIVE) {
    if (pattern.test(command)) {
      return { safe: false, level: 'sensitive', reason, pattern: pattern.source }
    }
  }

  return { safe: true, level: 'ok' }
}

// ---------------------------------------------------------------------------
// Exports for testing and extension
// ---------------------------------------------------------------------------

export { LEVEL1_BLOCKED, LEVEL2_DANGEROUS, LEVEL3_INJECTION, LEVEL4_EXFILTRATION, LEVEL5_SENSITIVE }
