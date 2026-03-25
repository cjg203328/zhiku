import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import {
  deleteContent,
  exportContentMarkdown,
  exportDerivedItem,
  generateMindmap,
  generateQuiz,
  getContent,
  getImportJob,
  listDerivedItems,
  deleteDerivedItem,
  reindexContent,
  reparseContent,
  restoreNoteVersion,
  updateContent,
  type DerivedItem,
  type ImportJob,
  type NoteGenerationMode,
  type NoteQuality,
} from "../lib/api";
import {
  buildImportTimeoutMessage as buildSharedImportTimeoutMessage,
  getImportJobStepMeta as getSharedImportJobStepMeta,
  getImportStageItems as getSharedImportStageItems,
  isImportJobTerminal as isSharedImportJobTerminal,
  resolveImportJobTimeoutState as resolveSharedImportJobTimeoutState,
  resolveImportStageIndex as resolveSharedImportStageIndex,
} from "../lib/importProgress";
import { useLanguage } from "../lib/language";
import { prepareReadableNoteMarkdown } from "../lib/readableNote";
import { formatMilliseconds, formatTimeRange } from "../lib/utils";
import MarkdownNoteView, { cleanNoteMarkdownForDisplay } from "../components/MarkdownNoteView";
import RichNoteEditor from "../components/RichNoteEditor";
import ImportProgressCard from "../components/import/ImportProgressCard";
import StageDigest from "../components/StageDigest";
import {
  buildStageDigestCards,
  buildStageDigestSeeds,
  parseNoteScreenshots,
  splitStageDigestText,
} from "../lib/stageDigest";

type HighlightColor = "yellow" | "blue" | "green" | "";
type SegmentAnnotation = { highlight: HighlightColor; note: string };

type MindmapNodeData = { title: string; children?: MindmapNodeData[] };
type QuizQuestion = { question: string; options: string[]; answer: string; explanation?: string };

function MindmapNode({ node, depth }: { node: MindmapNodeData; depth: number }) {
  const indent = depth * 16;
  return (
    <div style={{ marginLeft: indent }}>
      <div className={depth === 0 ? "mindmap-root" : "mindmap-node"}>{node.title}</div>
      {node.children?.map((child, i) => (
        <MindmapNode key={i} node={child} depth={depth + 1} />
      ))}
    </div>
  );
}

function loadAnnotations(contentId: string): Record<number, SegmentAnnotation> {
  try {
    const raw = localStorage.getItem(`annotations:${contentId}`);
    return raw ? JSON.parse(raw) : {};
  } catch { return {}; }
}
function saveAnnotations(contentId: string, data: Record<number, SegmentAnnotation>) {
  try { localStorage.setItem(`annotations:${contentId}`, JSON.stringify(data)); } catch {}
}

function buildScopedChatLink(query: string, options?: { contentId?: string; chunkId?: string; title?: string; chunkLabel?: string }) {
  const search = new URLSearchParams();
  search.set("q", query);
  if (options?.contentId) search.set("contentId", options.contentId);
  if (options?.chunkId) search.set("chunkId", options.chunkId);
  if (options?.title) search.set("title", options.title);
  if (options?.chunkLabel) search.set("chunkLabel", options.chunkLabel);
  return `/chat?${search.toString()}`;
}

function formatDateTime(value: string | null | undefined) {
  if (!value) return "-";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}


function readNumber(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function getTranscriptSourceLabel(value: unknown) {
  if (value === "subtitle") return "公开字幕";
  if (value === "asr") return "音频转写";
  if (value === "description") return "简介回退";
  return "未确定来源";
}

function getSegmentSourceLabel(value: unknown) {
  if (value === "subtitle") return "字幕片段";
  if (value === "asr_estimated") return "转写片段";
  if (value === "description") return "简介片段";
  return "原始片段";
}

function getAsrModeLabel(value: unknown) {
  if (value === "local") return "本地转写";
  if (value === "inherited") return "复用主模型";
  if (value === "hybrid") return "部分复用";
  if (value === "explicit") return "独立转写";
  return null;
}

function getCaptureStrategyLabel(value: unknown) {
  if (value === "yt_dlp") return "yt-dlp 兜底";
  if (value === "native_api") return "原生接口";
  return "";
}

function getNoteStyleLabel(value: unknown) {
  if (value === "bilinote") return "阅读版";
  if (value === "qa") return "问答版";
  if (value === "brief") return "速览版";
  if (value === "structured") return "结构版";
  return "标准版";
}

function getNoteGenerationModeLabel(value: unknown) {
  if (value === "model_draft") return "模型成稿";
  if (value === "local_only") return "本地整理";
  return "混合模式";
}

function isImportJobTerminal(status: string | undefined) {
  return status === "completed" || status === "failed" || status === "cancelled";
}

function getImportJobStepMeta(step: string | undefined) {
  if (step === "queued") return { label: "已接收任务", description: "当前重整理任务已进入队列。" };
  if (step === "detecting_source") return { label: "识别来源", description: "正在确认当前内容的重解析来源，并选择合适的抓取方式。" };
  if (step === "reading_file") return { label: "读取文件", description: "正在重新读取原始文件内容，并准备生成新的结构化笔记。" };
  if (step === "parsing_content") return { label: "提取内容", description: "正在重新整理正文、字幕、截图和回看线索。" };
  if (step === "fetching_subtitle") return { label: "检查字幕", description: "正在确认当前视频是否有可直接使用的字幕与时间轴。" };
  if (step === "fetching_audio") return { label: "检查音频", description: "当前没有公开字幕，正在确认是否能回退到音频正文。" };
  if (step === "transcribing_audio") return { label: "音频转写", description: "正在执行本地转写，这一步通常最久，请耐心等待。" };
  if (step === "capturing_screenshots") return { label: "整理片段", description: "正在生成关键片段、截图与回看线索。" };
  if (step === "saving_content") return { label: "刷新当前内容", description: "正在保存版本历史，并用新的结果刷新当前内容。" };
  if (step === "done") return { label: "重解析完成", description: "当前内容已经刷新完成，现在可以继续阅读或回看。" };
  if (step === "failed") return { label: "重解析失败", description: "这次没有顺利刷新当前内容，请按提示调整后再试一次。" };
  return { label: "处理中", description: "系统正在继续整理当前重解析任务。" };
}

function normalizeImportStageStep(step: string | undefined) {
  if (step === "fetching_subtitle" || step === "fetching_audio" || step === "transcribing_audio" || step === "capturing_screenshots") {
    return "parsing_content";
  }
  return step;
}

function getImportStageItems(sourceKind?: string) {
  if (sourceKind === "file" || sourceKind === "file_upload") {
    return [
      { key: "queued", label: "接收任务" },
      { key: "reading_file", label: "读取文件" },
      { key: "parsing_content", label: "提取内容" },
      { key: "saving_content", label: "刷新内容" },
    ];
  }

  return [
    { key: "queued", label: "接收任务" },
    { key: "detecting_source", label: "识别来源" },
    { key: "parsing_content", label: "提取内容" },
    { key: "saving_content", label: "刷新内容" },
  ];
}

function resolveImportStageIndex(step: string | undefined, sourceKind?: string) {
  const stages = getImportStageItems(sourceKind);
  if (step === "done") return stages.length - 1;
  const normalizedStep = normalizeImportStageStep(step);
  const index = stages.findIndex((item) => item.key === normalizedStep);
  return index >= 0 ? index : 0;
}

type MarkdownSection = {
  title: string;
  lines: string[];
};

type OverviewDigestItem = {
  label: string;
  value: string;
};

type TimelineDigestItem = {
  label: string;
  href: string | null;
  summary: string;
};

type ClipDigestItem = {
  label: string;
  href: string | null;
  summary: string;
};

type NoteVersionSnapshot = {
  id: string;
  capturedAt: string;
  source: string;
  title: string;
  summary: string;
  keyPoints: string[];
  noteMarkdown: string;
  noteStyle: string;
  summaryFocus: string;
  status: string;
  transcriptSource: string;
  captureSummary: string;
};

function trimSectionLines(lines: string[]) {
  const next = [...lines];
  while (next.length && !next[0].trim()) next.shift();
  while (next.length && !next[next.length - 1].trim()) next.pop();
  return next;
}

function parseMarkdownSections(markdown: string) {
  if (!markdown.trim()) return [] as MarkdownSection[];

  const sections: MarkdownSection[] = [];
  let currentTitle = "";
  let currentLines: string[] = [];

  for (const rawLine of markdown.split(/\r?\n/)) {
    const line = rawLine.trim();
    const headingMatch = line.match(/^##\s+(.*)$/);
    if (headingMatch) {
      if (currentTitle) {
        sections.push({ title: currentTitle, lines: trimSectionLines(currentLines) });
      }
      currentTitle = headingMatch[1].trim();
      currentLines = [];
      continue;
    }

    if (currentTitle) {
      currentLines.push(rawLine);
    }
  }

  if (currentTitle) {
    sections.push({ title: currentTitle, lines: trimSectionLines(currentLines) });
  }

  return sections.filter((section) => section.title && section.lines.some((line) => line.trim()));
}

function getSectionText(section: MarkdownSection | null | undefined) {
  if (!section) return "";
  return section.lines
    .map((line) => line.trim())
    .filter((line) => line && !/^[-*]\s+/.test(line) && !/^\d+[.)]\s+/.test(line) && !/^###\s+/.test(line))
    .map((line) => line.replace(/^>\s*/, ""))
    .join("\n")
    .trim();
}

function getSectionList(section: MarkdownSection | null | undefined) {
  if (!section) return [] as string[];
  return section.lines
    .map((line) => line.trim())
    .map((line) => line.match(/^(?:[-*]|\d+[.)])\s+(.*)$/)?.[1]?.trim() ?? "")
    .filter(Boolean);
}

function shortenText(value: string, limit: number) {
  const compact = value.replace(/\s+/g, " ").trim();
  if (!compact) return "";
  return compact.length <= limit ? compact : `${compact.slice(0, limit).trimEnd()}...`;
}

function formatReadableNoteMarkdown(markdown: string) {
  return cleanNoteMarkdownForDisplay(prepareReadableNoteMarkdown(markdown));
}

function parseNoteVersions(value: unknown) {
  if (!Array.isArray(value)) return [] as NoteVersionSnapshot[];
  return value
    .map((item) => {
      if (!item || typeof item !== "object") return null;
      const entry = item as Record<string, unknown>;
      const noteMarkdown = typeof entry.note_markdown === "string" ? formatReadableNoteMarkdown(entry.note_markdown) : "";
      const summary = typeof entry.summary === "string" ? entry.summary.trim() : "";
      const keyPoints = readStringList(entry.key_points);
      if (!noteMarkdown && !summary && !keyPoints.length) return null;
      return {
        id: typeof entry.id === "string" && entry.id.trim() ? entry.id.trim() : `version-${Math.random().toString(36).slice(2, 8)}`,
        capturedAt: typeof entry.captured_at === "string" ? entry.captured_at.trim() : "",
        source: typeof entry.source === "string" ? entry.source.trim() : "reparse",
        title: typeof entry.title === "string" ? entry.title.trim() : "未命名版本",
        summary,
        keyPoints,
        noteMarkdown,
        noteStyle: typeof entry.note_style === "string" && entry.note_style.trim() ? entry.note_style.trim() : "structured",
        summaryFocus: typeof entry.summary_focus === "string" ? entry.summary_focus.trim() : "",
        status: typeof entry.status === "string" ? entry.status.trim() : "ready",
        transcriptSource: typeof entry.transcript_source === "string" ? entry.transcript_source.trim() : "",
        captureSummary: typeof entry.capture_summary === "string" ? entry.capture_summary.trim() : "",
      } satisfies NoteVersionSnapshot;
    })
    .filter((item): item is NoteVersionSnapshot => Boolean(item));
}

function getNoteVersionSourceLabel(value: string) {
  if (value === "current") return "当前版本";
  if (value === "reparse") return "重解析前";
  if (value === "restore") return "恢复前";
  return "历史版本";
}

function buildMarkdownPreviewText(markdown: string, limit = 520) {
  const compact = formatReadableNoteMarkdown(markdown)
    .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, "$1")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^>\s?/gm, "")
    .replace(/^\s*[-*]\s+/gm, "")
    .replace(/^\s*\d+[.)]\s+/gm, "")
    .replace(/\n{2,}/g, "\n")
    .trim();
  return shortenText(compact, limit);
}

