import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import Fastify from "fastify";
import websocket from "@fastify/websocket";
import fastifyStatic from "@fastify/static";

import { config } from "./config.js";
import { ensureDeckDir, claudeVersionWarning } from "./util.js";
import { AUTH_TOKEN, isAllowedOrigin, tokenFromQuery, timingSafeEqual } from "./auth.js";
import { createSessionManager } from "./sessions.js";
import { createMetricsEngine } from "./metrics.js";
import { createUsagePoller } from "./usage.js";
import { createProjectStore } from "./projects.js";
import { generateDailyReport, listReports, getReport, startReportScheduler } from "./reports.js";
import type { ClientMsg, ServerMsg } from "../shared/types.js";

const VERSION = "0.1.0";

await ensureDeckDir();

// ── Connected browser sockets, each with its set of attached session ids ──────
interface Client {
  send(msg: ServerMsg): void;
  attached: Set<string>;
}
const clients = new Set<Client>();

// If the installed Claude Code differs from the version the permission-prompt
// detector was verified against, we warn the user (a toast) so a silently-rotted
// detector never reads as "cc-deck is broken". Computed once, off the boot path
// (claude --version can take ~1s through a login shell), then pushed to clients.
let claudeWarn: string | null = null;

// Monotonic suffix so same-name files dropped in the same millisecond don't collide.
let dropSeq = 0;

function broadcast(msg: ServerMsg): void {
  for (const c of clients) c.send(msg);
}
function sendToAttached(id: string, msg: ServerMsg): void {
  for (const c of clients) if (c.attached.has(id)) c.send(msg);
}

// ── Backend modules (handler-injection: callbacks fan out to sockets) ─────────
const metrics = createMetricsEngine({
  onMetrics: (m) => broadcast({ t: "metrics", metrics: m }),
});

const sessions = createSessionManager({
  onData: (id, data) => sendToAttached(id, { t: "pty", id, data }),
  onSessions: (list) => {
    for (const meta of list) metrics.track(meta);
    broadcast({ t: "sessions", sessions: list });
  },
  onExit: (id, code) => {
    metrics.untrack(id);
    broadcast({ t: "exit", id, code });
  },
});

// Compute the Claude Code version warning once, off the boot path so a slow
// `claude --version` never delays server start. Push to anyone already connected.
setTimeout(() => {
  try {
    claudeWarn = claudeVersionWarning();
    if (claudeWarn) {
      console.warn("[cc-deck]", claudeWarn);
      broadcast({ t: "error", message: claudeWarn });
    }
  } catch (err) {
    console.error("[cc-deck] version check failed (non-fatal):", err);
  }
}, 100);

const usage = createUsagePoller({
  onUsage: (u) => broadcast({ t: "usage", usage: u }),
  intervalMs: config.usagePollMs,
});
usage.start();

const projects = createProjectStore();

// ── Daily report ──────────────────────────────────────────────────────────────
let reportBusy = false;
async function runReport(): Promise<void> {
  if (reportBusy) {
    broadcast({ t: "reportStatus", text: "이미 생성 중…", busy: true });
    return;
  }
  reportBusy = true;
  broadcast({ t: "reportStatus", text: "리포트 생성 시작…", busy: true });
  try {
    const r = await generateDailyReport((text) => broadcast({ t: "reportStatus", text, busy: true }));
    broadcast({ t: "reports", dates: listReports() });
    broadcast({ t: "report", date: r.date, markdown: r.markdown });
    broadcast({ t: "reportStatus", text: `완료 — ${r.date}`, busy: false });
  } catch (err) {
    broadcast({ t: "reportStatus", text: `실패: ${String((err as Error)?.message ?? err)}`, busy: false });
  } finally {
    reportBusy = false;
  }
}
const stopReportScheduler = startReportScheduler(config.reportTime, () => void runReport());

// ── HTTP / WS server ──────────────────────────────────────────────────────────
const app = Fastify({ logger: false });
// 16 MB so a pasted screenshot (base64 ≈ 1.33× its bytes) fits in one frame.
await app.register(websocket, { options: { maxPayload: 16 * 1024 * 1024 } });

