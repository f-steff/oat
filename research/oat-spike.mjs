// OAT spike: prove scan -> route -> SSE-merge against real opencode servers.
// Self-contained and self-terminating. Never leaves children alive.
import { spawn, execFileSync } from "node:child_process"
import http from "node:http"

const EXE = "C:\\Users\\DKfls\\AppData\\Roaming\\npm\\node_modules\\opencode-ai\\bin\\opencode.exe"
const SPIKE = "C:\\Users\\DKfls\\AppData\\Local\\Temp\\opencode\\oat-spike"
const MUX_PORT = 46099
const BACKENDS = [
  { name: "A", port: 46010, cwd: SPIKE + "\\projA", pid: null, primaryDirectory: null },
  { name: "B", port: 46011, cwd: SPIKE + "\\projB", pid: null, primaryDirectory: null },
]

const results = []
const children = []
let mux = null
let teardownDone = false

function check(name, ok, detail = "") {
  results.push({ name, ok, detail })
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  -- " + detail : ""}`)
}

function killTree(pid) {
  if (!pid) return
  try { process.kill(pid) } catch {}
  try { execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", timeout: 8000 }) } catch {}
}

function teardown(reason) {
  if (teardownDone) return
  teardownDone = true
  console.log(`\n[teardown] reason=${reason}`)
  try { mux?.close() } catch {}
  for (const c of children) { killTree(c.pid); console.log(`[teardown] killed opencode pid=${c.pid}`) }
  try {
    const pids = children.map((c) => c.pid).filter(Boolean)
    if (pids.length) execFileSync("pwsh", ["-NoProfile", "-Command", `Stop-Process -Id ${pids.join(",")} -Force -ErrorAction SilentlyContinue`], { timeout: 10000, stdio: "ignore" })
  } catch {}
}

const watchdog = setTimeout(() => { teardown("watchdog timeout"); process.exit(2) }, 140000)
process.on("SIGINT", () => { teardown("SIGINT"); process.exit(130) })
process.on("SIGTERM", () => { teardown("SIGTERM"); process.exit(143) })

async function fetchJson(url, { headers = {}, timeout = 2500 } = {}) {
  const ac = new AbortController()
  const t = setTimeout(() => ac.abort(), timeout)
  try {
    const r = await fetch(url, { headers, signal: ac.signal })
    const text = await r.text()
    let json
    try { json = JSON.parse(text) } catch {}
    return { status: r.status, headers: r.headers, text, json }
  } finally { clearTimeout(t) }
}

function startBackend(b) {
  const child = spawn(EXE, ["serve", "--port", String(b.port)], {
    cwd: b.cwd, stdio: "ignore", windowsHide: true, detached: true,
  })
  child.unref()
  children.push(child)
  b.pid = child.pid
  console.log(`[backend] ${b.name} spawned pid=${child.pid} port=${b.port} cwd=${b.cwd}`)
}

async function waitHealth(port, timeoutMs = 50000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetchJson(`http://127.0.0.1:${port}/global/health`, { timeout: 1200 })
      if (r.json?.healthy) return true
    } catch {}
    await new Promise((r) => setTimeout(r, 1000))
  }
  return false
}

function listListenPorts() {
  const ps = "Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | " +
    "Where-Object { $_.LocalAddress -in @('127.0.0.1','::1','0.0.0.0','::') } | " +
    "Select-Object -ExpandProperty LocalPort -Unique"
  const out = execFileSync("pwsh", ["-NoProfile", "-Command", ps], { encoding: "utf8", timeout: 20000 })
  return [...new Set(out.split(/\r?\n/).map((s) => parseInt(s, 10)).filter(Number.isFinite))]
}

async function discover() {
  const ports = listListenPorts().filter((p) => p !== MUX_PORT)
  const found = []
  await Promise.all(ports.map(async (p) => {
    try {
      const h = await fetchJson(`http://127.0.0.1:${p}/global/health`, { timeout: 800 })
      if (!h.json?.healthy) return
      const path = await fetchJson(`http://127.0.0.1:${p}/path`, { timeout: 1500 })
      found.push({ port: p, directory: path.json?.directory ?? null, version: h.json.version })
    } catch {}
  }))
  found.sort((a, b) => a.port - b.port)
  return found
}

