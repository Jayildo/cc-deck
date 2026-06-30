import { send } from "./ws.js";

let modal: HTMLElement;
let datesEl: HTMLElement;
let contentEl: HTMLElement;
let statusEl: HTMLElement;
let genBtn: HTMLButtonElement;
let dates: string[] = [];

export function initReports(): void {
  modal = document.getElementById("report-modal") as HTMLElement;
  datesEl = document.getElementById("report-dates") as HTMLElement;
  contentEl = document.getElementById("report-content") as HTMLElement;
  statusEl = document.getElementById("report-status") as HTMLElement;
  genBtn = document.getElementById("report-gen-btn") as HTMLButtonElement;
  const openBtn = document.getElementById("report-btn") as HTMLButtonElement;
  const closeBtn = document.getElementById("report-close") as HTMLButtonElement;

  openBtn.addEventListener("click", () => {
    modal.classList.remove("hidden");
    send({ t: "listReports" });
  });
  closeBtn.addEventListener("click", () => modal.classList.add("hidden"));
  genBtn.addEventListener("click", () => send({ t: "generateReport" }));
  modal.addEventListener("click", (e) => {
    if (e.target === modal) modal.classList.add("hidden");
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !modal.classList.contains("hidden")) modal.classList.add("hidden");
  });
}

export function setReports(ds: string[]): void {
  dates = ds;
  renderDates();
}

export function showReport(date: string, markdown: string): void {
  contentEl.textContent = markdown;
  contentEl.scrollTop = 0;
  for (const b of datesEl.querySelectorAll<HTMLElement>(".report-date")) {
    b.classList.toggle("active", b.dataset.date === date);
  }
}

export function setReportStatus(text: string, busy: boolean): void {
  statusEl.textContent = text;
  genBtn.disabled = busy;
}

function renderDates(): void {
  datesEl.replaceChildren();
  if (!dates.length) {
    const d = document.createElement("div");
    d.className = "report-empty";
    d.textContent = "아직 리포트 없음";
    datesEl.appendChild(d);
    return;
  }
  for (const date of dates) {
    const b = document.createElement("button");
    b.className = "report-date";
    b.textContent = date;
    b.dataset.date = date;
    b.addEventListener("click", () => send({ t: "getReport", date }));
    datesEl.appendChild(b);
  }
}
