import type { AccountUsage } from "../../shared/types";
import { fmtDuration } from "./fmt.js";

// Track reset times so the countdown ticker can refresh them.
let resetsAt5h: string | undefined;
let resetsAt7d: string | undefined;
let countdownTimer: ReturnType<typeof setInterval> | null = null;

export function renderUsage(u: AccountUsage): void {
  resetsAt5h = u.fiveHour.resetsAt;
  resetsAt7d = u.sevenDay.resetsAt;

  setBar("bar5h", "pct5h", u.fiveHour.pct);
  setBar("bar7d", "pct7d", u.sevenDay.pct);

  el("plan-badge").textContent = u.plan ?? "";

  const srcEl = el("source-badge");
  if (u.error) {
    srcEl.textContent = u.error;
    srcEl.className = "badge badge-red";
  } else if (u.stale) {
    srcEl.textContent = "stale";
    srcEl.className = "badge badge-amber";
  } else {
    srcEl.textContent = u.source;
    srcEl.className = "badge badge-gray";
  }

  tickCountdown();
  if (!countdownTimer) {
    countdownTimer = setInterval(tickCountdown, 1000);
  }
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

function tickCountdown(): void {
  const cdEl = el("reset-countdown");
  const now = Date.now();
  const candidates: number[] = [];
  for (const r of [resetsAt5h, resetsAt7d]) {
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
