import fs from "node:fs";
import Fastify from "fastify";
import websocket from "@fastify/websocket";
import fastifyStatic from "@fastify/static";

import { config } from "./config.js";
import { ensureDeckDir } from "./util.js";
import { AUTH_TOKEN, isAllowedOrigin, tokenFromQuery, timingSafeEqual } from "./auth.js";
import { createSessionManager } from "./sessions.js";
import { createMetricsEngine } from "./metrics.js";
import { createUsagePoller } from "./usage.js";
import type { ClientMsg, ServerMsg } from "../shared/types.js";

const VERSION = "0.1.0";

await ensureDeckDir();

// ── Connected browser sockets, each with its set of attached session ids ──────
interface Client {
  send(msg: ServerMsg): void;
  attached: Set<string>;
}
const clients = new Set<Client>();

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

const usage = createUsagePoller({
  onUsage: (u) => broadcast({ t: "usage", usage: u }),
  intervalMs: config.usagePollMs,
});
usage.start();

// ── HTTP / WS server ──────────────────────────────────────────────────────────
const app = Fastify({ logger: false });
await app.register(websocket, { options: { maxPayload: 4 * 1024 * 1024 } });

// Same-origin frontend fetches the launch token here. Cross-origin pages can
// trigger this but cannot read the response (CORS); the WS Origin check is the
// real gate. See server/auth.ts.
app.get("/api/token", async () => ({ token: AUTH_TOKEN }));
app.get("/api/health", async () => ({ ok: true, version: VERSION }));

app.get("/ws", { websocket: true }, (socket, req) => {
  if (!isAllowedOrigin(req.headers.origin)) {
    socket.close(1008, "origin");
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

  client.send({ t: "hello", version: VERSION, sessions: sessions.list(), usage: usage.get() });

  socket.on("message", async (raw: Buffer) => {
    let msg: ClientMsg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    try {
      switch (msg.t) {
        case "open":
          await sessions.open(msg.cwd, { title: msg.title });
          break;
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
        case "resize":
          sessions.resize(msg.id, msg.cols, msg.rows);
          break;
        case "close":
          sessions.close(msg.id);
          break;
        case "refreshUsage":
          await usage.refreshNow();
          break;
      }
    } catch (err) {
      client.send({ t: "error", message: String((err as Error)?.message ?? err) });
    }
  });

  socket.on("close", () => clients.delete(client));
});

// Serve the built frontend in production (web/dist). In dev, Vite serves it.
if (fs.existsSync(config.paths.webDist)) {
  await app.register(fastifyStatic, { root: config.paths.webDist });
}

try {
  await app.listen({ host: config.host, port: config.port });
  const url = `http://${config.host}:${config.port}`;
  if (config.isProd) {
    // `npm start`: this process serves everything. Use 127.0.0.1 (not localhost)
    // — localhost may resolve to IPv6 ::1, but we bind IPv4 loopback.
    console.log(`\n  🎛️  cc-deck — open  ${url}\n`);
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
