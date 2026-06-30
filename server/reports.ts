import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { config } from "./config.js";
import { projectLabel } from "./util.js";

const REPORTS_DIR = path.join(config.paths.deckDir, "reports");
const SUMMARY_MODEL = "claude-sonnet-4-6";
const MAX_PROJECTS = 10;

interface ProjectDay {
  cwd: string;
  label: string;
  gitBranch?: string;
  commits: string[];
  prompts: string[];
  filesTouched: string[];
  toolCounts: Record<string, number>;
  sessionCount: number;
}

// ── date helpers (local time) ────────────────────────────────────────────────
function startOfTodayMs(): number {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}
function dateStrOf(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function hhmm(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

// ── extraction ───────────────────────────────────────────────────────────────
function extractUserText(r: any): string {
  let text = "";
  const c = r?.message?.content;
  if (typeof c === "string") text = c;
  else if (Array.isArray(c)) text = c.filter((b: any) => b?.type === "text").map((b: any) => b.text).join(" ");
  return text
    .replace(/<local-command[^>]*>[\s\S]*?<\/local-command-[a-z]+>/gi, "")
    .replace(/<command-[a-z]+>[\s\S]*?<\/command-[a-z]+>/gi, "")
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function gitCommitsToday(cwd: string, dayStartMs: number): Promise<string[]> {
  return new Promise((resolve) => {
    execFile(
      "git",
      ["-C", cwd, "log", "--since", new Date(dayStartMs).toISOString(), "--no-merges", "--pretty=format:%h %s"],
      { timeout: 8000, windowsHide: true },
      (err, stdout) => {
        if (err || !stdout) return resolve([]);
        resolve(stdout.split("\n").map((s) => s.trim()).filter(Boolean).slice(0, 30));
      }
    );
  });
}

async function gatherToday(dayStartMs: number): Promise<ProjectDay[]> {
  const byCwd = new Map<string, ProjectDay>();
  let dirs: string[];
  try {
    dirs = await fsp.readdir(config.paths.projectsDir);
  } catch {
    return [];
  }

  for (const dir of dirs) {
    const dirPath = path.join(config.paths.projectsDir, dir);
    let files: string[];
    try {
      files = await fsp.readdir(dirPath);
    } catch {
      continue;
    }
    for (const f of files) {
      if (!f.endsWith(".jsonl")) continue;
      const fp = path.join(dirPath, f);
      try {
        if ((await fsp.stat(fp)).mtimeMs < dayStartMs) continue; // not touched today
      } catch {
        continue;
      }

      let content: string;
      try {
        content = await fsp.readFile(fp, "utf8");
      } catch {
        continue;
      }

      const records: any[] = [];
      let cwd: string | undefined;
      let branch: string | undefined;
      for (const line of content.split("\n")) {
        if (!line.trim()) continue;
        let r: any;
        try {
          r = JSON.parse(line);
        } catch {
          continue;
        }
        if (r.cwd && !cwd) {
          cwd = r.cwd;
          branch = r.gitBranch;
        }
        records.push(r);
      }
      // Skip cc-deck's own report-summary sessions (recursion noise) and the
      // home dir (not a project).
      const cwdNorm = cwd ? cwd.replace(/\\/g, "/").toLowerCase().replace(/\/+$/, "") : "";
      const homeNorm = config.paths.home.replace(/\\/g, "/").toLowerCase().replace(/\/+$/, "");
      if (!cwd || cwdNorm.includes("/.cc-deck") || cwdNorm === homeNorm) continue;

      const today = records.filter((r) => r.timestamp && Date.parse(r.timestamp) >= dayStartMs);
      if (!today.length) continue;

      const key = cwd.toLowerCase();
      let pd = byCwd.get(key);
      if (!pd) {
        pd = { cwd, label: projectLabel(cwd), gitBranch: branch, commits: [], prompts: [], filesTouched: [], toolCounts: {}, sessionCount: 0 };
        byCwd.set(key, pd);
      }
      pd.sessionCount++;

      for (const r of today) {
        if (r.type === "user") {
          const t = extractUserText(r);
          if (t && pd.prompts.length < 25) pd.prompts.push(t.slice(0, 240));
        } else if (r.type === "assistant" && Array.isArray(r.message?.content)) {
          for (const b of r.message.content) {
            if (b?.type === "tool_use") {
              pd.toolCounts[b.name] = (pd.toolCounts[b.name] ?? 0) + 1;
              const fpath = b.input?.file_path ?? b.input?.path ?? b.input?.notebook_path;
              if (typeof fpath === "string" && pd.filesTouched.length < 40 && !pd.filesTouched.includes(fpath)) {
                pd.filesTouched.push(fpath);
              }
            }
          }
        }
      }
    }
  }

  const out = [...byCwd.values()];
  for (const p of out) p.commits = await gitCommitsToday(p.cwd, dayStartMs);
  out.sort((a, b) => b.commits.length + b.prompts.length - (a.commits.length + a.prompts.length));
  return out;
}

// ── digest + prompt ──────────────────────────────────────────────────────────
function buildDigest(p: ProjectDay): string {
  const L: string[] = [];
  L.push(`프로젝트: ${p.label} — ${p.cwd}${p.gitBranch ? ` (branch ${p.gitBranch})` : ""}`);
  L.push(`세션 수: ${p.sessionCount}`, "");
  L.push("[오늘 git 커밋]");
  L.push(p.commits.length ? p.commits.map((c) => `- ${c}`).join("\n") : "- (없음)", "");
  L.push("[오늘 요청한 작업(프롬프트)]");
  L.push(p.prompts.length ? p.prompts.slice(0, 15).map((s) => `- ${s}`).join("\n") : "- (없음)", "");
  if (p.filesTouched.length) {
    L.push("[변경된 파일]", p.filesTouched.slice(0, 40).map((f) => `- ${f}`).join("\n"), "");
  }
  const tools = Object.entries(p.toolCounts).map(([k, v]) => `${k}×${v}`).join(", ");
  if (tools) L.push(`[도구 사용] ${tools}`);
  return L.join("\n");
}

function reportPrompt(date: string, label: string, digest: string): string {
  return [
    `너는 개발 업무일지 작성 보조다. 아래는 ${date}에 '${label}' 프로젝트에서 진행한 작업 기록(git 커밋·요청 프롬프트·변경 파일·도구 사용)이다.`,
    `이걸 바탕으로 굵직한 일일 업무일지를 한국어로 작성하라.`,
    ``,
    `출력 형식(마크다운, 아래 헤더부터 바로 시작):`,
    `### ${label}`,
    `- **한 일**: 핵심 3~5개를 굵직하게 불릿으로`,
    `- **주요 변경/결정**: 있으면`,
    `- **이슈/막힌 점**: 있으면`,
    `- **다음**: 기록상 분명할 때만`,
    ``,
    `규칙: 기록에 있는 사실만 쓴다. 추측·과장·미사여구 금지. 커밋·프롬프트를 근거로 묶는다. 간결하게. 형식 외 잡담/머리말 금지.`,
    ``,
    `[작업 기록]`,
    digest,
  ].join("\n");
}

function summarize(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    let out = "";
    let err = "";
    const child = spawn("claude", ["-p", "--model", SUMMARY_MODEL, "--output-format", "text"], {
      shell: true,
      windowsHide: true,
      cwd: config.paths.deckDir, // neutral cwd → no heavy project context
    });
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* noop */
      }
      resolve("_(요약 시간 초과)_");
    }, 120_000);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", () => {
      clearTimeout(timer);
      resolve("_(요약 실패: claude CLI 실행 불가)_");
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve(code === 0 && out.trim() ? out.trim() : `_(요약 실패${err ? ": " + err.slice(0, 160) : ""})_`);
    });
    child.stdin.write(prompt);
    child.stdin.end();
  });
}

