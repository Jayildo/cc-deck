import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { send } from "./ws.js";
import { THEMES, DEFAULT_THEME, type ThemeName } from "./themes.js";

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
let onNotify: ((msg: string) => void) | null = null;

// The <html data-theme> attribute is stamped before this module loads (see
// the anti-flash script in index.html), so reading it here picks up
// whatever the user last selected — newly-created terminals then open
// already themed, no extra wiring needed on the caller's side.
function readInitialTheme(): ThemeName {
  const t = document.documentElement.dataset.theme as ThemeName | undefined;
  return t && THEMES[t] ? t : DEFAULT_THEME;
}
let activeThemeName: ThemeName = readInitialTheme();

const MAX_PASTE_BYTES = 11 * 1024 * 1024; // base64 ≈ 1.37× → stays under the 16MB WS maxPayload

export function initTerminalContainer(el: HTMLElement, back?: () => void, notify?: (msg: string) => void): void {
  container = el;
  onBack = back ?? null;
  onNotify = notify ?? null;
  new ResizeObserver(() => scheduleFit()).observe(el);
  // Intercept image pastes in the capture phase, before xterm's text-paste
  // handler. Text pastes fall through untouched.
  container.addEventListener("paste", (e) => void handlePaste(e as ClipboardEvent), true);

  // Drag-and-drop of files from the OS (Finder/Explorer). The browser only
  // gives us the bytes, never the real path, so we ship the bytes to the server
  // and it types the saved path into the session — same trick as pasteImage.
  container.addEventListener("dragover", (e) => {
    if (!dragHasContent(e)) return; // ignore drags with nothing we can insert
    e.preventDefault(); // required so the "drop" event fires (else the browser opens/navigates)
    if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    container.classList.add("drag-over");
  }, true);
  container.addEventListener("dragleave", (e) => {
    // Only clear when the pointer actually left the container (dragleave also
    // fires when moving onto child elements).
    if (!container.contains(e.relatedTarget as Node | null)) container.classList.remove("drag-over");
  }, true);
  container.addEventListener("drop", (e) => void handleDrop(e as DragEvent), true);
}

// True when the drag carries something we can drop into a terminal: OS files, or
// plain text / a URL (dragged from a browser, editor, etc.) — like a native
// terminal, which inserts dragged text as-is and dragged files as their path.
function dragHasContent(e: DragEvent): boolean {
  if (!e.dataTransfer) return false;
  const types = Array.from(e.dataTransfer.types);
  return types.includes("Files") || types.includes("text/uri-list") || types.includes("text/plain");
}

async function handleDrop(e: DragEvent): Promise<void> {
  const dt = e.dataTransfer;
  if (!dt) return;
  const hasFiles = Array.from(dt.types).includes("Files");
  // getData is only valid synchronously inside the drop event — read it now,
  // before any await. Prefer a real URL (uri-list) over its plain-text echo.
  const text = hasFiles ? "" : (dt.getData("text/uri-list") || dt.getData("text/plain"));
  if (!hasFiles && !text) return;
  e.preventDefault();
  e.stopPropagation();
  container.classList.remove("drag-over");
  const id = activeId; // snapshot: the async loop below must not chase a session switch
  if (!id) {
    onNotify?.("먼저 세션을 선택한 뒤 놓아주세요");
    return;
  }
  if (!hasFiles) {
    send({ t: "input", id, data: text }); // dragged text/link → inserted verbatim (no CR)
    return;
  }
  const files = Array.from(dt.files ?? []);
  for (const file of files) {
    if (file.size > MAX_PASTE_BYTES) {
      onNotify?.(`"${file.name}"이(가) 너무 커서 건너뜀 (최대 ~11MB)`);
      continue;
    }
    send({ t: "dropFile", id, name: file.name, dataB64: await blobToBase64(file) });
  }
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
      if (blob.size > MAX_PASTE_BYTES) {
        onNotify?.("이미지가 너무 커서 붙여넣지 못했습니다 (최대 ~11MB)");
        return;
      }
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
    theme: THEMES[activeThemeName].xterm,
    fontSize: 13,
    fontFamily: '"Cascadia Code", "Fira Code", "JetBrains Mono", ui-monospace, monospace',
    scrollback: 5000,
    cursorBlink: true,
    // Treat the macOS ⌥ (Option) key as Meta, so Option-combos send the
    // ESC-prefixed sequences Claude Code's line editor expects (word motion,
    // word delete, …) instead of typing accented characters.
    macOptionIsMeta: true,
  });
  const fit = new FitAddon();
  term.loadAddon(fit);

  const el = document.createElement("div");
  el.className = "xterm-wrap";
  el.style.display = "none";
  container.appendChild(el);
  term.open(el);

  term.onData((data) => send({ t: "input", id, data }));

  // Keyboard shortcuts that the browser/xterm would otherwise mishandle. Each
  // intercepted combo writes the exact bytes Claude Code expects and returns
  // false so xterm doesn't also act on the key. (See 단축키.txt.)
  term.attachCustomKeyEventHandler((ev) => {
    if (ev.type !== "keydown") return true;

    // Ctrl+Enter / ⌥+Enter → newline in the prompt (don't submit). The browser
    // doesn't forward these as a usable byte sequence, so we write LF ourselves.
    if (ev.key === "Enter" && (ev.ctrlKey || ev.altKey) && !ev.shiftKey && !ev.metaKey) {
      send({ t: "input", id, data: "\n" });
      return false;
    }

    // ⌥ (Option) word-editing, matching a native macOS terminal. Emit the
    // canonical readline meta sequences so Claude Code's line editor gets them
    // regardless of how it parses modified arrows:
    //   ⌥+←  backward one word   ⌥+→  forward one word   ⌥+⌫  delete prev word
    if (ev.altKey && !ev.ctrlKey && !ev.metaKey && !ev.shiftKey) {
      if (ev.key === "ArrowLeft") { ev.preventDefault(); send({ t: "input", id, data: "\x1bb" }); return false; }
      if (ev.key === "ArrowRight") { ev.preventDefault(); send({ t: "input", id, data: "\x1bf" }); return false; }
      if (ev.key === "Backspace") { ev.preventDefault(); send({ t: "input", id, data: "\x1b\x7f" }); return false; }
    }

    // Shift+Arrow → session hop, handled by the global listener in main.ts. Let
    // it through (return false) so xterm doesn't treat it as a text-selection.
    if (
      ev.shiftKey && !ev.ctrlKey && !ev.altKey && !ev.metaKey &&
      (ev.key === "ArrowUp" || ev.key === "ArrowDown" || ev.key === "ArrowLeft" || ev.key === "ArrowRight")
    ) {
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

/** Clear a terminal (screen + scrollback) before a full scrollback replay. */
export function resetTerminal(id: string): void {
  getOrCreate(id).term.reset();
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

/** Switch every live terminal to `name`'s xterm palette; new terminals opened
 *  afterwards pick it up too, since makeEntry() reads activeThemeName. */
export function setTerminalsTheme(name: ThemeName): void {
  if (!THEMES[name]) return;
  activeThemeName = name;
  const theme = THEMES[name].xterm;
  for (const { term } of terms.values()) {
    term.options.theme = theme;
  }
}

export function disposeTerminal(id: string): void {
  const entry = terms.get(id);
  if (!entry) return;
  entry.term.dispose();
  entry.el.remove();
  terms.delete(id);
  if (activeId === id) activeId = null;
}