function parseOverviewItems(section: MarkdownSection | null | undefined) {
  return getSectionList(section)
    .map((item) => {
      const pairMatch = item.match(/^([^：:]+)[：:]\s*(.*)$/);
      if (!pairMatch) {
        return { label: item, value: "" };
      }
      return {
        label: pairMatch[1].trim(),
        value: pairMatch[2].trim(),
      };
    })
    .filter((item) => item.label);
}

function parseTimelineItems(section: MarkdownSection | null | undefined) {
  return getSectionList(section)
    .map((item) => {
      const linkedMatch = item.match(/^\[([^\]]+)\]\(([^)]+)\)\s*(.*)$/);
      if (linkedMatch) {
        return {
          label: linkedMatch[1].trim(),
          href: linkedMatch[2].trim(),
          summary: linkedMatch[3].trim(),
        };
      }
      const pairMatch = item.match(/^([^：:]+)[：:]\s*(.*)$/);
      if (pairMatch) {
        return {
          label: pairMatch[1].trim(),
          href: null,
          summary: pairMatch[2].trim(),
        };
      }
      return {
        label: item,
        href: null,
        summary: "",
      };
    })
    .filter((item) => item.label);
}

function parseClipItems(section: MarkdownSection | null | undefined) {
  if (!section) return [] as ClipDigestItem[];

  const clips: ClipDigestItem[] = [];
  let currentLabel = "";
  let currentHref: string | null = null;
  let currentLines: string[] = [];

  function flushCurrentClip() {
    if (!currentLabel) return;
    clips.push({
      label: currentLabel,
      href: currentHref,
      summary: currentLines.join(" ").replace(/\s+/g, " ").trim(),
    });
    currentLabel = "";
    currentHref = null;
    currentLines = [];
  }

  for (const rawLine of section.lines) {
    const line = rawLine.trim();
    if (!line) continue;

    const headingMatch = line.match(/^###\s+(.*)$/);
    if (headingMatch) {
      flushCurrentClip();
      const linkedMatch = headingMatch[1].trim().match(/^\[([^\]]+)\]\(([^)]+)\)$/);
      if (linkedMatch) {
        currentLabel = linkedMatch[1].trim();
        currentHref = linkedMatch[2].trim();
      } else {
        currentLabel = headingMatch[1].trim();
        currentHref = null;
      }
      continue;
    }

    if (currentLabel) {
      if (/^!\[[^\]]*\]\([^)]+\)$/.test(line)) {
        continue;
      }
      if (/^\*?Screenshot-(?:\[\d{2}:\d{2}\]|\d{2}:\d{2})$/.test(line)) {
        continue;
      }
      currentLines.push(line);
    }
  }

  flushCurrentClip();
  return clips.filter((item) => item.label);
}

function getQualityInfo(status: string | null | undefined, metadata: Record<string, unknown> | null | undefined) {
  const captureSummary = typeof metadata?.capture_summary === "string" ? metadata.capture_summary.trim() : "";
  const recommendedAction = typeof metadata?.capture_recommended_action === "string" ? metadata.capture_recommended_action.trim() : "";
  const asrModeLabel = getAsrModeLabel(metadata?.asr_config_mode);
  const noisyAsrDetected = metadata?.noisy_asr_detected === true;

  if (status === "ready" && noisyAsrDetected) {
    return {
      label: "原文可用",
      description: "当前正文主要来自音频转写，原文和时间锚点已可用，但语义仍需进一步重整。",
      actionLabel: "去配置模型",
    };
  }
  if (status === "ready") return { label: "笔记完成", description: captureSummary || "已形成笔记、原文与时间锚点。", actionLabel: null };
  if (status === "ready_estimated") {
    return {
      label: "正文恢复",
      description: captureSummary || (asrModeLabel ? `当前正文来自${asrModeLabel}的音频转写，可结合原文与时间点继续核对。` : "当前正文来自音频转写，可结合原文与时间点继续核对。"),
      actionLabel: null,
    };
  }
  if (status === "needs_cookie") return { label: "待补登录", description: captureSummary || "这条视频的字幕需要登录态，当前仅保留了基础档案。", actionLabel: "去检查 B 站增强" };
  if (status === "needs_asr") return { label: "待补转写", description: captureSummary || "这条视频还没有拿到可直接使用的正文。", actionLabel: "去配置音频转写" };
  if (status === "asr_failed") return { label: "转写异常", description: captureSummary || recommendedAction || "字幕和转写都还没有返回可用正文。", actionLabel: "去检查转写配置" };
  if (status === "limited") return { label: "材料有限", description: captureSummary || "当前仅保留了较弱材料，内容仍需继续补齐。", actionLabel: null };
  return { label: "已建档", description: captureSummary || "当前已生成基础档案，可查看本页摘要与已保留材料。", actionLabel: null };
}

function buildFallbackSeekUrl(sourceUrl: string | null | undefined, startMs: number | null | undefined) {
  if (!sourceUrl?.trim()) return null;
  try {
    const url = new URL(sourceUrl);
    if (typeof startMs === "number" && startMs >= 0) url.searchParams.set("t", String(Math.floor(startMs / 1000)));
    return url.toString();
  } catch {
    return sourceUrl;
  }
}

function resolveSeekUrl(explicitUrl: string | null | undefined, sourceUrl: string | null | undefined, startMs: number | null | undefined) {
  if (explicitUrl?.trim()) return explicitUrl;
  return buildFallbackSeekUrl(sourceUrl, startMs);
}

function getNoteQuality(metadata: Record<string, unknown> | null | undefined): NoteQuality | null {
  const raw = metadata?.note_quality;
  if (raw && typeof raw === "object") return raw as NoteQuality;
  return null;
}

function readStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter(Boolean);
}

function getCaptureStatusLabel(status: string | null | undefined) {
  if (status === "ready") return "材料完整";
  if (status === "ready_estimated") return "正文恢复";
  if (status === "needs_cookie") return "待补登录";
  if (status === "needs_asr") return "待补转写";
  if (status === "asr_failed") return "转写异常";
  if (status === "limited") return "材料有限";
  if (status === "preview_ready") return "预览就绪";
  return "已建档";
}

function getMaterialReadiness(
  status: string | null | undefined,
  options: {
    transcriptCount: number;
    chunkCount: number;
    noteQuality: NoteQuality | null;
    metadata: Record<string, unknown> | null;
  },
) {
  const { transcriptCount, chunkCount, noteQuality, metadata } = options;
  const sourceDescription = typeof metadata?.source_description === "string" ? metadata.source_description.trim() : "";
  const captureAction = typeof metadata?.capture_recommended_action === "string" ? metadata.capture_recommended_action.trim() : "";
  const seedLevel = typeof metadata?.material_seed_level === "string" ? metadata.material_seed_level.trim() : "";
  const weakCapture = seedLevel === "weak_capture" || ["needs_cookie", "needs_asr", "asr_failed", "limited", "preview_ready"].includes(status ?? "");
  const transcriptReady = transcriptCount > 0;
  const chunkReady = chunkCount > 0;
  const noteReady = Boolean(noteQuality?.refined_note_ready || noteQuality?.llm_enhanced);

  let title = "内容已成形";
  let description = "原文和笔记已成形，可以直接阅读、回看和继续追问。";
  if (weakCapture) {
    title = "内容仍在补齐";
    description = captureAction || "当前以基础原文或草稿为主，但主流程已经可用。";
  } else if (!noteReady || !chunkReady) {
    title = "内容仍在整理";
    description = captureAction || "原文已经到位，笔记或回看定位还在继续整理。";
  }

  return {
    statusLabel: getCaptureStatusLabel(status),
    weakCapture,
    title,
    description,
  };
}

type TranscriptSegment = {
  startMs: number | null;
  endMs: number | null;
  text: string;
  sourceKind: string;
  qualityLevel: string;
  timestampLabel: string;
  seekUrl: string | null;
};

function parseTranscriptSegments(metadata: Record<string, unknown> | null | undefined): TranscriptSegment[] {
  const raw = metadata?.transcript_segments;
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item) => {
      if (!item || typeof item !== "object") return null;
      const entry = item as Record<string, unknown>;
      const text = String(entry.text ?? "").trim();
      if (!text) return null;
      return {
        startMs: readNumber(entry.start_ms),
        endMs: readNumber(entry.end_ms),
        text,
        sourceKind: String(entry.source_kind ?? "transcript"),
        qualityLevel: String(entry.quality_level ?? "unknown"),
        timestampLabel: String(entry.timestamp_label ?? "").trim(),
        seekUrl: typeof entry.seek_url === "string" && entry.seek_url.trim() ? entry.seek_url : null,
      };
    })
    .filter((item): item is TranscriptSegment => Boolean(item));
}

type EvidenceDigestItem = {
  title: string;
  anchor: string;
  timeLabel: string;
  heading: string;
  snippet: string;
  line: string;
};

function parseEvidenceDigest(metadata: Record<string, unknown> | null | undefined): EvidenceDigestItem[] {
  const raw = metadata?.evidence_digest;
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item) => {
      if (!item || typeof item !== "object") return null;
      const entry = item as Record<string, unknown>;
      const title = String(entry.title ?? "").trim();
      const line = String(entry.line ?? "").trim();
      if (!title && !line) return null;
      return {
        title,
        anchor: String(entry.anchor ?? "").trim(),
        timeLabel: String(entry.time_label ?? "").trim(),
        heading: String(entry.heading ?? "").trim(),
        snippet: String(entry.snippet ?? "").trim(),
        line,
      };
    })
    .filter((item): item is EvidenceDigestItem => Boolean(item));
}

const VIEW_ITEMS = [
  { key: "refined", label: "笔记" },
  { key: "transcript", label: "原文" },
] as const;

type ViewKey = (typeof VIEW_ITEMS)[number]["key"];

function normalizeViewKey(value: string | null): ViewKey | null {
  if (value === "chunks") {
    return "transcript";
  }
  if (value === "refined" || value === "transcript") {
    return value;
  }
  return null;
}

const REPARSE_MODE_ITEMS: Array<{ value: NoteGenerationMode; label: string; hint: string }> = [
  { value: "model_draft", label: "模型成稿", hint: "优先让模型理解后成稿，适合看最终笔记质量。" },
  { value: "hybrid", label: "混合模式", hint: "先走本地整理，再用模型补强可读性，适合常规使用。" },
  { value: "local_only", label: "本地整理", hint: "只用本地规则整理，适合更省 token 的刷新。" },
];

function normalizeNoteGenerationMode(value: unknown): NoteGenerationMode {
  if (value === "model_draft" || value === "hybrid" || value === "local_only") {
    return value;
  }
  return "hybrid";
}

function buildNoteDraftValue(noteQuality: NoteQuality | null) {
  if (noteQuality?.llm_enhanced) {
    return "模型精炼";
  }
  if (noteQuality?.refined_note_ready) {
    return "已整理";
  }
  return "待补强";
}

function buildMaterialSummary(transcriptCount: number, chunkCount: number) {
  if (transcriptCount > 0) {
    return `原文 ${transcriptCount} 段`;
  }
  if (chunkCount > 0) {
    return `已整理 ${chunkCount} 段`;
  }
  return "待补齐";
}

