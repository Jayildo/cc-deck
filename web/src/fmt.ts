/** 1234 -> "1.2k", 1_200_000 -> "1.2M", 999 -> "999" */
export function fmtNum(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

/** Milliseconds -> "2h13m" / "5m07s" / "42s" */
export function fmtDuration(ms: number): string {
  if (ms <= 0) return "now";
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  if (h > 0) return `${h}h${String(m % 60).padStart(2, "0")}m`;
  if (m > 0) return `${m}m${String(s % 60).padStart(2, "0")}s`;
  return `${s}s`;
}

/** Elapsed ms -> "방금" / "12분 전" / "3시간 전" / "2일 전" */
export function fmtAge(ms: number): string {
  const m = Math.floor(ms / 60_000);
  if (m < 1) return "방금";
  if (m < 60) return `${m}분 전`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}시간 전`;
  return `${Math.floor(h / 24)}일 전`;
}

/** Strip "claude-" prefix from a model id for compact display. */
export function shortModel(model: string | undefined): string {
  if (!model) return "—";
  return model.replace(/^claude-/, "");
}
