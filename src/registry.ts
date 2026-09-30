import { EventEmitter } from "node:events";

import { normalizeDir } from "./router.js";
import type { Backend } from "./types.js";

/**
 * Holds the current backend set and per-session affinity, emitting `change` on updates.
 *
 * Backends come from two sources: periodic discovery ("discovered") and the
 * lazy supervisor ("managed"). Reading `list()` returns the union.
 */
export class Registry extends EventEmitter {
  /** Backends found by the discovery loop. */
  private discovered: Backend[] = [];
  /** Backends started by OAT for directories with no live server (keyed by port). */
  private managed = new Map<number, Backend>();
  /** session id → backend port, so duplicate-directory sessions stay sticky (Q5). */
  private affinity = new Map<string, number>();
  /** Normalized project directory → original path, served by the v2 shared service. */
  private locationDirs = new Map<string, string>();

  /** Return the union of discovered, managed and shared-service location rows. */
  list(): Backend[] {
    const base = [...this.discovered, ...this.managed.values()];
    return [...base, ...this.locationRows(base)];
  }

  /** Remember that `directory` is served by the v2 shared service. */
  registerLocation(directory: string): void {
    const key = normalizeDir(directory);
    if (this.locationDirs.get(key) === directory) return;
    this.locationDirs.set(key, directory);
    this.emit("change", this.list());
  }

  /** Project directories registered against the shared service (original casing). */
  locations(): string[] {
    return [...this.locationDirs.values()];
  }

  /** One synthesized row per registered project, pointing at the shared service. */
  private locationRows(base: Backend[]): Backend[] {
    if (this.locationDirs.size === 0) return [];
    const service = base.find((backend) => backend.shared && backend.healthy);
    if (!service) return [];
    const rows: Backend[] = [];
    for (const [key, directory] of this.locationDirs) {
      // Skip when a real (discovered/managed) backend already owns that directory.
      if (base.some((backend) => backend.primaryDirectory && normalizeDir(backend.primaryDirectory) === key)) continue;
      rows.push({ ...service, primaryDirectory: directory, location: true });
    }
    return rows;
  }

  /** Replace the discovered backend set and notify listeners. */
  set(discovered: Backend[]): void {
    this.discovered = discovered;
    this.emit("change", this.list());
  }

  /** Register a lazily started backend and notify listeners. */
  addManaged(backend: Backend): void {
    this.managed.set(backend.port, backend);
    this.emit("change", this.list());
  }

  /** Remove a lazily started backend and notify listeners. */
  removeManaged(port: number): void {
    if (this.managed.delete(port)) this.emit("change", this.list());
  }

  /** Ports currently owned by the lazy supervisor. */
  managedPorts(): number[] {
    return [...this.managed.keys()];
  }

  /** Look up a backend by port (discovered or managed). */
  get(port: number): Backend | undefined {
    return this.list().find((backend) => backend.port === port);
  }

  /** Deterministic default backend: the lowest healthy port. */
  defaultPort(): number | null {
    const healthy = this.list()
      .filter((backend) => backend.healthy)
      .sort((a, b) => a.port - b.port);
    return healthy[0]?.port ?? null;
  }

  /** Remember that a session was last served by a given backend. */
  setAffinity(sessionId: string, port: number): void {
    this.affinity.set(sessionId, port);
  }

  /** Read the sticky backend port for a session, if any. */
  affinityPort(sessionId: string): number | null {
    return this.affinity.get(sessionId) ?? null;
  }
}