function assemble(date: string, projects: ProjectDay[], sections: string[]): string {
  let md = `# 📋 일일 업무일지 — ${date}\n\n_생성 ${hhmm(Date.now())} · cc-deck · ${projects.length}개 프로젝트_\n\n`;
  if (!projects.length) return md + "오늘 기록된 작업이 없습니다.\n";
  md += sections.join("\n\n");
  md += "\n\n---\n\n<details><summary>원시 활동 데이터</summary>\n\n";
  for (const p of projects) {
    md += `**${p.label}** \`${p.cwd}\` — 세션 ${p.sessionCount} · 커밋 ${p.commits.length} · 프롬프트 ${p.prompts.length}\n`;
    if (p.commits.length) md += p.commits.map((c) => `  - \`${c}\``).join("\n") + "\n";
  }
  return md + "\n</details>\n";
}

// ── public API ───────────────────────────────────────────────────────────────
let generating = false;

export async function generateDailyReport(
  onProgress?: (text: string) => void
): Promise<{ date: string; path: string; markdown: string }> {
  if (generating) throw new Error("이미 리포트를 생성 중입니다");
  generating = true;
  try {
    await fsp.mkdir(REPORTS_DIR, { recursive: true });
    const dayStart = startOfTodayMs();
    const date = dateStrOf(dayStart);
    onProgress?.("오늘 작업 수집 중…");
    const projects = (await gatherToday(dayStart)).slice(0, MAX_PROJECTS);

    const sections: string[] = [];
    for (let i = 0; i < projects.length; i++) {
      const p = projects[i]!;
      onProgress?.(`요약 중 (${i + 1}/${projects.length}): ${p.label}`);
      sections.push(await summarize(reportPrompt(date, p.label, buildDigest(p))));
    }

    const markdown = assemble(date, projects, sections);
    const outPath = path.join(REPORTS_DIR, `${date}.md`);
    await fsp.writeFile(outPath, markdown, "utf8");
    onProgress?.(`완료 — ${projects.length}개 프로젝트`);
    return { date, path: outPath, markdown };
  } finally {
    generating = false;
  }
}

export function listReports(): string[] {
  try {
    return fs
      .readdirSync(REPORTS_DIR)
      .filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f))
      .map((f) => f.slice(0, -3))
      .sort()
      .reverse();
  } catch {
    return [];
  }
}

export async function getReport(date: string): Promise<string | null> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null; // guard path traversal
  try {
    return await fsp.readFile(path.join(REPORTS_DIR, `${date}.md`), "utf8");
  } catch {
    return null;
  }
}

/** Run `fn` once per day at the given local HH:MM. Returns a stop function. */
export function startReportScheduler(at: string, fn: () => void): () => void {
  const [h, m] = at.split(":").map(Number);
  let lastRun = "";
  const timer = setInterval(() => {
    const now = new Date();
    if (now.getHours() === h && now.getMinutes() === m) {
      const today = dateStrOf(now.getTime());
      if (lastRun !== today) {
        lastRun = today;
        fn();
      }
    }
  }, 30_000);
  return () => clearInterval(timer);
}
