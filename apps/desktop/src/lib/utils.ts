export function formatMilliseconds(value: number | null | undefined): string {
  if (typeof value !== "number" || Number.isNaN(value) || value < 0) return "";
  const totalSeconds = Math.floor(value / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return hours > 0
    ? `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
    : `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

export function formatTimeRange(
  startMs: number | null | undefined,
  endMs: number | null | undefined,
  fallback?: string | null,
): string {
  const start = formatMilliseconds(startMs);
  const end = formatMilliseconds(endMs);
  if (start && end) return `${start} - ${end}`;
  return start || end || fallback?.trim() || "";
}
