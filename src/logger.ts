import fs from "node:fs";

/** Log severity levels, ordered from most to least verbose. */
export type LogLevel = "debug" | "info" | "warn" | "error";

/** Numeric ordering so a configured level can suppress lower-severity output. */
const order: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

/** Resolve the initial level from `OAT_LOG_LEVEL`, defaulting to "info". */
function initialLevel(): LogLevel {
  const fromEnv = process.env.OAT_LOG_LEVEL?.toLowerCase();
  if (fromEnv === "debug" || fromEnv === "info" || fromEnv === "warn" || fromEnv === "error") {
    return fromEnv;
  }
  return "info";
}

/** The currently active log level for this process. */
let current: LogLevel = initialLevel();

/** Optional file the daemon appends to (survives detached stdio being discarded). */
let logFile: string | null = null;

/** Set (or clear) the append-only log file. */
export function setLogFile(file: string | null): void {
  logFile = file;
}

/** Read the active log file path, if any. */
export function logFilePath(): string | null {
  return logFile;
}

/** Render one argument for a log line. */
function formatArg(arg: unknown): string {
  if (typeof arg === "string") return arg;
  if (arg instanceof Error) return arg.stack ?? arg.message;
  try {
    return JSON.stringify(arg);
  } catch {
    return String(arg);
  }
}

/** Write one log line to the console and (if configured) the log file. */
function emit(level: LogLevel, args: unknown[]): void {
  if (order[level] < order[current]) return;
  const line = `${new Date().toISOString()} [${level}] ${args.map(formatArg).join(" ")}`;
  // Console output is for foreground use; the daemon runs detached so its file is authoritative.
  const sink = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
  sink(line);
  if (logFile) {
    try {
      fs.appendFileSync(logFile, line + "\n");
    } catch {
      // Never let logging failures take down the daemon.
    }
  }
}

/** Tiny leveled logger shared by every module. */
export const log = {
  /** Change the active level at runtime (e.g. from the control API). */
  setLevel(level: LogLevel): void {
    current = level;
  },
  /** Read the active level. */
  level(): LogLevel {
    return current;
  },
  /** Log at debug level. */
  debug: (...args: unknown[]): void => emit("debug", args),
  /** Log at info level. */
  info: (...args: unknown[]): void => emit("info", args),
  /** Log at warn level. */
  warn: (...args: unknown[]): void => emit("warn", args),
  /** Log at error level. */
  error: (...args: unknown[]): void => emit("error", args),
};