function normDir(d) {
  return (d || "").toLowerCase().replace(/\\/g, "/").replace(/\/+$/, "")
}

function pickBackend(backends, directory) {
  if (!directory) return backends[0]
  const d = normDir(directory)
  let best = null
  for (const b of backends) {
    const bd = normDir(b.primaryDirectory)
    if (bd && (d === bd || d.startsWith(bd + "/"))) {
      if (!best || bd.length > normDir(best.primaryDirectory).length) best = b
    }
  }
  return best ?? backends[0]
}

function proxyRequest(req, res, target, u) {
  const headers = { ...req.headers }
  delete headers["host"]; delete headers["connection"]; delete headers["transfer-encoding"]
  const url = `http://127.0.0.1:${target.port}${u.pathname}${u.search}`
  const dir = req.headers["x-opencode-directory"] || "-"
  console.log(`[route] ${req.method} ${u.pathname}${u.search} dir=${dir} -> ${target.port}`)
  const upstream = http.request(url, { method: req.method, headers }, (up) => {
    const rh = { ...up.headers }
    rh["x-oat-backend"] = String(target.port)
    res.writeHead(up.statusCode || 502, rh)
    up.pipe(res)
  })
  upstream.on("error", (e) => { try { res.writeHead(502); res.end("oat proxy error: " + e.message) } catch {} })
  req.pipe(upstream)
}

async function handleSse(req, res, backends) {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" })
  res.write(": oat-mux ready\n\n")
  const controllers = []
  const tasks = backends.map(async (b) => {
    const ac = new AbortController()
    controllers.push(ac)
    try {
      const r = await fetch(`http://127.0.0.1:${b.port}/global/event`, { headers: { accept: "text/event-stream" }, signal: ac.signal })
      const dec = new TextDecoder()
      let buf = ""
      for await (const chunk of r.body) {
        buf += dec.decode(chunk, { stream: true })
        let idx
        while ((idx = buf.indexOf("\n\n")) !== -1) {
          const block = buf.slice(0, idx); buf = buf.slice(idx + 2)
          if (!block.trim()) continue
          if (!res.writableEnded) res.write(`: oat-backend=${b.port}\n${block}\n\n`)
        }
      }
    } catch {}
  })
  req.on("close", () => { for (const c of controllers) c.abort() })
  await Promise.allSettled(tasks)
}

function startMux(backends) {
  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, `http://127.0.0.1:${MUX_PORT}`)
    if (u.pathname === "/__oat/routes") {
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify(backends.map((b) => ({ port: b.port, directory: b.primaryDirectory, pid: b.pid })), null, 2))
      return
    }
    if (u.pathname === "/global/health") {
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ healthy: true, version: "oat-spike" }))
      return
    }
    if (u.pathname === "/global/event") { handleSse(req, res, backends); return }
    const raw = req.headers["x-opencode-directory"]
    proxyRequest(req, res, pickBackend(backends, Array.isArray(raw) ? raw[0] : raw), u)
  })
  server.listen(MUX_PORT, "127.0.0.1")
  return server
}

async function readSse(url, ms) {
  const ac = new AbortController()
  const t = setTimeout(() => ac.abort(), ms)
  const backends = new Set()
  let connected = 0
  try {
    const r = await fetch(url, { headers: { accept: "text/event-stream" }, signal: ac.signal })
    const dec = new TextDecoder()
    let buf = ""
    for await (const chunk of r.body) {
      buf += dec.decode(chunk, { stream: true })
      let idx
      while ((idx = buf.indexOf("\n\n")) !== -1) {
        const block = buf.slice(0, idx); buf = buf.slice(idx + 2)
        for (const line of block.split("\n")) {
          const m = line.match(/^: oat-backend=(\d+)/)
          if (m) backends.add(Number(m[1]))
          if (line.includes('"server.connected"')) connected++
        }
      }
    }
  } catch {}
  clearTimeout(t)
  return { backends: [...backends].sort((a, b) => a - b), connected }
}

