import type { SessionMeta, SessionMetrics } from "../../shared/types";
import { fmtNum } from "./fmt.js";
import { send } from "./ws.js";

type SelectCb = (id: string) => void;

let sessions: SessionMeta[] = [];
const metricsMap = new Map<string, SessionMetrics>();
let selectedId: string | null = null;
let cursorId: string | null = null; // keyboard-nav highlight (separate from selected)
// Sessions whose CURRENT attention state (완료 / 응답 필요 / 승인 대기) the user has
// already seen — value = the acknowledged activity. A row blinks for attention only
// until it's acknowledged (selected once), and re-arms when the session leaves that
// state (a new working turn) so a genuinely new event blinks again.
const acked = new Map<string, string>();
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
  } else if (e.key === "Delete") {
    e.preventDefault();
    closeCursored();
  }
}

/** Del — close the cursored session (same as its × button) and park the cursor on
 *  a neighbour so keyboard nav keeps working after the row disappears. */
function closeCursored(): void {
  if (!cursorId) return;
  const idx = sessions.findIndex((s) => s.id === cursorId);
  if (idx < 0) return;
  const neighbour = sessions[idx + 1] ?? sessions[idx - 1];
  const closing = cursorId;
  cursorId = neighbour ? neighbour.id : null;
  send({ t: "close", id: closing });
  renderAll(); // move the cursor ring immediately; the row clears on the server's sessions update
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

/**
 * Return the session id `delta` steps from the currently selected one (clamped
 * at both ends). Used by the global Shift+Arrow shortcut to hop between sessions
 * without going back to the sidebar first.
 */
export function siblingSession(delta: number): string | null {
  if (!sessions.length) return null;
  const cur = sessions.findIndex((s) => s.id === selectedId);
  const base = cur < 0 ? 0 : cur;
  const next = Math.max(0, Math.min(sessions.length - 1, base + delta));
  return sessions[next]?.id ?? null;
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
  // Drop acknowledgements for sessions that no longer exist so the map can't grow
  // unbounded across a long-lived dashboard.
  const live = new Set(list.map((s) => s.id));
  for (const id of acked.keys()) if (!live.has(id)) acked.delete(id);
  renderAll();
}

export function updateSessionMetrics(m: SessionMetrics): void {
  metricsMap.set(m.id, m);
  // Blinks are reserved for attention events the user hasn't seen yet. Re-arm when
  // the session leaves its attention state (a new working turn) so its NEXT
  // 완료/응답/승인 alerts again; and auto-acknowledge the state on the row the user
  // is already viewing (selected), so it won't blink after they navigate away.
  const s = sessions.find((x) => x.id === m.id);
  const st = s ? attnStateOf(s, m) : null;
  if (st === null) acked.delete(m.id);
  else if (m.id === selectedId) acked.set(m.id, st);
  patchRow(m.id);
}

export function setSelectedSession(id: string): void {
  selectedId = id;
  acknowledge(id); // seeing a session clears its attention blink until a new event
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
  working: { cls: "act-working", label: "진행 중" },
  "awaiting-choice": { cls: "act-choice", label: "응답 필요" },
  done: { cls: "act-done", label: "완료" },
};

function activityView(s: SessionMeta, m: SessionMetrics | undefined): { cls: string; label: string } {
  if (s.status === "exited") return { cls: "act-exited", label: "종료" };
  const a = m?.activity;
  // A menu on the terminal (awaitingPermission, PTY-derived) is the most urgent
  // user gate. But the structural detector also fires on ordinary choice prompts;
  // when the transcript already knows it's a choice (AskUserQuestion/plan), keep
  // the precise blue "선택 요청" — otherwise it's a permission prompt → red.
  if (s.awaitingPermission) {
    if (a === "awaiting-choice") return ACTIVITY["awaiting-choice"]!;
    return { cls: "act-permission", label: "승인 대기" };
  }
  if (a && ACTIVITY[a]) return ACTIVITY[a]!;
  return { cls: "act-idle", label: "대기" }; // starting / before the first prompt
}

// The attention state a row blinks for (완료 / 응답 필요 / 승인 대기), or null when the
// session isn't asking for the user — same mapping the badge uses.
function attnFromCls(cls: string): string | null {
  switch (cls) {
    case "act-permission":
      return "permission";
    case "act-done":
      return "done";
    case "act-choice":
      return "awaiting-choice";
    default:
      return null;
  }
}

function attnStateOf(s: SessionMeta, m: SessionMetrics | undefined): string | null {
  return attnFromCls(activityView(s, m).cls);
}

// Mark a session's current attention state as seen, so its row stops blinking even
// after you navigate away. No-op when the session isn't in an attention state.
function acknowledge(id: string): void {
  const s = sessions.find((x) => x.id === id);
  if (!s) return;
  const st = attnStateOf(s, metricsMap.get(id));
  if (st) acked.set(id, st);
  else acked.delete(id);
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

  // Mark sessions that need the user so the row blinks for attention until it's
  // acknowledged: choice ("응답 필요", blue) · finished ("완료", green). The blink stops
  // once the row has been selected once (`acked`) and stays off until a new
  // attention event; working sessions never blink. A permission block ("승인 대기",
  // red) is EXEMPT — the session is halted until the user acts, so it keeps blinking
  // until it clears (never silenced by acknowledgement). The activity badge itself
  // is unaffected — only the row-level blink. (see .row-* CSS)
  const attn = attnFromCls(act.cls);
  const blink =
    attn !== null && !isSelected && (attn === "permission" || acked.get(s.id) !== attn);
  const attnClass = !blink
    ? ""
    : attn === "permission"
      ? " row-permission"
      : attn === "done"
        ? " row-done"
        : " row-choice";
  const el = document.createElement("div");
  el.className =
    `session-row${isSelected ? " selected" : ""}${isCursor ? " cursor" : ""}${attnClass}`;
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
