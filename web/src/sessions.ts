import type { SessionMeta, SessionMetrics } from "../../shared/types";
import { fmtNum } from "./fmt.js";
import { send } from "./ws.js";

type SelectCb = (id: string) => void;

let sessions: SessionMeta[] = [];
const metricsMap = new Map<string, SessionMetrics>();
let selectedId: string | null = null;
let listEl: HTMLElement;
let onSelect: SelectCb;

export function initSessions(el: HTMLElement, cb: SelectCb): void {
  listEl = el;
  onSelect = cb;
}

export function updateSessions(list: SessionMeta[]): void {
  sessions = list;
  renderAll();
}

export function updateSessionMetrics(m: SessionMetrics): void {
  metricsMap.set(m.id, m);
  patchRow(m.id);
}

export function setSelectedSession(id: string): void {
  selectedId = id;
  renderAll();
}

// ── Rendering ─────────────────────────────────────────────────────────────────

const DOT_CLASS: Record<string, string> = {
  starting: "dot dot-starting",
  active: "dot dot-active",
  idle: "dot dot-idle",
  exited: "dot dot-exited",
};

function renderAll(): void {
  listEl.innerHTML = "";
  for (const s of sessions) {
    listEl.appendChild(buildRow(s));
  }
}

function patchRow(id: string): void {
  const existing = listEl.querySelector<HTMLElement>(`[data-sid="${id}"]`);
  const s = sessions.find((x) => x.id === id);
  if (!s || !existing) return;
  existing.replaceWith(buildRow(s));
}

function buildRow(s: SessionMeta): HTMLElement {
  const m = metricsMap.get(s.id);
  const pct = m?.contextPct ?? 0;
  const total = m ? fmtNum(m.cumulative.total) : "—";
  const dotClass = DOT_CLASS[s.status] ?? "dot";
  const isSelected = s.id === selectedId;

  const el = document.createElement("div");
  el.className = `session-row${isSelected ? " selected" : ""}`;
  el.setAttribute("data-sid", s.id);
  el.innerHTML = `
    <div class="row-header">
      <span class="${dotClass}"></span>
      <span class="row-title">${esc(s.title)}</span>
      <span class="row-tokens">${total}</span>
      <button class="close-btn" title="Close">×</button>
    </div>
    <div class="ctx-track"><div class="ctx-fill" style="width:${pct}%;${fillColor(pct)}"></div></div>
  `;

  el.querySelector(".close-btn")?.addEventListener("click", (e) => {
    e.stopPropagation();
    send({ t: "close", id: s.id });
  });
  el.addEventListener("click", () => onSelect(s.id));

  return el;
}

function fillColor(pct: number): string {
  if (pct >= 80) return "background:#ef4444";
  if (pct >= 50) return "background:#f59e0b";
  return "background:#22c55e";
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