async function main() {
  console.log("=== OAT spike: discovery + routing + SSE merge ===\n[1] starting two throwaway opencode servers")
  for (const b of BACKENDS) startBackend(b)

  const health = await Promise.all(BACKENDS.map((b) => waitHealth(b.port)))
  check("both throwaway servers healthy", health.every(Boolean), BACKENDS.map((b, i) => `${b.port}:${health[i]}`).join(" "))

  console.log("\n[2] discovering opencode servers on the machine")
  const servers = await discover()
  console.log("    discovered: " + JSON.stringify(servers))
  for (const b of BACKENDS) {
    const match = servers.find((s) => s.port === b.port)
    b.primaryDirectory = match?.directory ?? null
    check(`discovery found backend ${b.name} (${b.port})`, !!match, match?.directory ?? "not found")
  }

  console.log("\n[3] starting OAT mux on " + MUX_PORT)
  mux = startMux(BACKENDS)
  await new Promise((r) => setTimeout(r, 300))

  const routes = await fetchJson(`http://127.0.0.1:${MUX_PORT}/__oat/routes`)
  check("mux exposes discovered routes", Array.isArray(routes.json) && routes.json.length === 2, routes.text.replace(/\s+/g, " "))

  const mh = await fetchJson(`http://127.0.0.1:${MUX_PORT}/global/health`)
  check("mux /global/health answers locally", mh.json?.version === "oat-spike", JSON.stringify(mh.json))

  console.log("\n[4] routing by x-opencode-directory")
  for (const b of BACKENDS) {
    const r = await fetchJson(`http://127.0.0.1:${MUX_PORT}/path`, { headers: { "x-opencode-directory": b.cwd } })
    const via = r.headers.get("x-oat-backend")
    const ok = via === String(b.port) && normDir(r.json?.directory) === normDir(b.cwd)
    check(`dir ${b.name} -> backend ${b.port}`, ok, `via=${via} directory=${r.json?.directory}`)
  }

  const noHdr = await fetchJson(`http://127.0.0.1:${MUX_PORT}/path`)
  check("header-less request uses default backend", noHdr.headers.get("x-oat-backend") === String(BACKENDS[0].port), `via=${noHdr.headers.get("x-oat-backend")}`)

  console.log("\n[5] global (shared-DB) reads through the mux")
  const projects = await fetchJson(`http://127.0.0.1:${MUX_PORT}/project`, { timeout: 8000 })
  check("mux /project returns projects", Array.isArray(projects.json) && projects.json.length > 0, `count=${projects.json?.length}`)
  const sessions = await fetchJson(`http://127.0.0.1:${MUX_PORT}/experimental/session?roots=true`, { timeout: 15000 })
  check("mux /experimental/session returns global sessions", Array.isArray(sessions.json) && sessions.json.length > 0, `count=${sessions.json?.length}`)

  console.log("\n[6] SSE fan-in/merge (expect both backends)")
  const sse = await readSse(`http://127.0.0.1:${MUX_PORT}/global/event`, 6000)
  check("SSE merged from both backends", sse.backends.length === 2 && BACKENDS.every((b) => sse.backends.includes(b.port)), `sources=${sse.backends.join(",")} server.connected=${sse.connected}`)

  const passed = results.filter((r) => r.ok).length
  console.log(`\n=== RESULT: ${passed}/${results.length} checks passed ===`)
  return results.every((r) => r.ok) ? 0 : 1
}

try {
  const code = await main()
  teardown("done")
  clearTimeout(watchdog)
  process.exit(code)
} catch (e) {
  console.error("SPIKE ERROR:", e)
  teardown("error")
  clearTimeout(watchdog)
  process.exit(1)
}
