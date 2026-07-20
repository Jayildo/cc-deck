// ── Pinned project quick-launch tabs ────────────────────────────────────────
// The tabs across the top open a fresh Claude Code session in a given folder.
//
// The list below is only EXAMPLES. To pin your own projects WITHOUT committing
// them (keeping your local paths/projects private), create a git-ignored file
//   web/src/quicktabs.local.ts
// exporting your own `QUICK_PROJECTS` (see quicktabs.local.example.ts). When it
// exists it overrides the examples below; on a fresh clone the examples show.

export interface QuickProject {
  emoji: string;
  label: string; // short name shown on the tab
  desc: string; // tooltip on hover
  path: string; // absolute path — the server launches claude here
}

const EXAMPLE_PROJECTS: QuickProject[] = [
  { emoji: "📁", label: "my-app", desc: "example — copy quicktabs.local.example.ts", path: "/Users/you/my-app" },
  { emoji: "🌐", label: "website", desc: "example — copy quicktabs.local.example.ts", path: "/Users/you/website" },
];

// Optional private override (git-ignored). Vite's glob resolves to `{}` when the
// file is absent, so a fresh clone falls back to the examples above without any
// build error.
const localModules = import.meta.glob<{ QUICK_PROJECTS?: QuickProject[] }>("./quicktabs.local.ts", {
  eager: true,
});
const localProjects = Object.values(localModules)[0]?.QUICK_PROJECTS;

export const QUICK_PROJECTS: QuickProject[] = localProjects ?? EXAMPLE_PROJECTS;

type OpenCb = (proj: QuickProject) => void;

export function initQuickTabs(el: HTMLElement, open: OpenCb): void {
  el.replaceChildren();
  for (const p of QUICK_PROJECTS) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "qtab";
    btn.title = `${p.path}\n${p.desc}`;

    const em = document.createElement("span");
    em.className = "qtab-emoji";
    em.textContent = p.emoji;

    const lb = document.createElement("span");
    lb.className = "qtab-label";
    lb.textContent = p.label;

    btn.append(em, lb);
    btn.addEventListener("click", () => open(p));
    el.appendChild(btn);
  }
}
