import type { ProjectLists, ProjectRef } from "../../shared/types";
import { send } from "./ws.js";

let pickerEl: HTMLElement | null = null;
let onPick: ((path: string) => void) | null = null;
let current: ProjectLists = { favorites: [], recent: [] };

export function initProjectPicker(el: HTMLElement, pick: (path: string) => void): void {
  pickerEl = el;
  onPick = pick;
  render();
}

export function updateProjects(lists: ProjectLists | undefined): void {
  // Tolerate an older server (or a partial frame) that omits projects.
  current = lists ?? { favorites: [], recent: [] };
  render();
}

function row(ref: ProjectRef, isFav: boolean): HTMLElement {
  const div = document.createElement("div");
  div.className = "pick-row";

  const star = document.createElement("button");
  star.className = "pick-star" + (isFav ? " on" : "");
  star.textContent = isFav ? "★" : "☆";
  star.title = isFav ? "Remove favorite" : "Add favorite";
  star.addEventListener("click", (e) => {
    e.stopPropagation();
    send(isFav ? { t: "removeFavorite", path: ref.path } : { t: "addFavorite", path: ref.path });
  });

  const main = document.createElement("div");
  main.className = "pick-main";
  main.title = ref.path;
  const label = document.createElement("span");
  label.className = "pick-label";
  label.textContent = ref.label;
  const pathEl = document.createElement("span");
  pathEl.className = "pick-path";
  pathEl.textContent = ref.path;
  main.append(label, pathEl);
  main.addEventListener("click", () => onPick?.(ref.path));

  div.append(star, main);
  return div;
}

function section(title: string, refs: ProjectRef[], isFav: boolean): HTMLElement | null {
  if (!refs.length) return null;
  const wrap = document.createElement("div");
  wrap.className = "pick-section";
  const head = document.createElement("div");
  head.className = "pick-head";
  head.textContent = title;
  wrap.appendChild(head);
  for (const r of refs) wrap.appendChild(row(r, isFav));
  return wrap;
}

function render(): void {
  if (!pickerEl) return;
  pickerEl.replaceChildren();
  const fav = section("★ Favorites", current.favorites, true);
  const rec = section("Recent", current.recent, false);
  if (fav) pickerEl.appendChild(fav);
  if (rec) pickerEl.appendChild(rec);
  if (!fav && !rec) {
    const empty = document.createElement("div");
    empty.className = "pick-empty";
    empty.textContent = "No recent projects yet — type a path above.";
    pickerEl.appendChild(empty);
  }
}
