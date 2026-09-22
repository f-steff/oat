import fs from "node:fs";
import path from "node:path";

/** Persisted daemon descriptor used for singleton detection and control handoff. */
export interface OatState {
  /** Daemon process id. */
  pid: number;
  /** Optional process start marker to guard against PID reuse. */
  pidStartMarker: string | null;
  /** Port the daemon serves on. */
  port: number;
  /** Host the daemon serves on. */
  host: string;
  /** Daemon version. */
  version: string;
  /** Epoch milliseconds when the daemon started. */
  startedAt: number;
  /** Bearer token required by the control API. */
  token: string;
}

/** Absolute path of the state file inside a state directory. */
export function stateFilePath(stateDir: string): string {
  return path.join(stateDir, "state.json");
}

/** Read and validate the state file, returning null when absent or malformed. */
export async function readState(stateDir: string): Promise<OatState | null> {
  try {
    // Parse leniently and only accept records with the fields we rely on.
    const raw = await fs.promises.readFile(stateFilePath(stateDir), "utf8");
    const parsed = JSON.parse(raw) as Partial<OatState>;
    if (typeof parsed.pid !== "number" || typeof parsed.port !== "number" || typeof parsed.token !== "string") {
      return null;
    }
    return {
      pid: parsed.pid,
      pidStartMarker: typeof parsed.pidStartMarker === "string" ? parsed.pidStartMarker : null,
      port: parsed.port,
      host: typeof parsed.host === "string" ? parsed.host : "127.0.0.1",
      version: typeof parsed.version === "string" ? parsed.version : "0",
      startedAt: typeof parsed.startedAt === "number" ? parsed.startedAt : 0,
      token: parsed.token,
    };
  } catch {
    return null;
  }
}

/** Write the state file with user-only permissions where the platform supports it. */
export async function writeState(stateDir: string, state: OatState): Promise<void> {
  await fs.promises.mkdir(stateDir, { recursive: true });
  const file = stateFilePath(stateDir);
  // mode 0o600 keeps the control token readable only by the owning user.
  await fs.promises.writeFile(file, JSON.stringify(state, null, 2), { encoding: "utf8", mode: 0o600 });
  try {
    await fs.promises.chmod(file, 0o600);
  } catch {
    // chmod is unsupported on some filesystems; the write mode is best-effort.
  }
}

/** Remove the state file, ignoring a missing file. */
export async function clearState(stateDir: string): Promise<void> {
  try {
    await fs.promises.unlink(stateFilePath(stateDir));
  } catch {
    // Already gone: nothing to do.
  }
}

/**
 * Remove the state file only if it still describes `pid`. This prevents a
 * shutting-down daemon from deleting a newer daemon's state.
 */
export async function clearStateIfOwned(stateDir: string, pid: number): Promise<void> {
  const state = await readState(stateDir);
  if (state && state.pid !== pid) return;
  await clearState(stateDir);
}

/** Best-effort check whether a process id is alive. */
export function isProcessAlive(pid: number): boolean {
  try {
    // Signal 0 performs error checking without actually sending a signal.
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but is owned by another user.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
