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
  listDerivedItems,
  deleteDerivedItem,
  reindexContent,
  reparseContent,
  updateContent,
  type DerivedItem,
  type NoteQuality,
} from "../lib/api";
import { useLanguage } from "../lib/language";
import { formatMilliseconds, formatTimeRange } from "../lib/utils";
import RichNoteEditor from "../components/RichNoteEditor";

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

function getQualityInfo(status: string | null | undefined, metadata: Record<string, unknown> | null | undefined) {
  const captureSummary = typeof metadata?.capture_summary === "string" ? metadata.capture_summary.trim() : "";
  const recommendedAction = typeof metadata?.capture_recommended_action === "string" ? metadata.capture_recommended_action.trim() : "";
  const asrModeLabel = getAsrModeLabel(metadata?.asr_config_mode);
  const noisyAsrDetected = metadata?.noisy_asr_detected === true;

  if (status === "ready" && noisyAsrDetected) {
    return {
      label: "证据就绪，理解待重整",
      description: "当前正文来自音频转写，证据和时间片段已经可用，但语义噪声仍较明显，更适合围绕片段继续问答与核对。",
      actionLabel: "去配置模型",
    };
  }
  if (status === "ready") return { label: "双层笔记已就绪", description: captureSummary || "这条内容已经具备精炼笔记、原始转写和时间定位。", actionLabel: null };
  if (status === "ready_estimated") {
    return {
      label: "正文已恢复",
      description: captureSummary || (asrModeLabel ? `当前正文来自${asrModeLabel}的音频转写，建议核对关键片段。` : "当前正文来自音频转写，建议核对关键片段。"),
      actionLabel: null,
    };
  }
  if (status === "needs_cookie") return { label: "待登录态补全", description: captureSummary || "这条视频的字幕需要登录态，当前只完成了基础建档。", actionLabel: "去检查 B 站增强" };
  if (status === "needs_asr") return { label: "待转写补全", description: captureSummary || "这条视频还没有拿到可直接使用的正文。", actionLabel: "去配置音频转写" };
  if (status === "asr_failed") return { label: "转写待修复", description: captureSummary || recommendedAction || "字幕和转写都没有拿到可用正文。", actionLabel: "去检查转写配置" };
  if (status === "limited") return { label: "仅完成基础建档", description: captureSummary || "当前只拿到了较弱内容，先不要把它当成完整笔记。", actionLabel: null };
  return { label: "基础整理", description: captureSummary || "当前已生成基础档案，适合先看精炼笔记。", actionLabel: null };
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
  if (status === "ready") return "完整材料";
  if (status === "ready_estimated") return "已恢复正文";
  if (status === "needs_cookie") return "缺登录态";
  if (status === "needs_asr") return "缺转写";
  if (status === "asr_failed") return "转写失败";
  if (status === "limited") return "材料较弱";
  if (status === "preview_ready") return "预览建档";
  return "基础建档";
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

  const cards = [
    {
      label: "正文材料",
      value: transcriptReady ? `${transcriptCount} 段` : sourceDescription ? "仅简介" : "未拿到",
      tone: transcriptReady ? "success" : sourceDescription ? "info" : "warning",
    },
    {
      label: "检索片段",
      value: chunkReady ? `${chunkCount} 段` : "待整理",
      tone: chunkReady ? "success" : weakCapture ? "warning" : "info",
    },
    {
      label: "精炼笔记",
      value: noteReady ? "已形成" : weakCapture ? "先保留草稿" : "整理中",
      tone: noteReady ? "success" : weakCapture ? "warning" : "info",
    },
  ] as const;

  let title = "材料已基本就绪";
  let description = "这条内容已经有正文、片段和笔记层，适合直接围绕结论和证据来回看。";
  if (weakCapture) {
    title = "先按种子材料来用";
    description = captureAction || "当前还没拿到足够稳的正文，但系统已经把可用线索整理成了可检索、可追问的草稿。";
  } else if (!noteReady || !chunkReady) {
    title = "材料正在补齐";
    description = captureAction || "当前主链路已通，但片段和精炼层还在继续完善。";
  }

  return {
    statusLabel: getCaptureStatusLabel(status),
    weakCapture,
    title,
    description,
    cards,
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

const QUICK_QUESTIONS = [
  "请把这条笔记整理成一页可直接复盘的结论",
  "如果只保留最值得记住的三点，应该留下什么？",
  "围绕这条内容继续追问时，最应该先展开哪个部分？",
];

const VIEW_ITEMS = [
  { key: "refined", label: "精炼层" },
  { key: "transcript", label: "证据层" },
  { key: "chunks", label: "检索层" },
] as const;

type ViewKey = (typeof VIEW_ITEMS)[number]["key"];

function normalizeViewKey(value: string | null): ViewKey | null {
  if (value === "refined" || value === "transcript" || value === "chunks") {
    return value;
  }
  return null;
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
  const chunkCardRefs = useRef(new Map<string, HTMLElement>());
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
  const [richNoteContent, setRichNoteContent] = useState("");
  const [deriveView, setDeriveView] = useState<"none" | "mindmap" | "quiz">("none");
  const [quizAnswers, setQuizAnswers] = useState<Record<number, string>>({});
  const [quizRevealed, setQuizRevealed] = useState<Record<number, boolean>>({});

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
    setRichNoteContent(raw || "");
  }, [contentQuery.data]);

  const metadata = useMemo<Record<string, unknown> | null>(() => {
    const value = contentQuery.data?.metadata;
    return value && typeof value === "object" ? value : null;
  }, [contentQuery.data]);
  const refinedNote = useMemo(() => {
    const refined = metadata?.refined_note_markdown;
    if (typeof refined === "string" && refined.trim()) return refined;
    return typeof metadata?.note_markdown === "string" ? metadata.note_markdown : "";
  }, [metadata]);
  const rawTranscript = useMemo(() => (typeof metadata?.raw_transcript_markdown === "string" ? metadata.raw_transcript_markdown : ""), [metadata]);
  const transcriptSegments = useMemo(() => parseTranscriptSegments(metadata), [metadata]);
  const transcriptSourceLabel = useMemo(() => getTranscriptSourceLabel(metadata?.transcript_source), [metadata]);
  const noteQuality = useMemo(() => getNoteQuality(metadata), [metadata]);
  const qualityInfo = useMemo(() => getQualityInfo(contentQuery.data?.status, metadata), [contentQuery.data?.status, metadata]);
  const materialSeedPoints = useMemo(() => readStringList(metadata?.material_seed_points), [metadata]);
  const materialSeedQueries = useMemo(() => readStringList(metadata?.material_seed_queries), [metadata]);
  const materialSeedSummary = useMemo(() => (typeof metadata?.material_seed_summary === "string" ? metadata.material_seed_summary.trim() : ""), [metadata]);
  const sourceDescription = useMemo(() => (typeof metadata?.source_description === "string" ? metadata.source_description.trim() : ""), [metadata]);
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
      (targetChunk ? "chunks" : targetTranscriptIndex !== null ? "transcript" : null);
    if (!targetView) {
      return null;
    }

    if (targetView === "chunks") {
      if (!targetChunk) {
        return null;
      }
      return {
        key: `chunks:${targetChunk.id}`,
        view: "chunks" as const,
        anchorId: targetChunk.id,
        message: "已定位到问答引用命中的检索片段。",
      };
    }

    if (targetTranscriptIndex === null) {
      return null;
    }

    const linkedChunkId = chunkByIndex.get(targetTranscriptIndex)?.id ?? targetChunk?.id ?? null;
    return {
      key: `transcript:${linkedChunkId ?? targetTranscriptIndex}`,
      view: "transcript" as const,
      anchorId: buildTranscriptAnchorId(targetTranscriptIndex, linkedChunkId),
      message: "已定位到问答引用命中的证据片段。",
    };
  }, [chunkByIndex, requestedView, targetChunk, targetTranscriptIndex]);
  const noteLayerStatus = useMemo(() => {
    if (noteQuality?.llm_enhanced) {
      return {
        label: "模型精炼",
        description: "精炼层已经过模型重整，适合直接做总结、原因和决策类追问。",
      };
    }
    if (noteQuality?.refined_note_ready) {
      return {
        label: "基础整理",
        description: "已经形成可读笔记，但复杂理解更建议同时参考证据层。",
      };
    }
    return {
      label: "原始建档",
      description: "当前仍以基础建档为主，先补正文和要点，再做高确定性问答。",
    };
  }, [noteQuality?.llm_enhanced, noteQuality?.refined_note_ready]);
  const qaModeStatus = useMemo(() => {
    if (noteQuality?.agent_ready) {
      return {
        label: "理解问答",
        description: "优先按整条内容理解，再回到命中片段核对证据。",
      };
    }
    if (noteQuality?.retrieval_ready) {
      return {
        label: "证据检索",
        description: "更适合围绕片段核对，不建议把结论无限外推。",
      };
    }
    return {
      label: "待补强",
      description: "先做整理、补证或模型增强，再继续深问。",
    };
  }, [noteQuality?.agent_ready, noteQuality?.retrieval_ready]);
  const evidenceStatus = useMemo(() => {
    if (noteQuality?.time_jump_ready) {
      return {
        label: "可回看",
        description: timestampsEstimated ? "命中后可以回看原视频时间点，当前部分时间来自估算定位。" : "命中后可以直接跳回原视频时间点。",
      };
    }
    if (noteQuality?.raw_evidence_ready) {
      return {
        label: "可核对",
        description: "已有原始正文或片段，适合做证据核对。",
      };
    }
    return {
      label: "较弱",
      description: "原始证据层还不够稳，先谨慎参考。",
    };
  }, [noteQuality?.raw_evidence_ready, noteQuality?.time_jump_ready, timestampsEstimated]);
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
  const quickAskItems = useMemo(() => {
    const merged = [...materialSeedQueries, ...QUICK_QUESTIONS];
    const unique: string[] = [];
    for (const item of merged) {
      const cleaned = item.trim();
      if (!cleaned || unique.includes(cleaned)) continue;
      unique.push(cleaned);
      if (unique.length >= 4) break;
    }
    return unique;
  }, [materialSeedQueries]);

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
      }),
    onSuccess: async (result) => {
      await queryClient.invalidateQueries({ queryKey: ["content", contentId] });
      await queryClient.invalidateQueries({ queryKey: ["contents"] });
      setLocalMessage(result.message);
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

    const targetMap = focusRequest.view === "chunks" ? chunkCardRefs.current : transcriptCardRefs.current;
    const targetElement = targetMap.get(focusRequest.anchorId);
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

  const heroFacts = [
    { label: "质量", value: typeof noteQuality?.score === "number" ? `${noteQuality.score} 分` : qualityInfo.label, hint: noteQuality?.label || "当前建档状态" },
    { label: "双层笔记", value: noteQuality?.double_note_ready ? "已就绪" : "待补全", hint: noteQuality?.llm_enhanced ? "模型精炼层 + 原始证据层" : "精炼层 + 原始证据层" },
    { label: "时间定位", value: noteQuality?.time_jump_ready ? "可回看" : timestampsAvailable ? "部分可用" : "未提供", hint: timestampsEstimated ? "当前来自估算转写" : "命中后可回到原链接" },
    { label: "片段数", value: transcriptSegments.length ? `${transcriptSegments.length} 段` : String(contentQuery.data.chunks.length), hint: noteQuality?.question_answer_ready ? "可直接问答验证" : qaModeStatus.label },
  ];

  const activeViewMeta =
    activeView === "refined"
      ? { title: "精炼层", summary: "先看结论和要点，判断这条内容值不值得继续深挖。" }
      : activeView === "transcript"
      ? { title: "证据层", summary: "保留原始正文和时间片段，适合核对原意与回看。" }
      : { title: "检索层", summary: "这是问答系统优先命中的片段层，适合围绕局部继续提问。" };
  const heroGuides = [
    {
      title: "当前形态",
      text: `${noteLayerStatus.label} / ${evidenceStatus.label} · ${noteLayerStatus.description}`,
    },
    {
      title: "问答方式",
      text: `${qaModeStatus.label} · ${qaModeStatus.description}`,
    },
    {
      title: "推荐下一步",
      text:
        noteQuality?.recommended_action ||
        (metadata?.noisy_asr_detected === true
          ? "先围绕具体片段提问和核对，再决定是否接模型做语义重整。"
          : "先看精炼层，再围绕结论、原因或做法继续追问。"),
    },
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
              ) : (
                <p
                  className="detail-lead"
                  style={{ cursor: "text" }}
                  title="点击编辑摘要"
                  onClick={() => setIsEditingMeta(true)}
                >
                  {displayText(contentQuery.data.summary || "当前已完成基础建档。先看精炼层，再在需要时回到底层证据。")}
                </p>
              )}
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
            <span className="pill">{displayText(noteLayerStatus.label)}</span>
            <span className="pill">{displayText(qaModeStatus.label)}</span>
            <span className="pill">{displayText(transcriptSourceLabel)}</span>
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

          <div className="detail-fact-grid">
            {heroFacts.map((item) => (
              <article className="detail-fact-card" key={item.label}>
                <span>{displayText(item.label)}</span>
                <strong>{displayText(item.value)}</strong>
                <small>{displayText(item.hint)}</small>
              </article>
            ))}
          </div>

          <div className="detail-guide-grid">
            {heroGuides.map((item) => (
              <article className="detail-guide-card" key={item.title}>
                <span>{displayText(item.title)}</span>
                <strong>{displayText(item.text)}</strong>
              </article>
            ))}
          </div>

          <div className="header-actions">
            <Link className="primary-button button-link" to={buildScopedChatLink("请基于这条笔记，给我一版更适合复盘的结论整理", { contentId: contentQuery.data.id, title: contentQuery.data.title })}>
              {displayText("围绕这条内容提问")}
            </Link>
            {contentQuery.data.source_url && (
              <a className="secondary-button button-link" href={contentQuery.data.source_url} target="_blank" rel="noreferrer">
                {displayText("打开原链接")}
              </a>
            )}
            <button className="secondary-button" type="button" onClick={() => reparseMutation.mutate()} disabled={reparseMutation.isPending}>
              {reparseMutation.isPending ? displayText("重解析中...") : displayText("重新解析")}
            </button>
            <button className="secondary-button" type="button" onClick={() => exportMutation.mutate(false)} disabled={exportMutation.isPending}>
              {exportMutation.isPending ? displayText("导出中...") : displayText("导出 Markdown")}
            </button>
            {Object.keys(annotations).length > 0 && (
              <button className="secondary-button" type="button" onClick={() => exportMutation.mutate(true)} disabled={exportMutation.isPending}>
                {displayText("导出含批注")}
              </button>
            )}
          </div>
        </div>
      </article>

      <article className="card detail-section-card glass-panel layer-switch-card">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">{displayText("当前视角")}</p>
            <h3>{displayText(activeViewMeta.title)}</h3>
            <p className="muted-text">{displayText(activeViewMeta.summary)}</p>
          </div>
        </div>
        <div className="segment-rail">
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
                  <div className="glass-callout">
                    <strong>{displayText("这是一张问答沉淀卡片")}</strong>
                    <p className="muted-text">{displayText("它不是纯笔记搬运，而是从一次问答里整理出来的结论，并额外保留了证据摘要和回看线索。")}</p>
                  </div>

                  {sourceQuestion && (
                    <article className="detail-material-item">
                      <span className="eyebrow">{displayText("原始问题")}</span>
                      <p>{displayText(sourceQuestion)}</p>
                    </article>
                  )}

                  {!!evidenceDigest.length && (
                    <div className="detail-material-list">
                      {evidenceDigest.slice(0, 3).map((item) => (
                        <article className="detail-material-item" key={`${item.title}-${item.anchor}-${item.line}`}>
                          <span className="eyebrow">{displayText(item.timeLabel || item.anchor || "证据片段")}</span>
                          <strong>{displayText(item.title)}</strong>
                          <p>{displayText(item.snippet || item.line)}</p>
                        </article>
                      ))}
                    </div>
                  )}

                  {evidenceSummary && (
                    <div className="glass-callout">
                      <strong>{displayText("回看建议")}</strong>
                      <p className="muted-text">{displayText(evidenceSummary)}</p>
                    </div>
                  )}

                  <div className="header-actions">
                    {sourceContentId && (
                      <Link className="secondary-button button-link" to={`/library/${sourceContentId}`}>
                        {displayText("打开来源内容")}
                      </Link>
                    )}
                    <Link
                      className="secondary-button button-link"
                      to={buildScopedChatLink("请基于这张问答卡片，把结论和证据整理成更适合复盘的版本", {
                        contentId: contentQuery.data.id,
                        title: contentQuery.data.title,
                      })}
                    >
                      {displayText("继续围绕这张卡片提问")}
                    </Link>
                  </div>
                </div>
              )}

              {!!contentQuery.data.key_points.length && (
                <div className="advice-grid compact-advice-grid">
                  {contentQuery.data.key_points.slice(0, 4).map((point) => (
                    <article className="advice-card" key={point}>
                      <p>{displayText(point)}</p>
                    </article>
                  ))}
                </div>
              )}
              <div style={{ marginBottom: 8, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                <span className="eyebrow" style={{ marginBottom: 0 }}>{displayText(isEditingNote ? "编辑笔记" : "精炼笔记")}</span>
                <div style={{ display: "flex", gap: 6 }}>
                  <button
                    className="btn btn-ghost btn-sm"
                    type="button"
                    onClick={() => setIsEditingNote((v) => !v)}
                  >
                    {isEditingNote ? displayText("完成编辑") : displayText("编辑笔记")}
                  </button>
                  <button className="btn btn-ghost btn-sm" type="button" onClick={() => void handleCopyText(richNoteContent || refinedNote || contentQuery.data.summary || "", "精炼笔记")}>
                    {displayText("复制")}
                  </button>
                  <button className="btn btn-ghost btn-sm" type="button" onClick={() => setActiveView("transcript")}>
                    {displayText("看证据层")}
                  </button>
                </div>
              </div>
              <RichNoteEditor
                content={richNoteContent || refinedNote || contentQuery.data.summary || ""}
                editable={isEditingNote}
                onChange={setRichNoteContent}
                onSave={(html) => {
                  updateContent(contentId, { summary: contentQuery.data?.summary ?? "" }).catch(() => {});
                  setLocalMessage("笔记已自动保存。");
                  setTimeout(() => setLocalMessage(""), 2000);
                  void html;
                }}
                placeholder="在这里写精炼笔记，支持标题、加粗、列表、高亮..."
              />
            </article>
          )}

          {activeView === "transcript" && (
            <article className="card detail-section-card glass-panel">
              <div className="glass-callout transcript-callout">
                <strong>{displayText(`正文来源：${transcriptSourceLabel}`)}</strong>
                <p className="muted-text">{displayText(qualityInfo.description)}</p>
                {typeof metadata?.asr_model_used === "string" && metadata.asr_model_used.trim() && (
                  <p className="muted-text">{displayText(`本次转写模型：${metadata.asr_model_used}`)}</p>
                )}
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
              ) : (
                <pre className="content-pre glass-pre source-pre">{displayText(rawTranscript || contentQuery.data.content_text || "当前没有可展示的原始转写。")}</pre>
              )}
            </article>
          )}

          {activeView === "chunks" && (
            <article className="card detail-section-card glass-panel">
              {!contentQuery.data.chunks.length && <p className="muted-text">{displayText("这条内容还没有整理出可用片段。")}</p>}
              <div className="citation-list">
                {contentQuery.data.chunks.map((chunk) => {
                  const chunkMeta = chunk.metadata ?? {};
                  const startMs = readNumber(chunkMeta.start_ms);
                  const endMs = readNumber(chunkMeta.end_ms);
                  const label = formatTimeRange(startMs, endMs, typeof chunkMeta.timestamp_label === "string" ? chunkMeta.timestamp_label : chunk.heading);
                  const jumpUrl = resolveSeekUrl(typeof chunkMeta.seek_url === "string" ? chunkMeta.seek_url : null, contentQuery.data.source_url, startMs);
                  const chunkLabel = chunk.heading?.trim() ? `片段 ${chunk.chunk_index + 1} · ${chunk.heading.trim()}` : `片段 ${chunk.chunk_index + 1}`;
                  const chunkCardClassName =
                    focusedAnchorId === chunk.id
                      ? "card detail-section-card glass-panel chunk-glass-card detail-section-card-focused"
                      : "card detail-section-card glass-panel chunk-glass-card";
                  return (
                    <article
                      className={chunkCardClassName}
                      key={chunk.id}
                      ref={(element) => {
                        if (element) {
                          chunkCardRefs.current.set(chunk.id, element);
                        } else {
                          chunkCardRefs.current.delete(chunk.id);
                        }
                      }}
                      tabIndex={-1}
                    >
                      <div className="panel-heading">
                        <div>
                          <p className="eyebrow">{displayText(chunkLabel)}</p>
                          <h4>{displayText(chunk.summary || "这个片段还没有独立摘要。")}</h4>
                        </div>
                        {label && <span className="pill">{displayText(label)}</span>}
                      </div>
                      <pre className="content-pre glass-pre compact-pre">{displayText(chunk.chunk_text)}</pre>
                      <div className="header-actions">
                        <button className="secondary-button" type="button" onClick={() => void handleCopyText(chunk.chunk_text, chunkLabel)}>
                          {displayText("复制片段")}
                        </button>
                        <Link className="secondary-button button-link" to={buildScopedChatLink("请只基于这个检索片段回答，并提炼最值得记住的观点", { contentId: contentQuery.data.id, chunkId: chunk.id, title: contentQuery.data.title, chunkLabel })}>
                          {displayText("围绕它追问")}
                        </Link>
                        {jumpUrl && <a className="primary-button button-link" href={jumpUrl} target="_blank" rel="noreferrer" title={displayText("将在浏览器中打开原视频对应时间点")}>{displayText("根据时间戳回看")}</a>}
                      </div>
                    </article>
                  );
                })}
              </div>
            </article>
          )}
        </div>

        <div className="note-side-column">
          <article className="card detail-section-card glass-panel note-side-actions">
            {localMessage && <p className="success-text">{displayText(localMessage)}</p>}
            {exportMutation.isSuccess && <p className="success-text">{displayText(`导出成功：${exportMutation.data.path}`)}</p>}
            {reparseMutation.isError && <p className="error-text">{displayText("重新解析失败，请确认原始链接或文件仍可访问。")}</p>}
            {exportMutation.isError && <p className="error-text">{displayText("导出失败，请稍后再试。")}</p>}

            <div className="glass-callout">
              <strong>{displayText(activeViewMeta.title)}</strong>
              <p className="muted-text">{displayText(activeViewMeta.summary)}</p>
            </div>

            <article className="result-callout detail-material-callout">
              <div className="pill-row" style={{ alignItems: "center" }}>
                <span className="pill">{displayText(materialReadiness.statusLabel)}</span>
                {materialReadiness.weakCapture && <span className="pill">{displayText("先用种子材料")}</span>}
              </div>
              <strong>{displayText(materialReadiness.title)}</strong>
              <p>{displayText(materialSeedSummary || materialReadiness.description)}</p>
            </article>

            <div className="smart-diagnostic-strip">
              {materialReadiness.cards.map((item) => (
                <article
                  className={`smart-diagnostic-card smart-diagnostic-card-${item.tone}`}
                  key={item.label}
                >
                  <span>{displayText(item.label)}</span>
                  <strong>{displayText(item.value)}</strong>
                </article>
              ))}
            </div>

            {(materialSeedPoints.length > 0 || sourceDescription) && (
              <article className="card detail-section-card glass-panel detail-material-panel">
                <div className="panel-heading">
                  <div>
                    <p className="eyebrow">{displayText("材料状态")}</p>
                    <h3>{displayText("当前拿到的线索")}</h3>
                  </div>
                </div>
                {materialSeedPoints.length > 0 && (
                  <div className="detail-material-list">
                    {materialSeedPoints.map((item) => (
                      <article className="detail-material-item" key={item}>
                        <p>{displayText(item)}</p>
                      </article>
                    ))}
                  </div>
                )}
                {!materialSeedPoints.length && sourceDescription && (
                  <div className="glass-callout">
                    <strong>{displayText("已保留来源简介")}</strong>
                    <p className="muted-text">{displayText(sourceDescription)}</p>
                  </div>
                )}
                {(qualityInfo.actionLabel || materialReadiness.weakCapture) && (
                  <div className="header-actions">
                    {qualityInfo.actionLabel && (
                      <Link className="secondary-button button-link" to="/settings">
                        {displayText(qualityInfo.actionLabel)}
                      </Link>
                    )}
                    <button className="secondary-button" type="button" onClick={() => reparseMutation.mutate()} disabled={reparseMutation.isPending}>
                      {reparseMutation.isPending ? displayText("重解析中...") : displayText("重新整理材料")}
                    </button>
                  </div>
                )}
              </article>
            )}

            <div className="chip-grid detail-quick-ask-grid">
              {quickAskItems.map((item) => (
                <Link key={item} className="secondary-button button-link suggestion-chip detail-quick-ask-chip" to={buildScopedChatLink(item, { contentId: contentQuery.data.id, title: contentQuery.data.title })}>
                  {displayText(item)}
                </Link>
              ))}
            </div>

            <div className="info-list compact-info-list">
              <div><dt>{displayText("作者")}</dt><dd>{displayText(contentQuery.data.author || "-")}</dd></div>
              <div><dt>{displayText("分类")}</dt><dd>{displayText(contentQuery.data.category || "未分类")}</dd></div>
              {savedFrom === "chat" && sourceQuestion && <div><dt>{displayText("来源问题")}</dt><dd>{displayText(sourceQuestion)}</dd></div>}
              <div><dt>{displayText("笔记层")}</dt><dd>{displayText(noteLayerStatus.label)}</dd></div>
              <div><dt>{displayText("问答方式")}</dt><dd>{displayText(qaModeStatus.label)}</dd></div>
              <div><dt>{displayText("证据层")}</dt><dd>{displayText(evidenceStatus.label)}</dd></div>
              <div><dt>{displayText("正文来源")}</dt><dd>{displayText(transcriptSourceLabel)}</dd></div>
              <div><dt>{displayText("创建时间")}</dt><dd>{formatDateTime(contentQuery.data.created_at)}</dd></div>
              <div><dt>{displayText("更新时间")}</dt><dd>{formatDateTime(contentQuery.data.updated_at)}</dd></div>
            </div>

            <div className="tag-row-soft">
              {contentQuery.data.tags.length ? contentQuery.data.tags.map((tag) => <span className="pill" key={tag}>{displayText(tag)}</span>) : <span className="pill">{displayText("暂无标签")}</span>}
            </div>
          </article>

          {/* 派生面板：思维导图 + 测验 */}
          <article className="card detail-section-card glass-panel">
            <div className="derive-panel-head">
              <p className="eyebrow">{displayText("AI 派生")}</p>
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
          </article>

          <article className="card detail-section-card glass-panel">
            <details className="metadata-details advanced-details">
              <summary>{displayText("编辑与维护")}</summary>
              <div className="form-grid detail-form-grid">
                <label className="form-block form-block-full">
                  <span className="field-label">{displayText("标题")}</span>
                  <input className="search-input" value={title} onChange={(event) => setTitle(event.target.value)} />
                </label>
                <label className="form-block">
                  <span className="field-label">{displayText("分类")}</span>
                  <input className="search-input" value={category} onChange={(event) => setCategory(event.target.value)} />
                </label>
                <label className="form-block form-block-full">
                  <span className="field-label">{displayText("一句话摘要")}</span>
                  <textarea className="text-area" value={summary} onChange={(event) => setSummary(event.target.value)} rows={5} />
                </label>
                <label className="form-block form-block-full">
                  <span className="field-label">{displayText("标签（逗号分隔）")}</span>
                  <input className="search-input" value={tags} onChange={(event) => setTags(event.target.value)} />
                </label>
              </div>
              <div className="header-actions">
                <button className="primary-button" type="button" onClick={() => updateMutation.mutate()} disabled={updateMutation.isPending}>
                  {updateMutation.isPending ? displayText("保存中...") : displayText("保存修改")}
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
            </details>
          </article>
        </div>
      </div>
    </section>
  );
}
