import fsp from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";
import { readJsonSafe, projectLabel } from "./util.js";
import type { ProjectLists, ProjectRef } from "../shared/types.js";

const FAV_FILE = path.join(config.paths.deckDir, "favorites.json");
const RECENTS_FILE = path.join(config.paths.deckDir, "recents.json");
const MAX_RECENT = 5;

interface DeckRecent {
  path: string;
  lastUsed: number;
}

/** Case-insensitive, slash-normalized key for de-duping the same folder. */
function normKey(p: string): string {
  return p.replace(/[\\/]+/g, "\\").replace(/\\+$/, "").toLowerCase();
}

export interface ProjectStore {
  lists(): Promise<ProjectLists>;
  addFavorite(p: string): Promise<void>;
  removeFavorite(p: string): Promise<void>;
  /** Record a freshly-opened cwd into cc-deck's own recents. */
  noteOpened(p: string): Promise<void>;
}

export function createProjectStore(): ProjectStore {
  const readFavorites = async (): Promise<string[]> =>
    (await readJsonSafe<string[]>(FAV_FILE)) ?? [];

  const writeFavorites = (list: string[]): Promise<void> =>
    fsp.writeFile(FAV_FILE, JSON.stringify(list, null, 2), "utf8");

  const readDeckRecents = async (): Promise<DeckRecent[]> =>
    (await readJsonSafe<DeckRecent[]>(RECENTS_FILE)) ?? [];

  // Recents harvested from Claude Code's own session registry — these hold the
  // EXACT cwd of every recent session (so we sidestep the lossy slug decode).
  async function claudeRecents(): Promise<DeckRecent[]> {
    let files: string[];
    try {
      files = await fsp.readdir(config.paths.sessionsDir);
    } catch {
      return [];
    }
    const out: DeckRecent[] = [];
    for (const f of files) {
      if (!f.endsWith(".json")) continue;
      const j = await readJsonSafe<{ cwd?: string; updatedAt?: number; startedAt?: number }>(
        path.join(config.paths.sessionsDir, f)
      );
      if (j?.cwd) out.push({ path: j.cwd, lastUsed: j.updatedAt ?? j.startedAt ?? 0 });
    }
    return out;
  }

  async function lists(): Promise<ProjectLists> {
    const favPaths = await readFavorites();
    const favSet = new Set(favPaths.map(normKey));
    const homeKey = normKey(config.paths.home); // the home dir isn't a "project"

    // Merge cc-deck's own opens with Claude's recents; newest wins per folder.
    const merged = new Map<string, DeckRecent>();
    for (const r of [...(await readDeckRecents()), ...(await claudeRecents())]) {
      const k = normKey(r.path);
      const ex = merged.get(k);
      if (!ex || r.lastUsed > ex.lastUsed) merged.set(k, { path: r.path, lastUsed: r.lastUsed });
    }

    const favorites: ProjectRef[] = favPaths.map((p) => ({
      path: p,
      label: projectLabel(p),
      favorite: true,
    }));

    const recent: ProjectRef[] = [...merged.values()]
      .filter((r) => !favSet.has(normKey(r.path)) && normKey(r.path) !== homeKey)
      .sort((a, b) => b.lastUsed - a.lastUsed)
      .slice(0, MAX_RECENT)
      .map((r) => ({ path: r.path, label: projectLabel(r.path), lastUsed: r.lastUsed }));

    return { favorites, recent };
  }

  async function addFavorite(p: string): Promise<void> {
    const list = await readFavorites();
    if (!list.some((x) => normKey(x) === normKey(p))) {
      list.push(p);
      await writeFavorites(list);
    }
  }

  async function removeFavorite(p: string): Promise<void> {
    await writeFavorites((await readFavorites()).filter((x) => normKey(x) !== normKey(p)));
  }

  async function noteOpened(p: string): Promise<void> {
    const list = (await readDeckRecents()).filter((x) => normKey(x.path) !== normKey(p));
    list.unshift({ path: p, lastUsed: Date.now() });
    await fsp.writeFile(RECENTS_FILE, JSON.stringify(list.slice(0, 30), null, 2), "utf8");
  }

  return { lists, addFavorite, removeFavorite, noteOpened };
}
