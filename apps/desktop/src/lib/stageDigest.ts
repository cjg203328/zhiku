import { API_BASE_URL } from "./api";
import { normalizeReadableChinese, splitReadableParagraphs } from "./readableNote";

export type ParsedNoteScreenshot = {
  id: string;
  timestampMs: number | null;
  timestampSeconds: number | null;
  timestampLabel: string;
  rangeLabel: string;
  imageUrl: string;
  seekUrl: string | null;
  caption: string;
  sourceText: string;
};

export type StageDigestSeed = {
  id: string;
  eyebrow?: string;
  title: string;
  summary: string;
  href?: string | null;
};

type StageDigestSeedInput =
  | string
  | {
      id?: string;
      eyebrow?: string;
      title?: string;
      summary?: string;
      href?: string | null;
    };

type StageDigestSeedBuildOptions = {
  idPrefix: string;
  eyebrowPrefix?: string;
  titlePrefix?: string;
  limit?: number;
};

export type StageDigestCard = {
  id: string;
  eyebrow: string;
  title: string;
  summary: string;
  href: string | null;
  imageUrl: string;
  imageAlt: string;
  badge: string;
};

function readNumber(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function resolveAssetUrl(value: string) {
  const cleaned = value.trim();
  if (!cleaned) return "";
  if (/^https?:\/\//i.test(cleaned)) return cleaned;
  if (cleaned.startsWith("/")) return `${API_BASE_URL}${cleaned}`;
  return `${API_BASE_URL}/${cleaned}`;
}

function normalizeReadableSummary(value: string) {
  return value
    .replace(/\r/g, "\n")
    .split(/\n+/)
    .map((line) => normalizeReadableChinese(line))
    .filter(Boolean)
    .join("\n")
    .trim();
}

export function parseNoteScreenshots(metadata: Record<string, unknown> | null | undefined) {
  const raw = metadata?.note_screenshots;
  if (!Array.isArray(raw)) return [] as ParsedNoteScreenshot[];

  return raw
    .map((item, index) => {
      if (!item || typeof item !== "object") return null;
      const entry = item as Record<string, unknown>;
      const imageUrl = resolveAssetUrl(String(entry.image_url ?? entry.imageUrl ?? "").trim());
      if (!imageUrl) return null;

      const timestampMs = readNumber(entry.timestamp_ms ?? entry.timestampMs);
      const timestampSeconds = readNumber(entry.timestamp_seconds ?? entry.timestampSeconds);
      const caption = String(entry.caption ?? "").trim();
      const sourceText = String(entry.source_text ?? entry.sourceText ?? "").trim();
      const timestampLabel = String(entry.timestamp_label ?? entry.timestampLabel ?? "").trim();
      const rangeLabel = String(entry.range_label ?? entry.rangeLabel ?? "").trim();
      const seekUrl = String(entry.seek_url ?? entry.seekUrl ?? "").trim() || null;

      return {
        id: typeof entry.id === "string" && entry.id.trim() ? entry.id.trim() : `shot-${index + 1}`,
        timestampMs,
        timestampSeconds,
        timestampLabel,
        rangeLabel,
        imageUrl,
        seekUrl,
        caption,
        sourceText,
      } satisfies ParsedNoteScreenshot;
    })
    .filter((item): item is ParsedNoteScreenshot => Boolean(item));
}

export function splitStageDigestText(value: string, limit = 4) {
  const normalized = normalizeReadableSummary(value.replace(/\r/g, "\n")).trim();
  if (!normalized) return [] as string[];

  const parts = normalized
    .split(/\n+/)
    .flatMap((line) => splitReadableParagraphs(line))
    .flatMap((line) => line.split(/(?<=[。！？.!?])/))
    .map((item) => item.replace(/\s+/g, " ").trim())
    .filter(Boolean);

  return parts.slice(0, Math.max(1, limit));
}

export function buildStageDigestSeeds(
  inputs: StageDigestSeedInput[],
  options: StageDigestSeedBuildOptions,
) {
  const limit = Math.max(1, options.limit ?? (inputs.length || 1));
  const items: StageDigestSeed[] = [];

  for (let index = 0; index < inputs.length && items.length < limit; index += 1) {
    const input = inputs[index];
    const item = typeof input === "string" ? { summary: input } : input;
    const title = item.title?.trim() || `${options.titlePrefix ?? "阶段"} ${index + 1}`;
    const summary = normalizeReadableSummary(item.summary?.trim() || "");

    if (!title && !summary) {
      continue;
    }

    items.push({
      id: item.id?.trim() || `${options.idPrefix}-${index + 1}`,
      eyebrow: item.eyebrow?.trim() || `${options.eyebrowPrefix ?? "阶段"} ${index + 1}`,
      title,
      summary,
      href: item.href ?? null,
    });
  }

  return items;
}

export function buildStageDigestCards(
  seeds: StageDigestSeed[],
  screenshots: ParsedNoteScreenshot[],
  options?: { limit?: number },
) {
  const normalizedSeeds = seeds.filter((item) => item.title.trim() || item.summary.trim());
  const total = Math.max(normalizedSeeds.length, screenshots.length);
  const limit = Math.max(1, options?.limit ?? total);
  const items: StageDigestCard[] = [];

  for (let index = 0; index < total && items.length < limit; index += 1) {
    const seed = normalizedSeeds[index];
    const screenshot = screenshots[index];

    const eyebrow =
      seed?.eyebrow?.trim() ||
      screenshot?.rangeLabel ||
      screenshot?.timestampLabel ||
      `阶段 ${index + 1}`;
    const title =
      seed?.title?.trim() ||
      screenshot?.timestampLabel ||
      screenshot?.rangeLabel ||
      `阶段 ${index + 1}`;
    const summary = normalizeReadableSummary(
      seed?.summary?.trim() ||
      screenshot?.caption?.trim() ||
      screenshot?.sourceText?.trim() ||
      "",
    );

    if (!title && !summary && !screenshot?.imageUrl) {
      continue;
    }

    items.push({
      id: seed?.id || screenshot?.id || `stage-${index + 1}`,
      eyebrow,
      title,
      summary,
      href: screenshot?.seekUrl || seed?.href || null,
      imageUrl: screenshot?.imageUrl || "",
      imageAlt: screenshot?.caption || screenshot?.timestampLabel || title,
      badge: screenshot?.timestampLabel || screenshot?.rangeLabel || "",
    });
  }

  return items;
}