// Loopback-only guard. We bind dual-stack (::) so both http://localhost (IPv6
// ::1) and http://127.0.0.1 (IPv4) reach the server, but we reject any non-
// loopback peer — the dual-stack socket would otherwise be LAN-reachable and
// /api/token is unauthenticated. Keeps cc-deck "a shell behind a token", local.
function isLoopback(ip: string | undefined): boolean {
  if (!ip) return false;
  return ip === "::1" || ip === "::ffff:127.0.0.1" || ip.startsWith("127.");
}
app.addHook("onRequest", (req, reply, done) => {
  if (!isLoopback(req.socket.remoteAddress ?? undefined)) {
    reply.code(403).send({ error: "cc-deck is loopback-only" });
    return;
  }
  done();
});

// Same-origin frontend fetches the launch token here. Cross-origin pages can
// trigger this but cannot read the response (CORS); the WS Origin check is the
// real gate. See server/auth.ts.
app.get("/api/token", async () => ({ token: AUTH_TOKEN }));
app.get("/api/health", async () => ({ ok: true, version: VERSION }));

app.get("/ws", { websocket: true }, async (socket, req) => {
  if (!isAllowedOrigin(req.headers.origin)) {
    socket.close(1008, "origin");
    return;
  }
  if (!isLoopback(req.socket.remoteAddress ?? undefined)) {
    socket.close(1008, "loopback");
    return;
  }
  const token = tokenFromQuery(req.url);
  if (!token || !timingSafeEqual(token, AUTH_TOKEN)) {
    socket.close(1008, "auth");
    return;
  }

  const client: Client = {
    attached: new Set(),
    send: (msg) => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(msg));
    },
  };
  clients.add(client);

  client.send({
    t: "hello",
    version: VERSION,
    sessions: sessions.list(),
    usage: usage.get(),
    projects: await projects.lists(),
  });
  // Surface the CLI-version warning (if any) as a toast on every page load.
  if (claudeWarn) client.send({ t: "error", message: claudeWarn });

  socket.on("message", async (raw: Buffer) => {
    let msg: ClientMsg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    try {
      switch (msg.t) {
        case "open": {
          const meta = await sessions.open(msg.cwd, { title: msg.title });
          // Tell just this client which session it opened so it can auto-select
          // it. The "sessions" broadcast fired inside open() already added the
          // row; this arrives after, so the row exists by the time we select it.
          client.send({ t: "opened", id: meta.id });
          await projects.noteOpened(msg.cwd);
          broadcast({ t: "projects", projects: await projects.lists() });
          break;
        }
        case "attach": {
          client.attached.add(msg.id);
          const a = sessions.attach(msg.id);
          if (a) client.send({ t: "scrollback", id: msg.id, data: a.scrollback });
          const m = metrics.get(msg.id);
          if (m) client.send({ t: "metrics", metrics: m });
          break;
        }
        case "input":
          sessions.input(msg.id, msg.data);
          break;
        case "pasteImage": {
          // Browser terminals can't hand a pasted image bitmap to the PTY, so
          // the frontend ships us the bytes; we save them and type the file
          // path into the session (no CR → doesn't submit). Forward slashes so
          // the Windows path doesn't collide with Claude Code's "\"+Enter.
          const okExt = ["png", "jpg", "jpeg", "gif", "webp"];
          const ext = okExt.includes(msg.ext) ? msg.ext : "png";
          await fsp.mkdir(config.paths.pasteDir, { recursive: true });
          const file = path.join(config.paths.pasteDir, `paste-${Date.now()}.${ext}`);
          await fsp.writeFile(file, Buffer.from(msg.dataB64, "base64"));
          sessions.input(msg.id, file.replace(/\\/g, "/") + " ");
          break;
        }
        case "dropFile": {
          // OS drag-and-drop: the browser hands us the file's bytes but never
          // its real path (security), so — like pasteImage — we save the bytes
          // and type the saved path into the session. We keep the original file
          // name (readable for Claude) and add a counter so concurrent drops of
          // the same name don't clobber each other.
          const raw = path.basename(msg.name).replace(/[^\w.\-]+/g, "_") || "file";
          const ext = path.extname(raw);
          const stem = ext ? raw.slice(0, -ext.length) : raw;
          await fsp.mkdir(config.paths.pasteDir, { recursive: true });
          const file = path.join(config.paths.pasteDir, `${stem}-${Date.now()}-${dropSeq++}${ext}`);
          await fsp.writeFile(file, Buffer.from(msg.dataB64, "base64"));
          sessions.input(msg.id, file.replace(/\\/g, "/") + " ");
          break;
        }
        case "resize":
          sessions.resize(msg.id, msg.cols, msg.rows);
          break;
        case "close":
          sessions.close(msg.id);
          break;
        case "refreshUsage":
          await usage.refreshNow();
          break;
        case "listProjects":
          client.send({ t: "projects", projects: await projects.lists() });
          break;
        case "addFavorite":
          await projects.addFavorite(msg.path);
          broadcast({ t: "projects", projects: await projects.lists() });
          break;
        case "removeFavorite":
          await projects.removeFavorite(msg.path);
          broadcast({ t: "projects", projects: await projects.lists() });
          break;
        case "listReports":
          client.send({ t: "reports", dates: listReports() });
          break;
        case "getReport": {
          const md = await getReport(msg.date);
          if (md != null) client.send({ t: "report", date: msg.date, markdown: md });
          break;
        }
        case "generateReport":
          void runReport();
          break;
      }
    } catch (err) {
      client.send({ t: "error", message: String((err as Error)?.message ?? err) });
    }
  });

  socket.on("close", () => clients.delete(client));
});

