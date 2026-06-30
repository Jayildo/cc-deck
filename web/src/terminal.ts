import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { send } from "./ws.js";

interface TermEntry {
  term: Terminal;
  fit: FitAddon;
  el: HTMLElement;
}

const terms = new Map<string, TermEntry>();
let activeId: string | null = null;
let container: HTMLElement;
let rafId: number | null = null;

export function initTerminalContainer(el: HTMLElement): void {
  container = el;
  new ResizeObserver(() => scheduleFit()).observe(el);
}

function scheduleFit(): void {
  if (rafId !== null) cancelAnimationFrame(rafId);
  rafId = requestAnimationFrame(() => {
    rafId = null;
    doFit();
  });
}

function doFit(): void {
  if (!activeId) return;
  const entry = terms.get(activeId);
  if (!entry) return;
  try {
    entry.fit.fit();
    const { cols, rows } = entry.term;
    send({ t: "resize", id: activeId, cols, rows });
  } catch {
    // not yet visible or zero dimensions
  }
}

function makeEntry(id: string): TermEntry {
  const term = new Terminal({
    theme: {
      background: "#0e0e10",
      foreground: "#e4e4e7",
      cursor: "#a1a1aa",
      selectionBackground: "#3f3f46",
    },
    fontSize: 13,
    fontFamily: '"Cascadia Code", "Fira Code", "JetBrains Mono", ui-monospace, monospace',
    scrollback: 5000,
    cursorBlink: true,
  });
  const fit = new FitAddon();
  term.loadAddon(fit);

  const el = document.createElement("div");
  el.className = "xterm-wrap";
  el.style.display = "none";
  container.appendChild(el);
  term.open(el);

  term.onData((data) => send({ t: "input", id, data }));

  return { term, fit, el };
}

function getOrCreate(id: string): TermEntry {
  let entry = terms.get(id);
  if (!entry) {
    entry = makeEntry(id);
    terms.set(id, entry);
  }
  return entry;
}

export function write(id: string, data: string): void {
  getOrCreate(id).term.write(data);
}

export function activate(id: string): void {
  if (activeId && activeId !== id) {
    const prev = terms.get(activeId);
    if (prev) prev.el.style.display = "none";
  }
  const entry = getOrCreate(id);
  entry.el.style.display = "block";
  activeId = id;
  scheduleFit();
}

export function getActiveId(): string | null {
  return activeId;
}

export function terminalIds(): string[] {
  return [...terms.keys()];
}

export function disposeTerminal(id: string): void {
  const entry = terms.get(id);
  if (!entry) return;
  entry.term.dispose();
  entry.el.remove();
  terms.delete(id);
  if (activeId === id) activeId = null;
}
