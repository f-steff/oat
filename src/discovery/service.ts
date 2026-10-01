import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** The v2 shared-service registration read from disk. */
export interface V2Service {
  /** Base URL of the running service, e.g. `http://127.0.0.1:49374`. */
  url: string;
  /** HTTP Basic password for the service (username is `opencode`). */
  password: string;
}

/**
 * Candidate locations of opencode v2's service registration. The primary path is
 * `~/.local/state/opencode/service.json`; Windows/macOS add their data dirs.
 */
export function v2ServicePaths(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home = os.homedir(),
): string[] {
  const paths = [path.join(home, ".local", "state", "opencode", "service.json")];
  if (platform === "win32") {
    if (env.LOCALAPPDATA) paths.push(path.join(env.LOCALAPPDATA, "opencode", "service.json"));
    if (env.APPDATA) paths.push(path.join(env.APPDATA, "opencode", "service.json"));
  } else if (platform === "darwin") {
    paths.push(path.join(home, "Library", "Application Support", "opencode", "service.json"));
  }
  return paths;
}

/** Read the v2 shared-service URL + password, or null when none is registered. */
export async function readV2Service(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home = os.homedir(),
): Promise<V2Service | null> {
  for (const file of v2ServicePaths(env, platform, home)) {
    try {
      const parsed = JSON.parse(await fs.promises.readFile(file, "utf8")) as { url?: unknown; password?: unknown };
      if (typeof parsed.url === "string" && typeof parsed.password === "string") {
        return { url: parsed.url, password: parsed.password };
      }
    } catch {
      // Missing or malformed: try the next candidate.
    }
  }
  return null;
}
