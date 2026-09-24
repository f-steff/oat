// Recover the text of one or more opencode sessions from the shared SQLite DB.
// Read-only. Useful after the v1->v2 migration stops projecting older v1 sessions.
//
// Usage:
//   node research/recover-session.mjs <outDir> <sessionId> [<sessionId> ...]
//
// Writes <outDir>/recovered-<sessionId>.md with session metadata + the text parts.
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";

const [outDir, ...rest] = process.argv.slice(2);
const tailIndex = rest.indexOf("--tail");
const tail = tailIndex >= 0 ? Number(rest[tailIndex + 1]) || 80 : 80;
const sids = rest.filter((arg, i) => arg !== "--tail" && (tailIndex < 0 || i !== tailIndex + 1));
if (!outDir || sids.length === 0) {
  console.error("usage: node research/recover-session.mjs <outDir> <sessionId> [<sessionId> ...] [--tail N]");
  process.exit(2);
}

const DB = path.join(process.env.USERPROFILE ?? process.env.HOME ?? "", ".local", "share", "opencode", "opencode.db");
const iso = (ms) => (ms ? new Date(ms).toISOString().replace("T", " ").replace(".000Z", "Z") : "(none)");
const count = (db, sql, sid) => {
  try {
    return db.prepare(sql).get(sid)?.n ?? 0;
  } catch {
    return 0;
  }
};

const db = new DatabaseSync(DB, { readOnly: true });
fs.mkdirSync(outDir, { recursive: true });

for (const sid of sids) {
  const s = db.prepare("SELECT id,title,version,directory,time_created,time_updated FROM session WHERE id = ?").get(sid);
  let v2 = null;
  try {
    v2 = db.prepare("SELECT time_updated FROM session_v2 WHERE id = ?").get(sid);
  } catch {
    v2 = null;
  }
  if (!s && !v2) {
    console.log(`SKIP ${sid}: not found`);
    continue;
  }
  const rows = db
    .prepare(
      "SELECT m.time_created AS t, json_extract(m.data,'$.role') AS role, json_extract(p.data,'$.text') AS text " +
        "FROM part p JOIN message m ON p.message_id = m.id " +
        "WHERE p.session_id = ? AND json_extract(p.data,'$.type') = 'text' " +
        "ORDER BY m.time_created DESC, p.time_created DESC LIMIT ?",
    )
    .all(sid, tail)
    .reverse();

  const lines = [];
  lines.push(`# Recovered session - ${s?.title ?? v2?.title ?? sid}`);
  lines.push("");
  lines.push("> Read-only extraction from opencode's shared SQLite DB.");
  lines.push("");
  lines.push("| Field | Value |");
  lines.push("|---|---|");
  lines.push(`| id | \`${sid}\` |`);
  lines.push(`| project directory | \`${s?.directory ?? v2?.directory ?? ""}\` |`);
  lines.push(`| opencode version | ${s?.version ?? v2?.version ?? ""} |`);
  lines.push(`| created | ${iso(s?.time_created)} |`);
  lines.push(`| last activity (v1) | ${iso(s?.time_updated)} |`);
  lines.push(`| v2 projection last update | ${iso(v2?.time_updated)} |`);
  lines.push(`| messages / parts (v1 tables) | ${count(db, "SELECT count(*) AS n FROM message WHERE session_id = ?", sid)} / ${count(db, "SELECT count(*) AS n FROM part WHERE session_id = ?", sid)} |`);
  lines.push(`| session_message rows (v2) | ${count(db, "SELECT count(*) AS n FROM session_message WHERE session_id = ?", sid)} |`);
  lines.push("");
  lines.push(
    `## Text (last ${rows.length} messages)`,
  );
  lines.push("");
  for (const r of rows) {
    lines.push(`### ${iso(r.t)} - ${r.role ?? ""}`);
    lines.push("");
    lines.push(String(r.text ?? "").trimEnd());
    lines.push("");
  }

  const dest = path.join(outDir, `recovered-${sid}.md`);
  fs.writeFileSync(dest, lines.join("\n"), "utf8");
  console.log(`WROTE ${dest} (${rows.length} messages)`);
}

db.close();