function buildTranscriptAnchorId(index: number, chunkId?: string | null) {
  const normalizedChunkId = chunkId?.trim();
  return normalizedChunkId ? `chunk:${normalizedChunkId}` : `transcript:${index}`;
}

export default function ContentDetailPage() {
  const { displayText } = useLanguage();
  const { contentId = "" } = useParams();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const transcriptCardRefs = useRef(new Map<string, HTMLElement>());
  const lastAppliedFocusKeyRef = useRef("");
  const contentQuery = useQuery({
    queryKey: ["content", contentId],
    queryFn: () => getContent(contentId),
    enabled: Boolean(contentId),
    retry: 1,
  });

  const [title, setTitle] = useState("");
  const [summary, setSummary] = useState("");
  const [category, setCategory] = useState("");
  const [tags, setTags] = useState("");
  const [localMessage, setLocalMessage] = useState("");
  const [activeView, setActiveView] = useState<ViewKey>("refined");
  const [focusedAnchorId, setFocusedAnchorId] = useState("");
  const [isEditingMeta, setIsEditingMeta] = useState(false);
  const [annotations, setAnnotations] = useState<Record<number, SegmentAnnotation>>({});
  const [annotatingIndex, setAnnotatingIndex] = useState<number | null>(null);
  const [newTagInput, setNewTagInput] = useState("");
  const [isEditingNote, setIsEditingNote] = useState(false);
  const [showFullNote, setShowFullNote] = useState(false);
  const [richNoteContent, setRichNoteContent] = useState("");
  const [selectedVersionId, setSelectedVersionId] = useState("current");
  const [deriveView, setDeriveView] = useState<"none" | "mindmap" | "quiz">("none");
  const [quizAnswers, setQuizAnswers] = useState<Record<number, string>>({});
  const [quizRevealed, setQuizRevealed] = useState<Record<number, boolean>>({});
  const [activeReparseJobId, setActiveReparseJobId] = useState("");
  const [activeReparseJob, setActiveReparseJob] = useState<ImportJob | null>(null);
  const [reparseFailureMessage, setReparseFailureMessage] = useState("");
  const [reparseNoteGenerationMode, setReparseNoteGenerationMode] = useState<NoteGenerationMode>("hybrid");

  const derivedItemsQuery = useQuery({
    queryKey: ["derived", contentId],
    queryFn: () => listDerivedItems(contentId),
    enabled: Boolean(contentId),
    retry: 1,
  });

  const mindmapMutation = useMutation({
    mutationFn: () => generateMindmap(contentId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["derived", contentId] });
      setDeriveView("mindmap");
    },
  });

  const quizMutation = useMutation({
    mutationFn: () => generateQuiz(contentId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["derived", contentId] });
      setDeriveView("quiz");
      setQuizAnswers({});
      setQuizRevealed({});
    },
  });

  const deleteDerivedMutation = useMutation({
    mutationFn: (itemId: string) => deleteDerivedItem(itemId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["derived", contentId] }),
  });

  const handleExportDerived = useCallback(async (itemId: string, filename: string) => {
    try {
      const text = await exportDerivedItem(itemId);
      const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      // silent — user can retry
    }
  }, []);

  const derivedMindmap = derivedItemsQuery.data?.items.find((i: DerivedItem) => i.kind === "mindmap") ?? null;
  const derivedQuiz = derivedItemsQuery.data?.items.find((i: DerivedItem) => i.kind === "quiz") ?? null;

  useEffect(() => {
    if (!contentId) return;
    // 优先读后端持久化批注，fallback localStorage
    const backendAnnotations = (contentQuery.data?.metadata as Record<string, unknown> | null)?.user_annotations;
    if (backendAnnotations && typeof backendAnnotations === "object") {
      setAnnotations(backendAnnotations as Record<number, SegmentAnnotation>);
    } else {
      setAnnotations(loadAnnotations(contentId));
    }
  }, [contentId, contentQuery.data]);

  const setAnnotation = useCallback((index: number, patch: Partial<SegmentAnnotation>) => {
    setAnnotations((prev) => {
      const existing: SegmentAnnotation = prev[index] ?? { highlight: "", note: "" };
      const merged: SegmentAnnotation = { ...existing, ...patch };
      let next: Record<number, SegmentAnnotation>;
      if (!merged.highlight && !merged.note) {
        next = Object.fromEntries(Object.entries(prev).filter(([k]) => k !== String(index))) as Record<number, SegmentAnnotation>;
      } else {
        next = { ...prev, [index]: merged };
      }
      // 乐观写 localStorage 作草稿，异步持久化到后端
      saveAnnotations(contentId, next);
      annotationsMutation.mutate(next);
      return next;
    });
  }, [contentId]); // eslint-disable-line react-hooks/exhaustive-deps

  const tagList = useMemo(() => tags.split(",").map((t) => t.trim()).filter(Boolean), [tags]);

  useEffect(() => {
    if (!contentQuery.data) return;
    setTitle(contentQuery.data.title);
    setSummary(contentQuery.data.summary);
    setCategory(contentQuery.data.category);
    setTags(contentQuery.data.tags.join(", "));
    const refined = (contentQuery.data.metadata as Record<string,unknown> | null)?.refined_note_markdown;
    const note = (contentQuery.data.metadata as Record<string,unknown> | null)?.note_markdown;
    const raw = typeof refined === "string" ? refined : typeof note === "string" ? note : contentQuery.data.summary;
    setRichNoteContent(formatReadableNoteMarkdown(raw || ""));
    const nextNoteGenerationMode =
      typeof (contentQuery.data.metadata as Record<string, unknown> | null)?.note_generation_mode === "string"
        ? (contentQuery.data.metadata as Record<string, unknown>).note_generation_mode
        : undefined;
    setReparseNoteGenerationMode(normalizeNoteGenerationMode(nextNoteGenerationMode));
  }, [contentQuery.data]);

  const metadata = useMemo<Record<string, unknown> | null>(() => {
    const value = contentQuery.data?.metadata;
    return value && typeof value === "object" ? value : null;
  }, [contentQuery.data]);
  const refinedNote = useMemo(() => {
    const refined = metadata?.refined_note_markdown;
    if (typeof refined === "string" && refined.trim()) return formatReadableNoteMarkdown(refined);
    return typeof metadata?.note_markdown === "string" ? formatReadableNoteMarkdown(metadata.note_markdown) : "";
  }, [metadata]);
  const noteStyleValue = useMemo(() => (typeof metadata?.note_style === "string" ? metadata.note_style.trim() : ""), [metadata]);
  const historicalNoteVersions = useMemo(() => parseNoteVersions(metadata?.note_versions), [metadata]);
  const currentNoteVersion = useMemo<NoteVersionSnapshot>(
    () => ({
      id: "current",
      capturedAt: contentQuery.data?.updated_at ?? contentQuery.data?.created_at ?? "",
      source: "current",
      title: contentQuery.data?.title ?? "当前版本",
      summary: contentQuery.data?.summary ?? "",
      keyPoints: contentQuery.data?.key_points ?? [],
      noteMarkdown: refinedNote,
      noteStyle: noteStyleValue || "structured",
      summaryFocus: typeof metadata?.summary_focus === "string" ? metadata.summary_focus.trim() : "",
      status: contentQuery.data?.status ?? "ready",
      transcriptSource: typeof metadata?.transcript_source === "string" ? metadata.transcript_source.trim() : "",
      captureSummary: typeof metadata?.capture_summary === "string" ? metadata.capture_summary.trim() : "",
    }),
    [contentQuery.data?.created_at, contentQuery.data?.key_points, contentQuery.data?.status, contentQuery.data?.summary, contentQuery.data?.title, contentQuery.data?.updated_at, metadata, noteStyleValue, refinedNote],
  );
  const noteVersionItems = useMemo(() => [currentNoteVersion, ...historicalNoteVersions], [currentNoteVersion, historicalNoteVersions]);
  const selectedNoteVersion = useMemo(
    () => noteVersionItems.find((item) => item.id === selectedVersionId) ?? currentNoteVersion,
    [currentNoteVersion, noteVersionItems, selectedVersionId],
  );
  const selectedVersionPreview = useMemo(
    () => buildMarkdownPreviewText(selectedNoteVersion.noteMarkdown || selectedNoteVersion.summary || ""),
    [selectedNoteVersion.noteMarkdown, selectedNoteVersion.summary],
  );
  const rawTranscript = useMemo(() => (typeof metadata?.raw_transcript_markdown === "string" ? metadata.raw_transcript_markdown : ""), [metadata]);
  const markdownSections = useMemo(() => parseMarkdownSections(refinedNote), [refinedNote]);
  const markdownSectionMap = useMemo(() => new Map(markdownSections.map((section) => [section.title, section] as const)), [markdownSections]);
  const overviewItems = useMemo(
    () => parseOverviewItems(markdownSectionMap.get("视频速览") ?? markdownSectionMap.get("网页速览")),
    [markdownSectionMap],
  );
  const focusNote = useMemo(() => getSectionText(markdownSectionMap.get("本次关注")), [markdownSectionMap]);
  const coreConclusion = useMemo(() => getSectionText(markdownSectionMap.get("核心结论")), [markdownSectionMap]);
  const memoryPoints = useMemo(() => getSectionList(markdownSectionMap.get("值得记住的内容")), [markdownSectionMap]);
  const timelineItems = useMemo(() => parseTimelineItems(markdownSectionMap.get("时间线笔记")), [markdownSectionMap]);
  const clipItems = useMemo(() => parseClipItems(markdownSectionMap.get("片段整理")), [markdownSectionMap]);
  const noteScreenshots = useMemo(() => parseNoteScreenshots(metadata), [metadata]);
  const noteScreenshotStatus = useMemo(() => (typeof metadata?.note_screenshots_status === "string" ? metadata.note_screenshots_status.trim() : ""), [metadata]);
  const noteScreenshotSummary = useMemo(() => (typeof metadata?.note_screenshots_summary === "string" ? metadata.note_screenshots_summary.trim() : ""), [metadata]);
  const stageDigestSeeds = useMemo(() => {
    if (clipItems.length > 0) {
      return buildStageDigestSeeds(
        clipItems.map((item, index) => ({
          id: `clip-${index + 1}-${item.label}`,
          eyebrow: item.label || undefined,
          title: item.label || undefined,
          summary: item.summary,
          href: item.href,
        })),
        { idPrefix: "clip", eyebrowPrefix: "阶段", titlePrefix: "阶段", limit: 4 },
      );
    }
    if (timelineItems.length > 0) {
      return buildStageDigestSeeds(
        timelineItems.map((item, index) => ({
          id: `timeline-${index + 1}-${item.label}`,
          eyebrow: item.label || undefined,
          title: item.label || undefined,
          summary: item.summary,
          href: item.href,
        })),
        { idPrefix: "timeline", eyebrowPrefix: "阶段", titlePrefix: "阶段", limit: 4 },
      );
    }
    return buildStageDigestSeeds(memoryPoints, {
      idPrefix: "memory",
      eyebrowPrefix: "阶段",
      titlePrefix: "阶段",
      limit: 4,
    });
  }, [clipItems, timelineItems, memoryPoints]);
  const stageDigestItems = useMemo(
    () => buildStageDigestCards(stageDigestSeeds, noteScreenshots, { limit: 4 }),
    [noteScreenshots, stageDigestSeeds],
  );
  const selectedVersionStageSeeds = useMemo(() => {
    if (selectedNoteVersion.keyPoints.length > 0) {
      return buildStageDigestSeeds(selectedNoteVersion.keyPoints, {
        idPrefix: `${selectedNoteVersion.id}-point`,
        eyebrowPrefix: "重点",
        titlePrefix: "阶段",
        limit: 3,
      });
    }

    return buildStageDigestSeeds(
      splitStageDigestText(selectedNoteVersion.summary || selectedVersionPreview, 3),
      {
        idPrefix: `${selectedNoteVersion.id}-summary`,
        eyebrowPrefix: "摘要",
        titlePrefix: "阶段",
        limit: 3,
      },
    );
  }, [selectedNoteVersion.id, selectedNoteVersion.keyPoints, selectedNoteVersion.summary, selectedVersionPreview]);
  const selectedVersionStageDigestItems = useMemo(
    () => buildStageDigestCards(selectedVersionStageSeeds, selectedNoteVersion.id === "current" ? noteScreenshots : [], { limit: 3 }),
    [noteScreenshots, selectedNoteVersion.id, selectedVersionStageSeeds],
  );
  const isBiliNoteStyle = noteStyleValue === "bilinote";
  const transcriptSegments = useMemo(() => parseTranscriptSegments(metadata), [metadata]);
  const transcriptSourceLabel = useMemo(() => getTranscriptSourceLabel(metadata?.transcript_source), [metadata]);
  const captureRouteSummary = useMemo(() => {
    if (!metadata) return "";
    const subtitleStrategy = getCaptureStrategyLabel(metadata.subtitle_fetch_strategy);
    const audioStrategy = getCaptureStrategyLabel(metadata.audio_fetch_strategy);
    const parts: string[] = [];

    if (subtitleStrategy && (metadata.transcript_source === "subtitle" || metadata.subtitle_ytdlp_fallback_used === true)) {
      parts.push(`字幕：${subtitleStrategy}`);
    }
    if (audioStrategy && (metadata.audio_available === true || metadata.transcript_source === "asr" || metadata.audio_ytdlp_fallback_used === true)) {
      parts.push(`音频：${audioStrategy}`);
    }

    return parts.join(" / ");
  }, [metadata]);
  const noteQuality = useMemo(() => getNoteQuality(metadata), [metadata]);
  const qualityGapItems = useMemo(() => {
    const rawItems = noteQuality?.capture_gap_report?.items;
    if (!Array.isArray(rawItems)) {
      return [] as string[];
    }
    return rawItems
      .map((item) => item.detail?.trim() || item.label?.trim() || "")
      .filter(Boolean)
      .slice(0, 3);
  }, [noteQuality]);
  const coverageMissingSections = useMemo(() => {
    const rawItems = noteQuality?.note_coverage_report?.missing_sections;
    if (!Array.isArray(rawItems)) {
      return [] as string[];
    }
    return rawItems
      .map((item) => {
        const label = item.label?.trim() || item.position?.trim() || "";
        const excerpt = item.excerpt?.trim() || "";
        return label && excerpt ? `${label}：${excerpt}` : label || excerpt;
      })
      .filter(Boolean)
      .slice(0, 3);
  }, [noteQuality]);
  const qualityInfo = useMemo(() => getQualityInfo(contentQuery.data?.status, metadata), [contentQuery.data?.status, metadata]);
  const runningReparseJob = useMemo(
    () => (activeReparseJob && !isSharedImportJobTerminal(activeReparseJob.status) ? activeReparseJob : null),
    [activeReparseJob],
  );
  const reparseStepMeta = useMemo(() => getSharedImportJobStepMeta(runningReparseJob?.step, "reparse"), [runningReparseJob?.step]);
  const reparseStageItems = useMemo(() => getSharedImportStageItems(runningReparseJob?.source_kind, "reparse"), [runningReparseJob?.source_kind]);
  const reparseStageIndex = useMemo(
    () => resolveSharedImportStageIndex(runningReparseJob?.step, runningReparseJob?.source_kind, "reparse"),
    [runningReparseJob?.source_kind, runningReparseJob?.step],
  );
  const materialSeedPoints = useMemo(() => readStringList(metadata?.material_seed_points), [metadata]);
  const materialSeedQueries = useMemo(() => readStringList(metadata?.material_seed_queries), [metadata]);
  const sourceDescription = useMemo(() => (typeof metadata?.source_description === "string" ? metadata.source_description.trim() : ""), [metadata]);
  const fullNoteContent = formatReadableNoteMarkdown(richNoteContent || refinedNote || contentQuery.data?.summary || "");
  const savedFrom = useMemo(() => (typeof metadata?.saved_from === "string" ? metadata.saved_from.trim() : ""), [metadata]);
  const sourceQuestion = useMemo(() => (typeof metadata?.question === "string" ? metadata.question.trim() : ""), [metadata]);
  const evidenceSummary = useMemo(() => (typeof metadata?.evidence_summary === "string" ? metadata.evidence_summary.trim() : ""), [metadata]);
  const evidenceDigest = useMemo(() => parseEvidenceDigest(metadata), [metadata]);
  const sourceContentId = useMemo(() => (typeof metadata?.source_content_id === "string" ? metadata.source_content_id.trim() : ""), [metadata]);
  const chunkByIndex = useMemo(() => new Map((contentQuery.data?.chunks ?? []).map((chunk) => [chunk.chunk_index, chunk] as const)), [contentQuery.data?.chunks]);
  const requestedView = normalizeViewKey(searchParams.get("view"));
  const requestedChunkId = searchParams.get("chunkId")?.trim() || "";
  const requestedChunkIndex = useMemo(() => {
    const rawValue = searchParams.get("chunkIndex");
    if (!rawValue?.trim()) {
      return null;
    }
    const parsed = Number.parseInt(rawValue, 10);
    return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
  }, [searchParams]);
  const requestedStartMs = useMemo(() => readNumber(searchParams.get("startMs")), [searchParams]);
  const requestedEndMs = useMemo(() => readNumber(searchParams.get("endMs")), [searchParams]);
  const timestampsAvailable = Boolean(metadata?.timestamps_available) || transcriptSegments.some((item) => item.startMs !== null || item.endMs !== null);
  const timestampsEstimated = Boolean(metadata?.timestamps_estimated);

  useEffect(() => {
    setSelectedVersionId("current");
  }, [contentId, historicalNoteVersions.length, noteStyleValue, refinedNote]);

  useEffect(() => {
    setActiveReparseJobId("");
    setActiveReparseJob(null);
    setReparseFailureMessage("");
  }, [contentId]);
  useEffect(() => {
    if (!activeReparseJobId) {
      return;
    }

    let cancelled = false;
    let timer: number | undefined;
    const pollStartedAt = Date.now();

    const poll = async () => {
      try {
        const job = await getImportJob(activeReparseJobId);
        if (cancelled) {
          return;
        }

        setActiveReparseJob((current) => {
          if (
            current &&
            current.id === job.id &&
            current.status === job.status &&
            current.progress === job.progress &&
            current.step === job.step &&
            current.updated_at === job.updated_at &&
            current.error_message === job.error_message
          ) {
            return current;
          }
          return job;
        });

        if (isImportJobTerminal(job.status)) {
          setActiveReparseJobId("");
          if (job.status === "completed") {
            const jobMetadata =
              job.preview.metadata && typeof job.preview.metadata === "object"
                ? (job.preview.metadata as Record<string, unknown>)
                : {};
            const jobMessage =
              typeof jobMetadata.job_message === "string" && jobMetadata.job_message.trim()
                ? jobMetadata.job_message.trim()
                : "内容已重新解析并覆盖更新。";
            await queryClient.invalidateQueries({ queryKey: ["content", contentId] });
            await queryClient.invalidateQueries({ queryKey: ["contents"] });
            setLocalMessage(jobMessage);
            setActiveReparseJob(null);
            setActiveView("refined");
          } else {
            setReparseFailureMessage(job.error_message || "重新解析失败，请稍后再试。");
            setActiveReparseJob(null);
          }
          return;
        }

        const timeoutState = resolveSharedImportJobTimeoutState(job, pollStartedAt, "reparse");
        if (timeoutState.timedOut) {
          setReparseFailureMessage(job.error_message || timeoutState.message || buildSharedImportTimeoutMessage(job, "reparse"));
          setActiveReparseJobId("");
          setActiveReparseJob(null);
          return;
        }

        timer = window.setTimeout(() => {
          void poll();
        }, 1500);
      } catch (error) {
        if (cancelled) {
          return;
        }
        setReparseFailureMessage(error instanceof Error ? error.message : "读取重解析状态失败");
        setActiveReparseJobId("");
        setActiveReparseJob(null);
      }
    };

    void poll();

    return () => {
      cancelled = true;
      if (timer) {
        window.clearTimeout(timer);
      }
    };
  }, [activeReparseJobId, contentId, queryClient]);
  const targetChunk = useMemo(() => {
    const chunks = contentQuery.data?.chunks ?? [];
    if (!chunks.length) {
      return null;
    }

    if (requestedChunkId) {
      return chunks.find((chunk) => chunk.id === requestedChunkId) ?? null;
    }

    if (requestedChunkIndex !== null) {
      return chunks.find((chunk) => chunk.chunk_index === requestedChunkIndex) ?? null;
    }

    if (requestedStartMs === null && requestedEndMs === null) {
      return null;
    }

    return (
      chunks.find((chunk) => {
        const chunkMetadata = chunk.metadata ?? {};
        const chunkStartMs = readNumber(chunkMetadata.start_ms);
        const chunkEndMs = readNumber(chunkMetadata.end_ms);
        const startMatches = requestedStartMs === null || chunkStartMs === requestedStartMs;
        const endMatches = requestedEndMs === null || chunkEndMs === requestedEndMs;
        return startMatches && endMatches;
      }) ?? null
    );
  }, [contentQuery.data?.chunks, requestedChunkId, requestedChunkIndex, requestedEndMs, requestedStartMs]);
  const targetTranscriptIndex = useMemo(() => {
    if (targetChunk) {
      return targetChunk.chunk_index;
    }

    if (requestedChunkIndex !== null && requestedChunkIndex < transcriptSegments.length) {
      return requestedChunkIndex;
    }

    if (requestedStartMs === null && requestedEndMs === null) {
      return null;
    }

    const matchedIndex = transcriptSegments.findIndex((segment) => {
      const startMatches = requestedStartMs === null || segment.startMs === requestedStartMs;
      const endMatches = requestedEndMs === null || segment.endMs === requestedEndMs;
      return startMatches && endMatches;
    });

    return matchedIndex >= 0 ? matchedIndex : null;
  }, [requestedChunkIndex, requestedEndMs, requestedStartMs, targetChunk, transcriptSegments]);
  const focusRequest = useMemo(() => {
    const targetView =
      requestedView ??
      (targetChunk || targetTranscriptIndex !== null ? "transcript" : null);
    if (!targetView) {
      return null;
    }

    const targetIndex = targetTranscriptIndex ?? targetChunk?.chunk_index ?? null;
    if (targetIndex === null) {
      return null;
    }

    const linkedChunkId = chunkByIndex.get(targetIndex)?.id ?? targetChunk?.id ?? null;
    return {
      key: `transcript:${linkedChunkId ?? targetIndex}`,
      view: "transcript" as const,
      anchorId: buildTranscriptAnchorId(targetIndex, linkedChunkId),
      message: targetChunk ? "已定位到命中的原文位置。" : "已定位到问答引用命中的原文片段。",
    };
  }, [chunkByIndex, requestedView, targetChunk, targetTranscriptIndex]);
  const materialReadiness = useMemo(
    () =>
      getMaterialReadiness(contentQuery.data?.status, {
        transcriptCount: transcriptSegments.length,
        chunkCount: contentQuery.data?.chunks.length ?? 0,
        noteQuality,
        metadata,
      }),
    [contentQuery.data?.chunks.length, contentQuery.data?.status, metadata, noteQuality, transcriptSegments.length],
  );
  const noteDraftValue = useMemo(() => buildNoteDraftValue(noteQuality), [noteQuality]);
  const materialSummaryValue = useMemo(
    () => buildMaterialSummary(transcriptSegments.length, contentQuery.data?.chunks.length ?? 0),
    [contentQuery.data?.chunks.length, transcriptSegments.length],
  );
  const detailInfoItems = useMemo(() => {
    const items = [
      { label: "作者", value: contentQuery.data?.author || "-" },
      { label: "分类", value: contentQuery.data?.category || "未分类" },
      ...(savedFrom === "chat" && sourceQuestion ? [{ label: "来源问题", value: sourceQuestion }] : []),
      { label: "创建时间", value: formatDateTime(contentQuery.data?.created_at) },
      { label: "更新时间", value: formatDateTime(contentQuery.data?.updated_at) },
    ];
    return items;
  }, [
    contentQuery.data?.author,
    contentQuery.data?.category,
    contentQuery.data?.created_at,
    contentQuery.data?.updated_at,
    savedFrom,
    sourceQuestion,
  ]);

  const updateMutation = useMutation({
    mutationFn: () =>
      updateContent(contentId, {
        title: title.trim(),
        summary: summary.trim(),
        category: category.trim(),
        tags: tags.split(",").map((item) => item.trim()).filter(Boolean),
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["content", contentId] });
      await queryClient.invalidateQueries({ queryKey: ["contents"] });
      setLocalMessage("内容已更新。");
    },
  });

  const annotationsMutation = useMutation({
    mutationFn: (data: Record<number, SegmentAnnotation>) =>
      updateContent(contentId, { annotations: data }),
    onSuccess: () => {
      try { localStorage.removeItem(`annotations:${contentId}`); } catch {}
    },
  });

  const deleteMutation = useMutation({
    mutationFn: () => deleteContent(contentId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["contents"] });
      navigate("/library");
    },
  });

  const exportMutation = useMutation({ mutationFn: (withAnnotations?: boolean) => exportContentMarkdown(contentId, { includeAnnotations: withAnnotations }) });
  const reindexMutation = useMutation({
    mutationFn: () => reindexContent(contentId),
  });
  const reparseMutation = useMutation({
    mutationFn: () =>
      reparseContent(contentId, {
        note_style: typeof metadata?.note_style === "string" ? metadata.note_style : undefined,
        summary_focus: typeof metadata?.summary_focus === "string" ? metadata.summary_focus : undefined,
        note_generation_mode: reparseNoteGenerationMode,
        async_mode: true,
      }),
    onMutate: () => {
      setReparseFailureMessage("");
      setActiveReparseJobId("");
      setActiveReparseJob(null);
    },
    onSuccess: async (result) => {
      if (result.job && !isImportJobTerminal(result.job.status)) {
        setLocalMessage(result.message || "已开始后台重新解析，完成后会自动刷新当前内容。");
        setActiveReparseJobId(result.job.id);
        setActiveReparseJob(result.job);
        return;
      }
      await queryClient.invalidateQueries({ queryKey: ["content", contentId] });
      await queryClient.invalidateQueries({ queryKey: ["contents"] });
      setLocalMessage(result.message || "内容已重新解析并覆盖更新。");
      setActiveView("refined");
    },
    onError: (error) => {
      setReparseFailureMessage(error instanceof Error ? error.message : "启动重解析失败，请稍后再试。");
    },
  });
  const restoreNoteVersionMutation = useMutation({
    mutationFn: (versionId: string) => restoreNoteVersion(contentId, { version_id: versionId }),
    onSuccess: async (result) => {
      await queryClient.invalidateQueries({ queryKey: ["content", contentId] });
      await queryClient.invalidateQueries({ queryKey: ["contents"] });
      setLocalMessage(result.message);
      setSelectedVersionId("current");
      setActiveView("refined");
    },
  });

  useEffect(() => {
    if (!focusRequest) {
      lastAppliedFocusKeyRef.current = "";
      setFocusedAnchorId("");
      return;
    }

    if (lastAppliedFocusKeyRef.current === focusRequest.key) {
      return;
    }

    if (activeView !== focusRequest.view) {
      setActiveView(focusRequest.view);
      return;
    }

    const targetElement = transcriptCardRefs.current.get(focusRequest.anchorId);
    if (!targetElement) {
      return;
    }

    lastAppliedFocusKeyRef.current = focusRequest.key;
    setFocusedAnchorId(focusRequest.anchorId);
    setLocalMessage(focusRequest.message);
    targetElement.scrollIntoView({ behavior: "smooth", block: "center" });
    targetElement.focus({ preventScroll: true });

    const timer = window.setTimeout(() => {
      setFocusedAnchorId((current) => (current === focusRequest.anchorId ? "" : current));
    }, 2400);

    return () => window.clearTimeout(timer);
  }, [activeView, focusRequest]);

  if (contentQuery.isLoading) return (
    <section className="page detail-page">
      <div className="skeleton-detail-header">
        <div className="skeleton skeleton-title" />
        <div className="skeleton skeleton-meta" />
        <div className="skeleton skeleton-meta" style={{ width: "60%" }} />
      </div>
      <div className="skeleton skeleton-body" />
      <div className="skeleton skeleton-body" style={{ height: 80 }} />
      <div className="skeleton skeleton-body" style={{ height: 120 }} />
    </section>
  );
  if (contentQuery.isError || !contentQuery.data) return <section className="page"><p className="error-text">{displayText("无法读取当前内容，请返回知识库后重试。")}</p></section>;

  async function handleCopyText(text: string, label: string) {
    try {
      if (!navigator.clipboard?.writeText) throw new Error("clipboard unavailable");
      await navigator.clipboard.writeText(text);
      setLocalMessage(`${label} 已复制。`);
    } catch {
      setLocalMessage("当前浏览环境不支持自动复制，请手动复制。");
    }
  }

  function handleDelete() {
    if (window.confirm(displayText("确认将这条内容移入回收站吗？"))) deleteMutation.mutate();
  }

  function handleRestoreSelectedVersion() {
    if (selectedNoteVersion.id === "current") return;
    if (!window.confirm(displayText("确认将这一版恢复为当前版本吗？当前版本会自动保留进历史记录。"))) {
      return;
    }
    restoreNoteVersionMutation.mutate(selectedNoteVersion.id);
  }

  const heroMetaItems = [
    { label: "完整度", value: typeof noteQuality?.score === "number" ? `${noteQuality.score} 分` : qualityInfo.label },
    { label: "材料", value: materialSummaryValue },
    { label: "时间", value: noteQuality?.time_jump_ready ? "可回跳" : timestampsAvailable ? "部分可用" : "未提供" },
    { label: "笔记", value: noteDraftValue },
  ];

  return (
    <section className="page note-workbench-page">
      <article className="card detail-hero glass-hero product-detail-hero compact-detail-hero">
        <div className="compact-hero-stack">
          <div className="panel-heading">
            <div style={{ flex: 1 }}>
              <p className="eyebrow">{displayText("AI 知识笔记")}</p>
              {isEditingMeta ? (
                <input
                  className="inline-edit-field detail-title-input"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  onBlur={() => updateMutation.mutate()}
                  autoFocus
                />
              ) : (
                <h2
                  className="detail-title"
                  style={{ cursor: "text" }}
                  title="点击编辑标题"
                  onClick={() => setIsEditingMeta(true)}
                >
                  {displayText(contentQuery.data.title)}
                </h2>
              )}
              {isEditingMeta ? (
                <textarea
                  className="inline-edit-field detail-summary-input"
                  value={summary}
                  onChange={(e) => setSummary(e.target.value)}
                  rows={2}
                />
              ) : null}
            </div>
            <button
              className="btn btn-ghost btn-sm"
              type="button"
              onClick={() => { if (isEditingMeta) updateMutation.mutate(); setIsEditingMeta((v) => !v); }}
              style={{ alignSelf: "flex-start", marginTop: 4 }}
            >
              {isEditingMeta ? displayText("保存") : displayText("编辑")}
            </button>
          </div>

          <div className="pill-row" style={{ alignItems: "center" }}>
            <span className="pill">{displayText(contentQuery.data.platform ?? "未知平台")}</span>
            <span className="pill">{displayText(qualityInfo.label)}</span>
            <span className="pill">{displayText(transcriptSourceLabel)}</span>
            <span className="pill">{displayText(getNoteGenerationModeLabel(metadata?.note_generation_mode))}</span>
            {metadata?.noisy_asr_detected === true && <span className="pill">{displayText("转写噪声")}</span>}
          </div>
          {isEditingMeta && (
            <div className="tag-edit-row">
              {tagList.map((tag) => (
                <span className="tag-edit-chip" key={tag}>
                  {tag}
                  <span
                    className="tag-edit-chip-remove"
                    role="button"
                    aria-label={`删除标签 ${tag}`}
                    onClick={() => setTags(tagList.filter((t) => t !== tag).join(", "))}
                  >×</span>
                </span>
              ))}
              <input
                className="tag-add-input"
                placeholder="+ 添加标签"
                value={newTagInput}
                onChange={(e) => setNewTagInput(e.target.value)}
                onKeyDown={(e) => {
                  if ((e.key === "Enter" || e.key === ",") && newTagInput.trim()) {
                    e.preventDefault();
                    setTags([...tagList, newTagInput.trim()].join(", "));
                    setNewTagInput("");
                  }
                }}
              />
            </div>
          )}

          <div className="detail-hero-meta-strip" aria-label={displayText("当前状态")}>
            {heroMetaItems.map((item) => (
              <article className="detail-hero-meta-item" key={item.label}>
                <span>{displayText(item.label)}</span>
                <strong>{displayText(item.value)}</strong>
              </article>
            ))}
          </div>

          <div className="detail-hero-actions">
            <div className="detail-reparse-mode-panel">
              <div className="detail-reparse-mode-copy">
                <span>{displayText("重解析成稿")}</span>
                <strong>{displayText(REPARSE_MODE_ITEMS.find((item) => item.value === reparseNoteGenerationMode)?.label || "混合模式")}</strong>
                <p>{displayText(REPARSE_MODE_ITEMS.find((item) => item.value === reparseNoteGenerationMode)?.hint || "先本地整理，再按需要补强可读性。")}</p>
              </div>
              <div className="segment-rail detail-reparse-mode-rail" aria-label={displayText("重解析成稿模式")}>
                {REPARSE_MODE_ITEMS.map((item) => (
                  <button
                    key={item.value}
                    type="button"
                    className={reparseNoteGenerationMode === item.value ? "segment-pill segment-pill-active" : "segment-pill"}
                    onClick={() => setReparseNoteGenerationMode(item.value)}
                    disabled={reparseMutation.isPending || Boolean(runningReparseJob)}
                  >
                    {displayText(item.label)}
                  </button>
                ))}
              </div>
            </div>
            <div className="detail-hero-primary-actions">
              <Link className="primary-button button-link" to={buildScopedChatLink("请基于这条笔记，给我一版更适合复盘的结论整理", { contentId: contentQuery.data.id, title: contentQuery.data.title })}>
                {displayText("继续提问")}
              </Link>
              {contentQuery.data.source_url && (
                <a className="secondary-button button-link" href={contentQuery.data.source_url} target="_blank" rel="noreferrer">
                  {displayText("打开原链接")}
                </a>
              )}
            </div>

            <details className="detail-hero-more-actions">
              <summary>{displayText("更多")}</summary>
              <div className="detail-hero-more-grid">
                <button
                  className="secondary-button"
                  type="button"
                  onClick={() => reparseMutation.mutate()}
                  disabled={reparseMutation.isPending || Boolean(runningReparseJob)}
                >
                  {reparseMutation.isPending || runningReparseJob ? displayText("重解析中...") : displayText("重新解析")}
                </button>
                {!!noteScreenshots.length && (
                  <a className="secondary-button button-link" href="#detail-note-screenshots-gallery">
                    {displayText("关键画面")}
                  </a>
                )}
                <button className="secondary-button" type="button" onClick={() => exportMutation.mutate(false)} disabled={exportMutation.isPending}>
                  {exportMutation.isPending ? displayText("导出中...") : displayText("导出 Markdown")}
                </button>
                {Object.keys(annotations).length > 0 && (
                  <button className="secondary-button" type="button" onClick={() => exportMutation.mutate(true)} disabled={exportMutation.isPending}>
                    {displayText("导出含批注")}
                  </button>
                )}
              </div>
            </details>
          </div>
          {runningReparseJob && (
            <ImportProgressCard
              runningImportJob={runningReparseJob}
              importStepMeta={reparseStepMeta}
              importStageItems={reparseStageItems}
              importStageIndex={reparseStageIndex}
            />
          )}
          {!!reparseFailureMessage && (
            <div className="detail-inline-error-strip" role="status">
              <strong>{displayText("解析失败")}</strong>
              <p>{displayText(reparseFailureMessage)}</p>
            </div>
          )}
          {(qualityGapItems.length > 0 || coverageMissingSections.length > 0) && (
            <details className="smart-inline-details smart-inline-details-block">
              <summary>{displayText("当前缺口")}</summary>
              <div className="smart-inline-panel">
                {qualityGapItems.length > 0 && (
                  <div className="smart-issue-list">
                    {qualityGapItems.map((item) => (
                      <p className="muted-text" key={item}>{displayText(item)}</p>
                    ))}
                  </div>
                )}
                {coverageMissingSections.length > 0 && (
                  <div className="smart-issue-list">
                    {coverageMissingSections.map((item) => (
                      <p className="muted-text" key={item}>{displayText(item)}</p>
                    ))}
                  </div>
                )}
              </div>
            </details>
          )}
        </div>
      </article>

      <article className="card detail-section-card glass-panel layer-switch-card">
        <div className="segment-rail layer-switch-rail">
          {VIEW_ITEMS.map((item) => (
            <button key={item.key} type="button" className={activeView === item.key ? "segment-pill segment-pill-active" : "segment-pill"} onClick={() => setActiveView(item.key)}>
              {displayText(item.label)}
            </button>
          ))}
        </div>
      </article>

      <div className="note-layout-grid">
        <div className="note-main-column">
          {activeView === "refined" && (
            <article className="card detail-section-card glass-panel product-reading-card">
              {savedFrom === "chat" && (
                <div className="chat-note-insight-block">
                  {sourceQuestion && (
                    <article className="detail-material-item">
                      <span className="eyebrow">{displayText("问题来源")}</span>
                      <p>{displayText(sourceQuestion)}</p>
                    </article>
                  )}

                  {!!evidenceDigest.length && (
                    <div className="detail-material-list">
                      {evidenceDigest.slice(0, 3).map((item) => (
                        <article className="detail-material-item" key={`${item.title}-${item.anchor}-${item.line}`}>
                          <span className="eyebrow">{displayText(item.timeLabel || item.anchor || "原文片段")}</span>
                          <strong>{displayText(item.title)}</strong>
                          <p>{displayText(item.snippet || item.line)}</p>
                        </article>
                      ))}
                    </div>
                  )}

                  {evidenceSummary && (
                    <p className="muted-text detail-chat-evidence-summary">{displayText(evidenceSummary)}</p>
                  )}

                  <div className="header-actions">
                    {sourceContentId && (
                      <Link className="secondary-button button-link" to={`/library/${sourceContentId}`}>
                        {displayText("打开来源内容")}
                      </Link>
                    )}
                    <Link
                      className="secondary-button button-link"
                      to={buildScopedChatLink("请基于这张问答卡片，把结论和原文整理成更适合复盘的版本", {
                        contentId: contentQuery.data.id,
                        title: contentQuery.data.title,
                      })}
                    >
                      {displayText("继续提问")}
                    </Link>
                  </div>
                </div>
              )}

              {isBiliNoteStyle && (
                <section className="bilinote-reading-panel">
                  <div className="panel-heading">
                    <div>
                      <p className="eyebrow">{displayText("内容阅读")}</p>
                      <h3>{displayText(contentQuery.data.platform === "webpage" ? "网页阅读" : "视频阅读")}</h3>
                    </div>
                    <div className="pill-row">
                      {!!timelineItems.length && <span className="pill">{displayText(`${timelineItems.length} 个时间点`)}</span>}
                      {!!noteScreenshots.length && <span className="pill">{displayText(`${noteScreenshots.length} 张关键画面`)}</span>}
                    </div>
                  </div>

                  {(overviewItems.length > 0 || focusNote || coreConclusion || memoryPoints.length > 0) && (
                    <div className="bilinote-reading-grid">
                      {overviewItems.length > 0 && (
                        <article className="bilinote-reading-card">
                          <span className="eyebrow">{displayText("速览")}</span>
                          <div className="bilinote-overview-list">
                            {overviewItems.map((item) => (
                              <div className="bilinote-overview-row" key={`${item.label}-${item.value}`}>
                                <span>{displayText(item.label)}</span>
                                <strong>{displayText(item.value || "-")}</strong>
                              </div>
                            ))}
                          </div>
                        </article>
                      )}

                      {focusNote && (
                        <article className="bilinote-reading-card">
                          <span className="eyebrow">{displayText("本次关注")}</span>
                          <strong>{displayText("整理焦点")}</strong>
                          <p>{displayText(focusNote)}</p>
                        </article>
                      )}

                      {coreConclusion && (
                        <article className="bilinote-reading-card">
                          <span className="eyebrow">{displayText("核心结论")}</span>
                          <strong>{displayText("核心摘要")}</strong>
                          <p>{displayText(coreConclusion)}</p>
                        </article>
                      )}

                      {!!memoryPoints.length && (
                        <article className="bilinote-reading-card">
                          <span className="eyebrow">{displayText("核心要点")}</span>
                          <div className="bilinote-bullet-list">
                            {memoryPoints.map((point) => (
                              <p key={point}>{displayText(`• ${point}`)}</p>
                            ))}
                          </div>
                        </article>
                      )}
                    </div>
                  )}

                  {!!stageDigestItems.length && (
                    <StageDigest
                      eyebrow="阶段"
                      title="重点"
                      items={stageDigestItems}
                      className="detail-stage-digest"
                    />
                  )}

                  {!!timelineItems.length && (
                    <div className="bilinote-section-stack">
                      <div className="panel-heading">
                        <div>
                          <p className="eyebrow">{displayText("时间线笔记")}</p>
                          <h4>{displayText("时间锚点")}</h4>
                        </div>
                      </div>
                      <div className="bilinote-timeline-grid">
                        {timelineItems.map((item) =>
                          item.href ? (
                            <a className="bilinote-timeline-card" key={`${item.label}-${item.href}`} href={item.href} target="_blank" rel="noreferrer">
                              <span className="eyebrow">{displayText(item.label)}</span>
                              <strong>{displayText(item.summary || "打开原视频对应时间点")}</strong>
                            </a>
                          ) : (
                            <article className="bilinote-timeline-card" key={`${item.label}-${item.summary}`}>
                              <span className="eyebrow">{displayText(item.label)}</span>
                              <strong>{displayText(item.summary || "已保留该时间点摘要")}</strong>
                            </article>
                          ),
                        )}
                      </div>
                    </div>
                  )}

                  {!!noteScreenshots.length && (
                    <details className="bilinote-section-stack detail-media-disclosure" id="detail-note-screenshots-gallery">
                      <summary className="detail-media-summary">
                        <strong>{displayText("关键画面")}</strong>
                        <span className="pill">{displayText(`${noteScreenshots.length} 张`)}</span>
                      </summary>
                      <div className="detail-media-body">
                        <div className="bilinote-screenshot-grid">
                          {noteScreenshots.map((item) => {
                            const cardBody = (
                              <>
                                <div className="bilinote-screenshot-image-wrap">
                                  <img
                                    className="bilinote-screenshot-image"
                                    src={item.imageUrl}
                                    alt={item.caption || item.timestampLabel || "关键画面"}
                                    loading="lazy"
                                  />
                                </div>
                                <div className="bilinote-screenshot-copy">
                                  <span className="eyebrow">{displayText(item.rangeLabel || item.timestampLabel || "关键画面")}</span>
                                  <strong>{displayText(item.timestampLabel || "关键画面")}</strong>
                                  <p>{displayText(shortenText(item.caption || item.sourceText || "已保留当前关键时间点画面。", 120))}</p>
                                </div>
                              </>
                            );
                            return item.seekUrl ? (
                              <a
                                className="bilinote-screenshot-card"
                                key={item.id}
                                href={item.seekUrl}
                                target="_blank"
                                rel="noreferrer"
                              >
                                {cardBody}
                              </a>
                            ) : (
                              <article className="bilinote-screenshot-card" key={item.id}>
                                {cardBody}
                              </article>
                            );
                          })}
                        </div>
                      </div>
                    </details>
                  )}

                  {!noteScreenshots.length && noteScreenshotStatus && noteScreenshotStatus !== "skipped" && noteScreenshotSummary && (
                    <div className="glass-callout">
                      <strong>{displayText("画面未生成")}</strong>
                      <p className="muted-text">{displayText(noteScreenshotSummary)}</p>
                    </div>
                  )}

                </section>
              )}

              {!isBiliNoteStyle && !!noteScreenshots.length && (
                <details className="bilinote-section-stack detail-generic-screenshot-section detail-media-disclosure" id="detail-note-screenshots-gallery">
                  <summary className="detail-media-summary">
                    <strong>{displayText("关键画面")}</strong>
                    <span className="pill">{displayText(`${noteScreenshots.length} 张`)}</span>
                  </summary>
                  <div className="detail-media-body">
                    <div className="bilinote-screenshot-grid">
                      {noteScreenshots.map((item) => {
                        const cardBody = (
                          <>
                            <div className="bilinote-screenshot-image-wrap">
                              <img
                                className="bilinote-screenshot-image"
                                src={item.imageUrl}
                                alt={item.caption || item.timestampLabel || "关键画面"}
                                loading="lazy"
                              />
                            </div>
                            <div className="bilinote-screenshot-copy">
                              <span className="eyebrow">{displayText(item.rangeLabel || item.timestampLabel || "关键画面")}</span>
                              <strong>{displayText(item.timestampLabel || "关键画面")}</strong>
                              <p>{displayText(shortenText(item.caption || item.sourceText || "已保留当前关键时间点画面。", 120))}</p>
                            </div>
                          </>
                        );
                        return item.seekUrl ? (
                          <a
                            className="bilinote-screenshot-card"
                            key={item.id}
                            href={item.seekUrl}
                            target="_blank"
                            rel="noreferrer"
                          >
                            {cardBody}
                          </a>
                        ) : (
                          <article className="bilinote-screenshot-card" key={item.id}>
                            {cardBody}
                          </article>
                        );
                      })}
                    </div>
                  </div>
                </details>
              )}

              {!isBiliNoteStyle && !noteScreenshots.length && noteScreenshotStatus && noteScreenshotStatus !== "skipped" && noteScreenshotSummary && (
                <div className="glass-callout">
                  <strong>{displayText("画面未生成")}</strong>
                  <p className="muted-text">{displayText(noteScreenshotSummary)}</p>
                </div>
              )}

              <section className="detail-inline-disclosure detail-note-disclosure">
                <div className="detail-disclosure-head">
                  <div>
                    <p className="eyebrow">{displayText(isEditingNote ? "编辑笔记" : "完整笔记")}</p>
                    <strong>{displayText(isEditingNote ? "编辑中" : "正文")}</strong>
                  </div>
                  <div className="detail-disclosure-actions">
                    {isBiliNoteStyle && (
                      <button
                        className="btn btn-ghost btn-sm"
                        type="button"
                        onClick={() => setShowFullNote((v) => !v)}
                      >
                        {showFullNote ? displayText("收起正文") : displayText("展开正文")}
                      </button>
                    )}
                    <button
                      className="btn btn-ghost btn-sm"
                      type="button"
                      onClick={() => {
                        setShowFullNote(true);
                        setIsEditingNote((v) => !v);
                      }}
                    >
                      {isEditingNote ? displayText("完成编辑") : displayText("编辑笔记")}
                    </button>
                    <button className="btn btn-ghost btn-sm" type="button" onClick={() => void handleCopyText(fullNoteContent, "当前笔记")}>
                      {displayText("复制")}
                    </button>
                  </div>
                </div>
                {(showFullNote || isEditingNote || !isBiliNoteStyle) && (
                  isEditingNote ? (
                    <RichNoteEditor
                    content={fullNoteContent}
                    editable
                    onChange={setRichNoteContent}
                    onSave={(html) => {
                      updateContent(contentId, { summary: contentQuery.data?.summary ?? "" }).catch(() => {});
                      setLocalMessage("笔记已自动保存。");
                      setTimeout(() => setLocalMessage(""), 2000);
                      void html;
                    }}
                    placeholder="在这里继续整理笔记，支持标题、加粗、列表、高亮..."
                    />
                  ) : (
                    <MarkdownNoteView markdown={fullNoteContent} />
                  )
                )}
              </section>
            </article>
          )}

          {activeView === "transcript" && (
            <article className="card detail-section-card glass-panel">
              <div className="glass-callout transcript-callout">
                <strong>{displayText("原文片段")}</strong>
                <p className="muted-text">{displayText(qualityInfo.description)}</p>
                <div className="pill-row">
                  <span className="pill">{displayText(transcriptSourceLabel)}</span>
                  {captureRouteSummary ? <span className="pill">{displayText(captureRouteSummary)}</span> : null}
                  {typeof metadata?.asr_model_used === "string" && metadata.asr_model_used.trim() ? (
                    <span className="pill">{displayText(String(metadata.asr_model_used))}</span>
                  ) : null}
                </div>
                {qualityInfo.actionLabel && (
                  <Link className="secondary-button button-link" to="/settings">
                    {displayText(qualityInfo.actionLabel)}
                  </Link>
                )}
              </div>

              {transcriptSegments.length > 0 ? (
                <div className="transcript-timeline">
                  {transcriptSegments.map((segment, index) => {
                    const linkedChunk = chunkByIndex.get(index);
                    const label = formatTimeRange(segment.startMs, segment.endMs, segment.timestampLabel);
                    const jumpUrl = resolveSeekUrl(segment.seekUrl, contentQuery.data.source_url, segment.startMs);
                    const transcriptAnchorId = buildTranscriptAnchorId(index, linkedChunk?.id);
                    const ann = annotations[index] ?? { highlight: "", note: "" };
                    const highlightClass = ann.highlight ? ` segment-highlight-${ann.highlight}` : "";
                    const transcriptCardClassName =
                      focusedAnchorId === transcriptAnchorId
                        ? `card detail-section-card glass-panel transcript-card detail-section-card-focused${highlightClass}`
                        : `card detail-section-card glass-panel transcript-card${highlightClass}`;
                    return (
                      <article
                        className={transcriptCardClassName}
                        key={`${index}-${label}`}
                        ref={(element) => {
                          if (element) {
                            transcriptCardRefs.current.set(transcriptAnchorId, element);
                          } else {
                            transcriptCardRefs.current.delete(transcriptAnchorId);
                          }
                        }}
                        tabIndex={-1}
                      >
                        <div className="panel-heading transcript-card-head">
                          <div>
                            <p className="eyebrow">{displayText(label || `片段 ${index + 1}`)}</p>
                            <h4>{displayText(getSegmentSourceLabel(segment.sourceKind))}</h4>
                          </div>
                          <div className="pill-row">
                            <span className="pill">{displayText(segment.qualityLevel)}</span>
                            {timestampsEstimated && <span className="pill">{displayText("估算定位")}</span>}
                          </div>
                        </div>
                        <pre className="content-pre glass-pre transcript-pre">{displayText(segment.text)}</pre>
                        {(linkedChunk?.heading?.trim() || linkedChunk?.summary?.trim()) && (
                          <article className="glass-callout transcript-linked-summary">
                            <strong>{displayText(linkedChunk?.heading?.trim() || "整理摘要")}</strong>
                            {linkedChunk?.summary?.trim() && linkedChunk.summary.trim() !== segment.text.trim() ? (
                              <p className="muted-text">{displayText(linkedChunk.summary.trim())}</p>
                            ) : null}
                          </article>
                        )}
                        <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 6 }}>
                          <div className={`highlight-picker${ann.highlight ? " visible" : ""}`}>
                            {(["yellow", "blue", "green"] as HighlightColor[]).map((color) => (
                              <button
                                key={color}
                                type="button"
                                className={`highlight-dot highlight-dot-${color}`}
                                title={color === "yellow" ? "黄色高亮" : color === "blue" ? "蓝色高亮" : "绿色高亮"}
                                onClick={() => setAnnotation(index, { highlight: ann.highlight === color ? "" : color })}
                                style={{ outline: ann.highlight === color ? "2px solid var(--border-focus)" : undefined }}
                              />
                            ))}
                            <button
                              type="button"
                              className="highlight-dot highlight-dot-clear"
                              title="清除高亮"
                              onClick={() => setAnnotation(index, { highlight: "" })}
                            />
                          </div>
                          <button
                            type="button"
                            className={`annotation-trigger${annotatingIndex === index || ann.note ? " visible" : ""}`}
                            onClick={() => setAnnotatingIndex((v) => v === index ? null : index)}
                          >
                            {ann.note ? "查看批注" : "+ 批注"}
                          </button>
                        </div>
                        {(annotatingIndex === index || ann.note) && (
                          <div className="annotation-bubble">
                            <textarea
                              className="annotation-input"
                              placeholder="写下你的批注..."
                              value={ann.note}
                              rows={ann.note ? Math.max(2, ann.note.split("\n").length) : 2}
                              onChange={(e) => setAnnotation(index, { note: e.target.value })}
                              onBlur={() => { if (!ann.note) setAnnotatingIndex(null); }}
                            />
                          </div>
                        )}
                        <div className="header-actions">
                          <button className="secondary-button" type="button" onClick={() => void handleCopyText(segment.text, label || `片段 ${index + 1}`)}>
                            {displayText("复制片段")}
                          </button>
                          <Link className="secondary-button button-link" to={buildScopedChatLink("请只围绕这个时间片段解释它最值得记住的内容", { contentId: contentQuery.data.id, chunkId: linkedChunk?.id, title: contentQuery.data.title, chunkLabel: linkedChunk?.heading || label })}>
                            {displayText("围绕它提问")}
                          </Link>
                          {jumpUrl && <a className="primary-button button-link" href={jumpUrl} target="_blank" rel="noreferrer" title={displayText("将在浏览器中打开原视频对应时间点")}>{displayText("回到这个时间点")}</a>}
                        </div>
                      </article>
                    );
                  })}
                </div>
              ) : contentQuery.data.chunks.length > 0 ? (
                <div className="citation-list">
                  {contentQuery.data.chunks.map((chunk) => {
                    const chunkMeta = chunk.metadata ?? {};
                    const startMs = readNumber(chunkMeta.start_ms);
                    const label = formatTimeRange(startMs, readNumber(chunkMeta.end_ms), typeof chunkMeta.timestamp_label === "string" ? chunkMeta.timestamp_label : chunk.heading);
                    const jumpUrl = resolveSeekUrl(typeof chunkMeta.seek_url === "string" ? chunkMeta.seek_url : null, contentQuery.data.source_url, startMs);
                    const transcriptAnchorId = buildTranscriptAnchorId(chunk.chunk_index, chunk.id);
                    const chunkLabel = chunk.heading?.trim() ? `片段 ${chunk.chunk_index + 1} · ${chunk.heading.trim()}` : `片段 ${chunk.chunk_index + 1}`;
                    const chunkCardClassName =
                      focusedAnchorId === transcriptAnchorId
                        ? "card detail-section-card glass-panel chunk-glass-card detail-section-card-focused"
                        : "card detail-section-card glass-panel chunk-glass-card";
                    return (
                      <article
                        className={chunkCardClassName}
                        key={chunk.id}
                        ref={(element) => {
                          if (element) {
                            transcriptCardRefs.current.set(transcriptAnchorId, element);
                          } else {
                            transcriptCardRefs.current.delete(transcriptAnchorId);
                          }
                        }}
                        tabIndex={-1}
                      >
                        <div className="panel-heading">
                          <div>
                            <p className="eyebrow">{displayText(label || chunkLabel)}</p>
                            <h4>{displayText(chunk.heading?.trim() || "已整理原文")}</h4>
                          </div>
                          <span className="pill">{displayText("整理片段")}</span>
                        </div>
                        {chunk.summary?.trim() ? (
                          <article className="glass-callout transcript-linked-summary">
                            <strong>{displayText("摘要")}</strong>
                            <p className="muted-text">{displayText(chunk.summary.trim())}</p>
                          </article>
                        ) : null}
                        <pre className="content-pre glass-pre compact-pre">{displayText(chunk.chunk_text)}</pre>
                        <div className="header-actions">
                          <button className="secondary-button" type="button" onClick={() => void handleCopyText(chunk.chunk_text, chunkLabel)}>
                            {displayText("复制片段")}
                          </button>
                          <Link className="secondary-button button-link" to={buildScopedChatLink("请只基于这个片段回答，并整理最值得记住的观点", { contentId: contentQuery.data.id, chunkId: chunk.id, title: contentQuery.data.title, chunkLabel })}>
                            {displayText("围绕它追问")}
                          </Link>
                          {jumpUrl && <a className="primary-button button-link" href={jumpUrl} target="_blank" rel="noreferrer" title={displayText("将在浏览器中打开原视频对应时间点")}>{displayText("根据时间戳回看")}</a>}
                        </div>
                      </article>
                    );
                  })}
                </div>
              ) : (
                <pre className="content-pre glass-pre source-pre">{displayText(rawTranscript || contentQuery.data.content_text || "当前没有可展示的原始转写。")}</pre>
              )}
            </article>
          )}
        </div>

        <div className="note-side-column">
          <article className="card detail-section-card glass-panel note-side-actions">
            {localMessage && <p className="success-text">{displayText(localMessage)}</p>}
            {exportMutation.isSuccess && <p className="success-text">{displayText(`导出成功：${exportMutation.data.path}`)}</p>}
            {reparseMutation.isError && <p className="error-text">{displayText("重新解析失败，请确认原始链接或文件仍可访问。")}</p>}
            {restoreNoteVersionMutation.isError && <p className="error-text">{displayText("恢复历史版本失败，请稍后重试。")}</p>}
            {exportMutation.isError && <p className="error-text">{displayText("导出失败，请稍后再试。")}</p>}

            <article className="glass-callout detail-side-summary">
              <strong>{displayText(materialReadiness.title)}</strong>
              <p className="muted-text">{displayText(materialReadiness.description)}</p>
            </article>

            <details className="detail-side-disclosure detail-side-stack">
              <summary>{displayText("更多")}</summary>

              {historicalNoteVersions.length > 0 && (
                <section className="detail-side-subsection">
                  <div className="detail-side-subsection-head">
                    <strong>{displayText(`版本 ${historicalNoteVersions.length}`)}</strong>
                  </div>
                  <div className="bili-note-history-list">
                    {noteVersionItems.map((item, index) => {
                      const selected = selectedNoteVersion.id === item.id;
                      return (
                        <button
                          key={`${item.id}-${index}`}
                          type="button"
                          className={selected ? "bili-note-history-item bili-note-history-item-active" : "bili-note-history-item"}
                          onClick={() => setSelectedVersionId(item.id)}
                        >
                          <div className="bili-note-history-item-head">
                            <div className="pill-row">
                              <span className="pill">{displayText(getNoteVersionSourceLabel(item.source))}</span>
                            </div>
                            <span className="muted-text">{displayText(item.capturedAt ? formatDateTime(item.capturedAt) : "未记录时间")}</span>
                          </div>
                          <strong>{displayText(item.summaryFocus || item.title || "未命名版本")}</strong>
                        </button>
                      );
                    })}
                  </div>

                  <div className="bili-note-preview-block">
                    <div className="bili-note-preview-head">
                      <div>
                        <p className="eyebrow">{displayText("当前选中版本")}</p>
                        <h3>{displayText(selectedNoteVersion.summaryFocus || selectedNoteVersion.title || "未命名版本")}</h3>
                      </div>
                      <div className="pill-row">
                        <span className="pill">{displayText(getNoteVersionSourceLabel(selectedNoteVersion.source))}</span>
                      </div>
                    </div>

                    <div className="bili-note-preview-meta">
                      <article className="bili-note-preview-meta-card">
                        <span>{displayText("保存时间")}</span>
                        <strong>{displayText(selectedNoteVersion.capturedAt ? formatDateTime(selectedNoteVersion.capturedAt) : "当前页面")}</strong>
                      </article>
                      <article className="bili-note-preview-meta-card">
                        <span>{displayText("正文来源")}</span>
                        <strong>{displayText(getTranscriptSourceLabel(selectedNoteVersion.transcriptSource || metadata?.transcript_source))}</strong>
                      </article>
                    </div>

                    {!!selectedVersionStageDigestItems.length && (
                      <StageDigest
                        eyebrow="版本"
                        title="重点"
                        items={selectedVersionStageDigestItems}
                        compact
                        className="detail-version-stage-digest"
                      />
                    )}

                    {!selectedVersionStageDigestItems.length && !!selectedNoteVersion.keyPoints.length && (
                      <div className="bilinote-bullet-list">
                        {selectedNoteVersion.keyPoints.slice(0, 4).map((point) => (
                          <p key={`${selectedNoteVersion.id}-${point}`}>{displayText(`- ${point}`)}</p>
                        ))}
                      </div>
                    )}

                    <div className="header-actions bili-note-preview-actions">
                      <button
                        className="secondary-button"
                        type="button"
                        onClick={() => void handleCopyText(selectedNoteVersion.noteMarkdown || selectedNoteVersion.summary || "", "当前版本快照")}
                      >
                        {displayText("复制这版笔记")}
                      </button>
                      {selectedNoteVersion.id !== "current" && (
                        <button
                          className="primary-button"
                          type="button"
                          onClick={handleRestoreSelectedVersion}
                          disabled={restoreNoteVersionMutation.isPending}
                        >
                          {restoreNoteVersionMutation.isPending ? displayText("恢复中...") : displayText("恢复为当前版本")}
                        </button>
                      )}
                      {selectedNoteVersion.id !== "current" && (
                        <button className="secondary-button" type="button" onClick={() => setSelectedVersionId("current")}>
                          {displayText("回到当前版本")}
                        </button>
                      )}
                    </div>
                  </div>
                </section>
              )}

              <section className="detail-side-subsection">
                <div className="detail-side-subsection-head">
                  <strong>{displayText("来源与标签")}</strong>
                </div>
                {(materialSeedPoints.length > 0 || sourceDescription) && (
                  <div className="detail-side-group">
                    {materialSeedPoints.length > 0 ? (
                      <div className="detail-material-list">
                        {materialSeedPoints.slice(0, 4).map((item) => (
                          <article className="detail-material-item" key={item}>
                            <p>{displayText(item)}</p>
                          </article>
                        ))}
                      </div>
                    ) : (
                      <div className="glass-callout">
                        <strong>{displayText("来源简介")}</strong>
                        <p className="muted-text">{displayText(sourceDescription)}</p>
                      </div>
                    )}
                  </div>
                )}

                <div className="info-list compact-info-list">
                  {detailInfoItems.map((item) => (
                    <div key={`${item.label}-${item.value}`}>
                      <dt>{displayText(item.label)}</dt>
                      <dd>{displayText(item.value)}</dd>
                    </div>
                  ))}
                </div>

                <div className="tag-row-soft">
                  {contentQuery.data.tags.length ? contentQuery.data.tags.map((tag) => <span className="pill" key={tag}>{displayText(tag)}</span>) : <span className="pill">{displayText("暂无标签")}</span>}
                </div>
              </section>

              <section className="detail-side-subsection">
                <div className="detail-side-subsection-head">
                  <strong>{displayText("派生内容")}</strong>
                  <div className="pill-row">
                    <button
                      type="button"
                      className={deriveView === "mindmap" ? "segment-pill segment-pill-active" : "segment-pill"}
                      onClick={() => setDeriveView(deriveView === "mindmap" ? "none" : "mindmap")}
                    >
                      {displayText("思维导图")}
                    </button>
                    <button
                      type="button"
                      className={deriveView === "quiz" ? "segment-pill segment-pill-active" : "segment-pill"}
                      onClick={() => setDeriveView(deriveView === "quiz" ? "none" : "quiz")}
                    >
                      {displayText("随堂测验")}
                    </button>
                  </div>
                </div>

                {deriveView === "none" && (
                  <p className="muted-text">{displayText("按需展开思维导图或测验，需要时再生成。")}</p>
                )}

                {deriveView === "mindmap" && (
                  <div className="derive-content">
                    {derivedMindmap ? (
                      <>
                        <div className="derive-mindmap-tree">
                          <MindmapNode node={derivedMindmap.data as MindmapNodeData} depth={0} />
                        </div>
                        <div className="header-actions" style={{ marginTop: 12 }}>
                          <button
                            type="button"
                            className="secondary-button"
                            onClick={() => void handleExportDerived(derivedMindmap.id, `${derivedMindmap.title}.md`)}
                          >
                            {displayText("导出 Markdown")}
                          </button>
                          <button
                            type="button"
                            className="danger-button"
                            onClick={async () => {
                              await deleteDerivedMutation.mutateAsync(derivedMindmap.id);
                              mindmapMutation.mutate();
                            }}
                            disabled={deleteDerivedMutation.isPending || mindmapMutation.isPending}
                          >
                            {displayText("重新生成")}
                          </button>
                        </div>
                      </>
                    ) : (
                      <div className="derive-empty">
                        <p className="muted-text">{displayText("还没有思维导图，点击生成。")}</p>
                        <button
                          type="button"
                          className="primary-button"
                          disabled={mindmapMutation.isPending}
                          onClick={() => mindmapMutation.mutate()}
                        >
                          {mindmapMutation.isPending ? displayText("生成中...") : displayText("生成思维导图")}
                        </button>
                        {mindmapMutation.isError && (
                          <p className="muted-text" style={{ color: "var(--error)" }}>
                            {displayText("生成失败，请检查模型配置。")}
                          </p>
                        )}
                      </div>
                    )}
                  </div>
                )}

                {deriveView === "quiz" && (
                  <div className="derive-content">
                    {derivedQuiz ? (
                      <>
                        <div className="derive-quiz-list">
                          {((derivedQuiz.data as { questions?: QuizQuestion[] }).questions ?? []).map(
                            (q: QuizQuestion, idx: number) => (
                              <div key={idx} className="derive-quiz-item card glass-panel">
                                <p className="derive-quiz-question"><strong>{idx + 1}. {q.question}</strong></p>
                                <div className="derive-quiz-options">
                                  {q.options.map((opt) => {
                                    const letter = opt.charAt(0);
                                    const isSelected = quizAnswers[idx] === letter;
                                    const isCorrect = letter === q.answer;
                                    const revealed = quizRevealed[idx];
                                    let cls = "derive-quiz-option";
                                    if (revealed && isCorrect) cls += " derive-quiz-correct";
                                    else if (revealed && isSelected && !isCorrect) cls += " derive-quiz-wrong";
                                    else if (isSelected) cls += " derive-quiz-selected";
                                    return (
                                      <button
                                        key={opt}
                                        type="button"
                                        className={cls}
                                        onClick={() => setQuizAnswers((prev) => ({ ...prev, [idx]: letter }))}
                                      >
                                        {opt}
                                      </button>
                                    );
                                  })}
                                </div>
                                {quizAnswers[idx] && !quizRevealed[idx] && (
                                  <button
                                    type="button"
                                    className="secondary-button"
                                    onClick={() => setQuizRevealed((prev) => ({ ...prev, [idx]: true }))}
                                  >
                                    {displayText("查看答案")}
                                  </button>
                                )}
                                {quizRevealed[idx] && q.explanation && (
                                  <p className="derive-quiz-explanation muted-text">{q.explanation}</p>
                                )}
                              </div>
                            ),
                          )}
                        </div>
                        <div className="header-actions" style={{ marginTop: 12 }}>
                          <button
                            type="button"
                            className="secondary-button"
                            onClick={() => void handleExportDerived(derivedQuiz.id, `${derivedQuiz.title}.txt`)}
                          >
                            {displayText("导出 Anki")}
                          </button>
                          <button
                            type="button"
                            className="danger-button"
                            onClick={async () => {
                              await deleteDerivedMutation.mutateAsync(derivedQuiz.id);
                              setQuizAnswers({});
                              setQuizRevealed({});
                              quizMutation.mutate();
                            }}
                            disabled={deleteDerivedMutation.isPending || quizMutation.isPending}
                          >
                            {displayText("重新生成")}
                          </button>
                        </div>
                      </>
                    ) : (
                      <div className="derive-empty">
                        <p className="muted-text">{displayText("还没有测验题，点击生成。")}</p>
                        <button
                          type="button"
                          className="primary-button"
                          disabled={quizMutation.isPending}
                          onClick={() => quizMutation.mutate()}
                        >
                          {quizMutation.isPending ? displayText("生成中...") : displayText("生成测验")}
                        </button>
                        {quizMutation.isError && (
                          <p className="muted-text" style={{ color: "var(--error)" }}>
                            {displayText("生成失败，请检查模型配置。")}
                          </p>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </section>

              <section className="detail-side-subsection">
                <div className="detail-side-subsection-head">
                  <strong>{displayText("维护")}</strong>
                </div>
                <div className="form-grid detail-form-grid">
                  <label className="form-block">
                    <span className="field-label">{displayText("分类")}</span>
                    <input className="search-input" value={category} onChange={(event) => setCategory(event.target.value)} />
                  </label>
                </div>
                <div className="header-actions">
                  <button className="primary-button" type="button" onClick={() => updateMutation.mutate()} disabled={updateMutation.isPending}>
                    {updateMutation.isPending ? displayText("保存中...") : displayText("保存分类")}
                  </button>
                  <button className="secondary-button" type="button" onClick={() => reindexMutation.mutate()} disabled={reindexMutation.isPending}>
                    {reindexMutation.isPending ? displayText("重建中...") : displayText("重建片段索引")}
                  </button>
                  <button className="danger-button" type="button" onClick={handleDelete} disabled={deleteMutation.isPending}>
                    {deleteMutation.isPending ? displayText("移入中...") : displayText("移入回收站")}
                  </button>
                </div>
                {reindexMutation.isSuccess && <p className="success-text">{displayText(reindexMutation.data.message)}</p>}
                {reindexMutation.isError && <p className="error-text">{displayText("片段索引重建失败，请稍后重试。")}</p>}
              </section>
            </details>
          </article>
        </div>
      </div>
    </section>
  );
}
