// Template for private quick-launch tabs.
//
// Copy this file to `quicktabs.local.ts` (git-ignored) and put your real
// projects there. That file overrides the EXAMPLE_PROJECTS in quicktabs.ts, so
// your local paths and project names never get committed.
//
//   cp web/src/quicktabs.local.example.ts web/src/quicktabs.local.ts
//   # edit it, then: npm run build && npm run restart
import type { QuickProject } from "./quicktabs";

const HOME = "/Users/you";

export const QUICK_PROJECTS: QuickProject[] = [
  { emoji: "📊", label: "my-app", desc: "my main app", path: `${HOME}/my-app` },
  { emoji: "🌐", label: "website", desc: "marketing site", path: `${HOME}/website` },
];