// Pasted/dropped files pile up in pasteDir over time. Sweep anything older than
// a week — the path was already typed into a session long ago, so old copies are
// dead weight. Runs at startup and once a day after.
const PASTE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
async function cleanupPasteDir(): Promise<void> {
  try {
    const dir = config.paths.pasteDir;
    const names = await fsp.readdir(dir).catch(() => [] as string[]);
    const cutoff = Date.now() - PASTE_TTL_MS;
    await Promise.all(
      names.map(async (name) => {
        const p = path.join(dir, name);
        try {
          const st = await fsp.stat(p);
          if (st.isFile() && st.mtimeMs < cutoff) await fsp.rm(p, { force: true });
        } catch {
          // file vanished / race — ignore
        }
      }),
    );
  } catch {
    // dir missing or unreadable — nothing to clean
  }
}
void cleanupPasteDir();
const pasteCleanupTimer = setInterval(() => void cleanupPasteDir(), 24 * 60 * 60 * 1000);
pasteCleanupTimer.unref?.(); // don't keep the process alive just for the sweep

// Serve the built frontend in production (web/dist). In dev, Vite serves it.
if (fs.existsSync(config.paths.webDist)) {
  await app.register(fastifyStatic, { root: config.paths.webDist });
}

try {
  // Dual-stack loopback so both localhost (::1) and 127.0.0.1 work; the
  // onRequest guard above keeps non-loopback peers out.
  await app.listen({ host: "::", port: config.port, ipv6Only: false });
  const url = `http://localhost:${config.port}`;
  if (config.isProd) {
    console.log(`\n  🎛️  cc-deck — open  ${url}   (or http://127.0.0.1:${config.port})\n`);
  } else {
    // `npm run dev`: open the Vite dev server; it proxies API + WS to this backend.
    console.log(`\n  🎛️  cc-deck backend on ${url}`);
    console.log(`     open the dev frontend → http://localhost:5273\n`);
  }
} catch (err) {
  console.error("Failed to start cc-deck:", err);
  process.exit(1);
}

function shutdown() {
  usage.stop();
  stopReportScheduler();
  sessions.dispose();
  metrics.dispose();
  app.close().finally(() => process.exit(0));
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// Backstop: a PTY can fail asynchronously inside a node-pty worker thread (ConPTY
// error codes) and rethrow as an uncaughtException. One bad session must not take
// down the server and every other live session.
process.on("uncaughtException", (err) => {
  console.error("[cc-deck] uncaughtException (server kept alive):", err);
});
process.on("unhandledRejection", (reason) => {
  console.error("[cc-deck] unhandledRejection (server kept alive):", reason);
});
