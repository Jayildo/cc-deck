import type { SessionMeta, SessionMetrics } from "../../shared/types";
import { fmtNum } from "./fmt.js";
import { send } from "./ws.js";

type SelectCb = (id: string) => void;

let sessions: SessionMeta[] = [];
const metricsMap = new Map<string, SessionMetrics>();
let selectedId: string | null = null;
let cursorId: string | null = null; // keyboard-nav highlight (separate from selected)
let listEl: HTMLElement;
let onSelect: SelectCb;
let onEnter: SelectCb;

export function initSessions(el: HTMLElement, select: SelectCb, enter: SelectCb): void {
  listEl = el;
  onSelect = select;
  onEnter = enter;
  listEl.tabIndex = 0; // focusable so it can own keyboard navigation
  listEl.addEventListener("keydown", onKeydown);
}

// ── Keyboard navigation ─────────────────────────────────────────────────────────
// The sidebar and terminal swap DOM focus; whichever is focused owns the keys.
// While the list is focused: ↑/↓ move the cursor, Enter dives into that session.

function onKeydown(e: KeyboardEvent): void {
  if (e.key === "ArrowDown") {
    e.preventDefault();
    moveCursor(1);
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    moveCursor(-1);
  } else if (e.key === "Enter") {
    e.preventDefault();
    if (cursorId) onEnter(cursorId);
  }
}

function scrollCursorIntoView(): void {
  if (!cursorId) return;
  listEl.querySelector<HTMLElement>(`[data-sid="${cursorId}"]`)?.scrollIntoView({ block: "nearest" });
}

function moveCursor(delta: number): void {
  if (!sessions.length) return;
  const cur = sessions.findIndex((s) => s.id === cursorId);
  const next = Math.max(0, Math.min(sessions.length - 1, (cur < 0 ? 0 : cur) + delta));
  cursorId = sessions[next]!.id;
  renderAll();
  scrollCursorIntoView();
}

/** Enter keyboard-nav mode: focus the list and put the cursor on the active row. */
export function focusSidebar(): void {
  cursorId =
    selectedId && sessions.some((s) => s.id === selectedId) ? selectedId : (sessions[0]?.id ?? null);
  renderAll();
  listEl.focus();
  scrollCursorIntoView();
}

/** Drop the keyboard-nav highlight (e.g. when focus moves into the terminal). */
export function clearCursor(): void {
  if (cursorId === null) return;
  cursorId = null;
  renderAll();
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

// 3-state activity indicator (replaces the old context-% bar). Driven by
// SessionMetrics.activity, which the server derives from the latest transcript
// turn; lifecycle status (exited / pre-first-turn) takes precedence.
const ACTIVITY: Record<string, { cls: string; label: string }> = {
  working: { cls: "act-working", label: "작동 중" },
  "awaiting-choice": { cls: "act-choice", label: "선택 요청" },
  done: { cls: "act-done", label: "완료" },
};

function activityView(s: SessionMeta, m: SessionMetrics | undefined): { cls: string; label: string } {
  if (s.status === "exited") return { cls: "act-exited", label: "종료" };
  const a = m?.activity;
  if (a && ACTIVITY[a]) return ACTIVITY[a]!;
  return { cls: "act-idle", label: "대기" }; // starting / before the first prompt
}

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
  const c = m?.cumulative;
  const total = c ? fmtNum(c.total) : "—";
  // Most of "total" is loaded/cached context, not generated text. Surface the
  // real breakdown on hover so the number isn't mistaken for "work done".
  const tip = c
    ? `생성(output) ${c.output.toLocaleString()} · 입력 ${c.input.toLocaleString()} · ` +
      `캐시생성 ${c.cacheCreation.toLocaleString()} · 캐시읽기 ${c.cacheRead.toLocaleString()}\n` +
      `대부분 프로젝트 컨텍스트(CLAUDE.md·rules·도구) 로드분`
    : "토큰 사용량";
  const dotClass = DOT_CLASS[s.status] ?? "dot";
  const act = activityView(s, m);
  const isSelected = s.id === selectedId;
  const isCursor = s.id === cursorId;

  const el = document.createElement("div");
  el.className = `session-row${isSelected ? " selected" : ""}${isCursor ? " cursor" : ""}`;
  el.setAttribute("data-sid", s.id);
  el.innerHTML = `
    <div class="row-header">
      <span class="${dotClass}"></span>
      <span class="row-title">${esc(s.title)}</span>
      <span class="row-tokens" title="${esc(tip)}">${total}</span>
      <button class="close-btn" title="Close">×</button>
    </div>
    <div class="act ${act.cls}"><span class="act-led"></span><span class="act-label">${act.label}</span></div>
  `;

  el.querySelector(".close-btn")?.addEventListener("click", (e) => {
    e.stopPropagation();
    send({ t: "close", id: s.id });
  });
  el.addEventListener("click", () => {
    cursorId = s.id; // clicking also parks the keyboard cursor here
    onSelect(s.id);
  });

  return el;
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
