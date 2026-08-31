import type { AccountUsage } from "../../shared/types";
import { fmtAge, fmtDuration } from "./fmt.js";

// Documented coupling: 3x the server's default poll interval
// (server/config.ts usagePollMs, env CC_DECK_USAGE_POLL_MS, default 60s). WS
// frames stop arriving the moment the socket drops, so we need our own
// clock-side signal that the on-screen numbers are aging. Raising
// CC_DECK_USAGE_POLL_MS above ~3 min leaves this panel permanently amber.
const STALE_AFTER_MS = 3 * 60_000;

// Store-and-paint: renderUsage only updates `latest`; the 1s countdown ticker
// (already running for the reset countdown) is reused to repaint everything,
// so numbers keep aging correctly even while the WS is down and no new frame
// arrives.
let latest: AccountUsage | null = null;
let countdownTimer: ReturnType<typeof setInterval> | null = null;

export function renderUsage(u: AccountUsage): void {
  latest = u;
  paint();
  if (!countdownTimer) {
    countdownTimer = setInterval(paint, 1000);
  }
}

/** A window whose reset time has already passed isn't merely old — the server
 *  hasn't rolled it over yet, so its last pct is invalid, not just stale. */
function rolled(resetsAt: string | undefined): boolean {
  return !!resetsAt && new Date(resetsAt).getTime() <= Date.now();
}

function paint(): void {
  const u = latest;
  if (!u) return;

  // updatedAt === 0 (the NONE sentinel: numbers never received) means age is
  // unknown, not 20000+ days — never subtract from it.
  const age = u.updatedAt > 0 ? Date.now() - u.updatedAt : 0;
  const stale = u.stale || (u.updatedAt > 0 && age > STALE_AFTER_MS);

  setBar("bar5h", "pct5h", stale && rolled(u.fiveHour.resetsAt) ? undefined : u.fiveHour.pct);
  setBar("bar7d", "pct7d", stale && rolled(u.sevenDay.resetsAt) ? undefined : u.sevenDay.pct);

  el("plan-badge").textContent = u.plan ?? "";
  el("usage-windows").classList.toggle("stale", stale);

  const srcEl = el("source-badge");
  const ageTxt = u.updatedAt > 0 ? fmtAge(age) : "";
  if (u.error) {
    srcEl.textContent = ageTxt ? `${u.error} · ${ageTxt}` : u.error;
    srcEl.className = u.needsLogin ? "badge badge-red" : "badge badge-amber";
  } else if (stale) {
    srcEl.textContent = ageTxt || u.source;
    srcEl.className = "badge badge-amber";
  } else {
    srcEl.textContent = u.source;
    srcEl.className = "badge badge-gray";
  }
  srcEl.title = u.needsLogin
    ? "터미널에서 claude 를 실행해 다시 로그인하세요"
    : u.error
      ? "계정은 정상이고 cc-deck의 사용량 조회만 막힌 상태입니다. claude 세션이 한 번 실행되면 1분 안에 자동 복구됩니다"
      : u.updatedAt > 0
        ? `${u.source} · ${new Date(u.updatedAt).toLocaleString()}`
        : u.source;

  tickCountdown(u);
}

function setBar(fillId: string, txtId: string, pct: number | undefined): void {
  const fill = el(fillId) as HTMLElement;
  const txt = el(txtId);
  if (pct == null) {
    txt.textContent = "—";
    fill.style.width = "0%";
    fill.className = "bar-fill";
    return;
  }
  const capped = Math.min(100, pct);
  fill.style.width = `${capped}%`;
  txt.textContent = `${Math.round(pct)}%`;
  fill.className = `bar-fill ${pct >= 80 ? "red" : pct >= 50 ? "amber" : "green"}`;
}

function tickCountdown(u: AccountUsage): void {
  const cdEl = el("reset-countdown");
  const now = Date.now();
  const candidates: number[] = [];
  for (const r of [u.fiveHour.resetsAt, u.sevenDay.resetsAt]) {
    if (!r) continue;
    const diff = new Date(r).getTime() - now;
    if (diff > 0) candidates.push(diff);
  }
  if (candidates.length === 0) {
    cdEl.textContent = "";
    return;
  }
  const min = candidates.reduce((a, b) => (a < b ? a : b));
  cdEl.textContent = `resets in ${fmtDuration(min)}`;
}

function el(id: string): HTMLElement {
  return document.getElementById(id) as HTMLElement;
}
