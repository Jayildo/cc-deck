import type { ClientMsg, ServerMsg } from "../../shared/types";

type MsgHandler = (msg: ServerMsg) => void;

let ws: WebSocket | null = null;
const handlers: MsgHandler[] = [];
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

export function onMessage(fn: MsgHandler): void {
  handlers.push(fn);
}

export function send(msg: ClientMsg): void {
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

async function open(): Promise<void> {
  try {
    const resp = await fetch("/api/token");
    const { token } = (await resp.json()) as { token: string };
    const proto = location.protocol === "https:" ? "wss" : "ws";
    ws = new WebSocket(`${proto}://${location.host}/ws?token=${token}`);

    ws.addEventListener("message", (ev) => {
      try {
        const msg = JSON.parse(ev.data as string) as ServerMsg;
        for (const h of handlers) h(msg);
      } catch {
        // ignore unparseable frames
      }
    });

    ws.addEventListener("close", scheduleReconnect);
  } catch {
    // Server down / token fetch failed before a socket existed → no "close" event
    // will ever fire, so we must schedule the retry ourselves or reconnection dies.
    scheduleReconnect();
  }
}

function scheduleReconnect(): void {
  if (reconnectTimer !== null) clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => void open(), 3000);
}

export async function connect(): Promise<void> {
  await open();
}
