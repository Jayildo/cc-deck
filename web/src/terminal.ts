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
let onBack: (() => void) | null = null; // Alt+← in the terminal → back to the sidebar

export function initTerminalContainer(el: HTMLElement, back?: () => void): void {
  container = el;
  onBack = back ?? null;
  new ResizeObserver(() => scheduleFit()).observe(el);
  // Intercept image pastes in the capture phase, before xterm's text-paste
  // handler. Text pastes fall through untouched.
  container.addEventListener("paste", (e) => void handlePaste(e as ClipboardEvent), true);
}

const MIME_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => {
      const s = r.result as string; // "data:<mime>;base64,<payload>"
      resolve(s.slice(s.indexOf(",") + 1));
    };
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

// A clipboard image can't ride the PTY byte stream, so ship the bytes to the
// server, which saves the file and types its path into the active session.
async function handlePaste(e: ClipboardEvent): Promise<void> {
  const items = e.clipboardData?.items;
  if (!items || !activeId) return;
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (!item) continue;
    if (item.kind === "file" && item.type.startsWith("image/")) {
      e.preventDefault();
      e.stopPropagation();
      const blob = item.getAsFile();
      if (!blob) return;
      const ext = MIME_EXT[item.type] ?? "png";
      send({ t: "pasteImage", id: activeId, ext, dataB64: await blobToBase64(blob) });
      return;
    }
  }
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

  // Ctrl+Enter → newline in the prompt (matches the native terminal). The
  // browser doesn't forward Ctrl+Enter as a usable byte sequence, so we
  // intercept it and write LF ourselves; returning false stops xterm from
  // emitting CR (which would submit the prompt).
  term.attachCustomKeyEventHandler((ev) => {
    if (ev.type !== "keydown") return true;
    // Ctrl+Enter → newline (see above).
    if (ev.key === "Enter" && ev.ctrlKey && !ev.shiftKey && !ev.altKey && !ev.metaKey) {
      send({ t: "input", id, data: "\n" });
      return false;
    }
    // Alt+← → hand focus back to the sidebar for keyboard navigation.
    if (ev.key === "ArrowLeft" && ev.altKey && !ev.ctrlKey && !ev.shiftKey && !ev.metaKey) {
      ev.preventDefault(); // don't let the browser navigate back
      onBack?.();
      return false;
    }
    return true;
  });

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

/** Move keyboard focus into the active terminal so the user can type. */
export function focusTerminal(): void {
  if (activeId) terms.get(activeId)?.term.focus();
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
