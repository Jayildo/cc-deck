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
  // Expose the arrow-key list as a real listbox so screen readers announce it as a
  // set of selectable options and report which one is active (aria-activedescendant,
  // set per-render). Rows carry role=option + aria-selected.
  listEl.setAttribute("role", "listbox");
  listEl.setAttribute("aria-label", "세션 목록");
  listEl.setAttribute("aria-orientation", "vertical");
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
  // Same for cached metrics, or metricsMap grows by every session ever opened.
  for (const id of metricsMap.keys()) if (!live.has(id)) metricsMap.delete(id);
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

// Reconcile the DOM list against `sessions` IN PLACE — update the rows that stayed,
// insert new ones, remove gone ones — instead of tearing the whole list down. The old
// `innerHTML = ""` rebuild recreated every node on every sessions/selection/cursor
// tick, which restarted each row's CSS blink at 0%; so one session's trivial change
// visibly interrupted the 완료/응답/승인 blink of all the others. Reusing nodes lets a
// blink keep its phase — the animation only (re)starts when a row's attention class
// actually changes, which is exactly a genuinely new event.
function renderAll(): void {
  const existing = new Map<string, HTMLElement>();
  for (const el of Array.from(listEl.children) as HTMLElement[]) {
    const sid = el.getAttribute("data-sid");
    if (sid) existing.set(sid, el);
  }
  // Remove rows for gone sessions FIRST so the survivors line up with `ref` in the
  // pass below and aren't needlessly moved: removing a middle row late would leave it
  // occupying a slot, forcing every row after it through insertBefore — and a move
  // restarts that row's blink even though nothing about it actually changed.
  const live = new Set(sessions.map((s) => s.id));
  for (const [sid, el] of existing) {
    if (!live.has(sid)) {
      el.remove();
      existing.delete(sid);
    }
  }
  let ref: Node | null = listEl.firstChild;
  for (const s of sessions) {
    let el = existing.get(s.id);
    if (el) {
      updateRow(el, s);
    } else {
      el = buildRow(s);
    }
    if (el === ref) {
      ref = el.nextSibling; // already in the right slot — advance past it
    } else {
      listEl.insertBefore(el, ref); // new row, or a reordered one, moved into place
    }
  }
  // Keep the listbox's active descendant on the keyboard-cursor row, but only while
  // that session still exists — otherwise clear it, so we never point at a removed
  // node (a dangling IDREF loses the active option for screen readers). Stale cursorId
  // self-heals on the next moveCursor/focusSidebar.
  if (cursorId != null && live.has(cursorId))
    listEl.setAttribute("aria-activedescendant", `session-opt-${cursorId}`);
  else listEl.removeAttribute("aria-activedescendant");
}

// A single session's metrics changed — patch just its row, in place (see renderAll).
function patchRow(id: string): void {
  const el = listEl.querySelector<HTMLElement>(`[data-sid="${id}"]`);
  const s = sessions.find((x) => x.id === id);
  if (s && el) updateRow(el, s);
}

// Build a row's stable skeleton once; all per-render values are filled by updateRow
// so the node can be reused across renders without restarting its animations.
function buildRow(s: SessionMeta): HTMLElement {
  const el = document.createElement("div");
  el.setAttribute("data-sid", s.id);
  el.id = `session-opt-${s.id}`;
  el.setAttribute("role", "option");
  el.innerHTML = `
    <div class="row-header">
      <span data-dot></span>
      <span class="row-title"></span>
      <span class="row-tokens"></span>
      <button class="close-btn" title="Close" aria-label="세션 닫기" tabindex="-1">×</button>
    </div>
    <div data-act><span class="act-led"></span><span class="act-label"></span></div>
  `;
  el.querySelector(".close-btn")?.addEventListener("click", (e) => {
    e.stopPropagation();
    send({ t: "close", id: s.id });
  });
  el.addEventListener("click", () => {
    cursorId = s.id; // clicking also parks the keyboard cursor here
    onSelect(s.id);
  });
  updateRow(el, s);
  return el;
}

// Update a row's mutable state in place, touching only what actually changed, so an
// unchanged (still-blinking) row is left completely alone and its animation phase
// survives. Text is written via textContent / the title property, so there's no
// HTML-injection surface — no manual escaping needed.
function updateRow(el: HTMLElement, s: SessionMeta): void {
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

  // Row blinks for attention until acknowledged: choice ("응답 필요", blue) · finished
  // ("완료", green). The blink stops once the row is selected once (`acked`) and stays
  // off until a new attention event; working sessions never blink. A permission block
  // ("승인 대기", red) is EXEMPT — the session is halted until the user acts, so it keeps
  // blinking until it clears. Only the row-level blink; the badge is unaffected. (.row-* CSS)
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

  const cls = `session-row${isSelected ? " selected" : ""}${isCursor ? " cursor" : ""}${attnClass}`;
  if (el.className !== cls) el.className = cls; // reassigning the same class list would restart the blink
  el.setAttribute("aria-selected", String(isSelected));

  const dotEl = el.querySelector<HTMLElement>("[data-dot]")!;
  if (dotEl.className !== dotClass) dotEl.className = dotClass;

  const titleEl = el.querySelector<HTMLElement>(".row-title")!;
  if (titleEl.textContent !== s.title) titleEl.textContent = s.title;

  const tokEl = el.querySelector<HTMLElement>(".row-tokens")!;
  if (tokEl.textContent !== total) tokEl.textContent = total;
  if (tokEl.title !== tip) tokEl.title = tip;

  const actEl = el.querySelector<HTMLElement>("[data-act]")!;
  const actCls = `act ${act.cls}`;
  if (actEl.className !== actCls) actEl.className = actCls;
  const labelEl = actEl.querySelector<HTMLElement>(".act-label")!;
  if (labelEl.textContent !== act.label) labelEl.textContent = act.label;
}
