/**
 * @ownware/loom - Structured logger with level filtering and format options.
 * Zero external dependencies.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogEntry {
  level: LogLevel;
  name: string;
  message: string;
  data?: Record<string, unknown>;
  timestamp: number;
}

export type LogFormat = 'json' | 'pretty';

interface LoggerOptions {
  level: LogLevel;
  format: LogFormat;
  output: (entry: LogEntry) => void;
}

const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

function defaultOutput(entry: LogEntry): void {
  const isError = entry.level === 'warn' || entry.level === 'error';
  const target = isError ? console.error : console.log;
  target(formatEntry(entry, 'pretty'));
}

function formatEntry(entry: LogEntry, format: LogFormat): string {
  if (format === 'json') {
    return JSON.stringify(entry);
  }

  const ts = new Date(entry.timestamp).toISOString();
  const level = entry.level.toUpperCase().padEnd(5);
  let line = `[${ts}] ${level} ${entry.name}: ${entry.message}`;
  if (entry.data && Object.keys(entry.data).length > 0) {
    line += ` ${JSON.stringify(entry.data)}`;
  }
  return line;
}

export class Logger {
  private readonly name: string;
  private readonly opts: LoggerOptions;

  constructor(name: string, opts: LoggerOptions) {
    this.name = name;
    this.opts = opts;
  }

  debug(msg: string, data?: Record<string, unknown>): void {
    this.log('debug', msg, data);
  }

  info(msg: string, data?: Record<string, unknown>): void {
    this.log('info', msg, data);
  }

  warn(msg: string, data?: Record<string, unknown>): void {
    this.log('warn', msg, data);
  }

  error(msg: string, data?: Record<string, unknown>): void {
    this.log('error', msg, data);
  }

  child(childName: string): Logger {
    return new Logger(`${this.name}:${childName}`, { ...this.opts });
  }

  private log(level: LogLevel, message: string, data?: Record<string, unknown>): void {
    if (LOG_LEVEL_PRIORITY[level] < LOG_LEVEL_PRIORITY[this.opts.level]) {
      return;
    }

    const entry: LogEntry = {
      level,
      name: this.name,
      message,
      timestamp: Date.now(),
    };

    if (data !== undefined) {
      entry.data = data;
    }

    if (this.opts.format === 'json') {
      const isError = level === 'warn' || level === 'error';
      const target = isError ? console.error : console.log;
      target(formatEntry(entry, 'json'));
    } else {
      this.opts.output(entry);
    }
  }
}

export function createLogger(
  name: string,
  opts?: { level?: LogLevel; format?: LogFormat },
): Logger {
  const level = opts?.level ?? 'info';
  const format = opts?.format ?? 'pretty';

  return new Logger(name, {
    level,
    format,
    output: defaultOutput,
  });
}
