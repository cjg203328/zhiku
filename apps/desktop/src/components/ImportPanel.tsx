import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import ImportCapabilityCard from "./import/ImportCapabilityCard";
import FailureGuideCard from "./import/FailureGuideCard";
import ImportInputSection from "./import/ImportInputSection";
import ImportProbeResultCard from "./import/ImportProbeResultCard";
import ImportProgressCard from "./import/ImportProgressCard";
import ImportResultCard from "./import/ImportResultCard";
import {
  getSettings,
  getSystemStatus,
  type AppSettings,
  createFileImport,
  getImportJob,
  createUrlImport,
  probeBilibiliUrl,
  reparseContent,
  type BilibiliProbeResponse,
  type ContentDetail,
  type ImportJob,
  type ImportResponse,
  type NoteQuality,
  type ReparseContentResponse,
  type SystemStatus,
  retryImportJob,
  uploadFileImport,
} from "../lib/api";
import {
  getImportJobStepMeta,
  getImportStageItems,
  isImportJobTerminal,
  resolveImportStageIndex,
} from "../lib/importProgress";
import { useLanguage } from "../lib/language";
import { isTauriRuntime } from "../lib/runtime";

type ProbeResult = BilibiliProbeResponse["probe"];
type DiagnosticItem = {
  label: string;
  value: string;
  tone: "success" | "info" | "warning";
};
type CapabilityItem = {
  label: string;
  value: string;
  detail: string;
  tone: "success" | "info" | "warning";
  focus: "model" | "asr" | "bilibili";
};
type RecoveryHint = {
  label: string;
  value: string;
  detail: string;
  tone: "success" | "info" | "warning";
  focus?: "model" | "asr" | "bilibili";
};
type ImportCompletePayload = {
  contentId: string;
  title: string;
  status: string;
  suggestedQuestions: string[];
};

type ImportPanelProps = {
  onImportCompleted?: (payload: ImportCompletePayload) => void;
};

function isBilibiliLink(value: string) {
  return /bilibili\.com|b23\.tv|BV[0-9A-Za-z]+/i.test(value.trim());
}

function getNoteStyleLabel(value: string) {
  if (value === "bilinote") return "阅读版";
  if (value === "qa") return "问答版";
  if (value === "brief") return "速览版";
  return "结构版";
}

function getMetadata(result: ImportResponse | null) {
  const metadata = result?.job.preview.metadata;
  return metadata && typeof metadata === "object" ? (metadata as Record<string, unknown>) : {};
}

function getNoteQuality(metadata: Record<string, unknown>): NoteQuality | null {
  const raw = metadata.note_quality;
  if (raw && typeof raw === "object") {
    return raw as NoteQuality;
  }
  return null;
}

function getStatusTone(status: string) {
  if (status === "ready") return { label: "结果完整", tone: "success", hint: "已经形成可读笔记和可追问证据。" };
  if (status === "ready_estimated") return { label: "正文已恢复", tone: "info", hint: "当前正文来自转写，可结合证据层核对。" };
  if (status === "needs_cookie") return { label: "待补 Cookie", tone: "warning", hint: "当前只有基础档案，字幕层还不完整。" };
  if (status === "needs_asr") return { label: "待补转写", tone: "warning", hint: "当前没有正文，补转写后成功率会更高。" };
  if (status === "asr_failed") return { label: "转写异常", tone: "warning", hint: "需检查转写服务后重新导入。" };
  return { label: "基础建档", tone: "warning", hint: "当前结果以基础材料为主。" };
}

function getProbeTone(status: string) {
  if (status === "ready") return { label: "可直接导入", tone: "success", hint: "这条视频适合直接验证完整链路。" };
  if (status === "ready_estimated") return { label: "可走转写回退", tone: "info", hint: "没有字幕也能继续尝试恢复正文。" };
  if (status === "needs_cookie") return { label: "需补 Cookie", tone: "warning", hint: "不补登录态，大概率只能拿到基础档案。" };
  if (status === "needs_asr") return { label: "需补转写", tone: "warning", hint: "当前音频可用，但还没有可直接使用的正文。" };
  return { label: "仅基础预检", tone: "warning", hint: "当前仅确认元数据与基础链路。" };
}

function preflightNeedsConfirmation(status: string) {
  return status !== "ready" && status !== "ready_estimated";
}

function resolveImportPollTimeoutMs(job: ImportJob | null) {
  if (!job) {
    return 3 * 60 * 1000;
  }

  const previewPlatform = job.preview?.platform?.trim().toLowerCase() || "";
  if (previewPlatform === "bilibili") {
    return 15 * 60 * 1000;
  }

  if (job.source_kind === "file" || job.source_kind === "file_upload") {
    return 6 * 60 * 1000;
  }

  return 4 * 60 * 1000;
}

function buildImportTimeoutMessage(job: ImportJob | null) {
  const previewPlatform = job?.preview?.platform?.trim().toLowerCase() || "";
  if (previewPlatform === "bilibili") {
    return "导入超时（超过 15 分钟）。这类 B 站视频可能正在走本地转写，请检查小助手、Cookie 或转写运行时后重试。";
  }
  if (job?.source_kind === "file" || job?.source_kind === "file_upload") {
    return "导入超时（超过 6 分钟），请检查文件内容和服务状态后重试。";
  }
  return "导入超时（超过 4 分钟），请检查服务状态后重试。";
}

function buildSettingsLink(focus?: "model" | "asr" | "bilibili") {
  if (!focus) return "/settings";
  return `/settings?focus=${focus}`;
}

function getStringList(value: unknown) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item) => String(item ?? "").trim())
    .filter(Boolean);
}

function getMetadataText(metadata: Record<string, unknown>, key: string) {
  const value = metadata[key];
  return typeof value === "string" ? value.trim() : "";
}

function getTranscriptSourceLabel(value: string) {
  if (value === "subtitle") return "字幕正文";
  if (value === "asr") return "音频转写";
  if (value === "description") return "简介补全";
  return "仅基础档案";
}

function getCaptureStrategyLabel(value: unknown) {
  if (value === "yt_dlp") return "yt-dlp 兜底";
  if (value === "native_api") return "原生接口";
  return "未确定";
}

function buildCaptureRouteSummary(options: {
  subtitleStrategy: unknown;
  audioStrategy: unknown;
  subtitleAvailable: boolean;
  audioAvailable: boolean;
}) {
  const subtitleStrategy = getCaptureStrategyLabel(options.subtitleStrategy);
  const audioStrategy = getCaptureStrategyLabel(options.audioStrategy);

  if (!options.subtitleAvailable && !options.audioAvailable) {
    return "仅元数据预检";
  }
  if (options.subtitleAvailable && options.audioAvailable) {
    return `字幕 ${subtitleStrategy} / 音频 ${audioStrategy}`;
  }
  if (options.subtitleAvailable) {
    return `字幕 ${subtitleStrategy}`;
  }
  return `音频 ${audioStrategy}`;
}

function buildProbeDiagnostics(probe: ProbeResult): DiagnosticItem[] {
  const cookieStored = Boolean(probe.cookie_stored ?? probe.cookie_configured);
  const cookieEnabled = Boolean(probe.cookie_enabled);
  const cookieActive = Boolean(probe.cookie_active);
  const subtitleValue = probe.subtitle_available
    ? `${probe.subtitle_count} 条可抓取`
    : probe.subtitle_login_required
      ? "需登录"
      : "暂无字幕";
  const cookieValue = cookieActive
    ? "已启用"
    : cookieEnabled
      ? "已打开待填入"
      : cookieStored
        ? "已保存未启用"
        : probe.subtitle_login_required
          ? "未启用"
          : "非必需";
  const cookieTone = cookieActive
    ? "success"
    : cookieEnabled
      ? "warning"
      : cookieStored
        ? "info"
        : probe.subtitle_login_required
          ? "warning"
          : "info";
  const captureRouteValue = buildCaptureRouteSummary({
    subtitleStrategy: probe.subtitle_fetch_strategy,
    audioStrategy: probe.audio_fetch_strategy,
    subtitleAvailable: probe.subtitle_available,
    audioAvailable: probe.audio_available,
  });
  const captureRouteTone: DiagnosticItem["tone"] =
    probe.subtitle_ytdlp_fallback_used || probe.audio_ytdlp_fallback_used
      ? "info"
      : probe.subtitle_available || probe.audio_available
        ? "success"
        : "warning";

  return [
    {
      label: "字幕",
      value: subtitleValue,
      tone: probe.subtitle_available ? "success" : probe.subtitle_login_required ? "warning" : "info",
    },
    {
      label: "音频",
      value: probe.audio_available ? "可回退转写" : "不可用",
      tone: probe.audio_available ? "success" : "warning",
    },
    {
      label: "转写",
      value: probe.asr_configured ? "已就绪" : "未配置",
      tone: probe.asr_configured ? "success" : "warning",
    },
    {
      label: "登录态",
      value: cookieValue,
      tone: cookieTone,
    },
    {
      label: "抓取链路",
      value: captureRouteValue,
      tone: captureRouteTone,
    },
  ];
}

function buildImportDiagnostics(options: {
  noteQuality: NoteQuality | null;
  metadata: Record<string, unknown>;
  transcriptSegmentCount: number;
}) {
  const { noteQuality, metadata, transcriptSegmentCount } = options;
  const transcriptSource = getTranscriptSourceLabel(getMetadataText(metadata, "transcript_source"));
  const noisyAsrDetected = metadata.noisy_asr_detected === true;
  const qaStatus = noisyAsrDetected
    ? "证据可用，理解待重整"
    : noteQuality?.question_answer_ready
      ? "可直接追问"
      : noteQuality?.retrieval_ready
        ? "可检索"
        : "待补强";
  const evidenceValue = transcriptSegmentCount > 0 ? `${transcriptSegmentCount} 段` : "较弱";
  const seekReadyCount = typeof noteQuality?.seek_ready_segments === "number" ? noteQuality.seek_ready_segments : 0;
  const timelineValue = noteQuality?.time_jump_ready
    ? seekReadyCount > 0
      ? `${seekReadyCount} 段可跳转`
      : "可回看"
    : metadata.timestamps_available
      ? "已定位待补全"
      : "待补全";
  const captureRouteValue = buildCaptureRouteSummary({
    subtitleStrategy: metadata.subtitle_fetch_strategy,
    audioStrategy: metadata.audio_fetch_strategy,
    subtitleAvailable: metadata.transcript_source === "subtitle" || metadata.subtitle_ytdlp_fallback_used === true,
    audioAvailable: metadata.audio_available === true || metadata.audio_ytdlp_fallback_used === true || metadata.transcript_source === "asr",
  });
  const captureRouteTone: DiagnosticItem["tone"] =
    metadata.subtitle_ytdlp_fallback_used === true || metadata.audio_ytdlp_fallback_used === true
      ? "info"
      : metadata.transcript_source === "subtitle" || metadata.transcript_source === "asr"
        ? "success"
        : "warning";

  return [
    { label: "正文来源", value: transcriptSource, tone: transcriptSource === "仅基础档案" ? "warning" : "success" },
    {
      label: "问答状态",
      value: qaStatus,
      tone: noisyAsrDetected ? "warning" : noteQuality?.question_answer_ready ? "success" : noteQuality?.retrieval_ready ? "info" : "warning",
    },
    { label: "证据层", value: evidenceValue, tone: transcriptSegmentCount > 0 ? "success" : "warning" },
    { label: "时间回看", value: timelineValue, tone: noteQuality?.time_jump_ready ? "success" : metadata.timestamps_available ? "info" : "warning" },
    { label: "抓取链路", value: captureRouteValue, tone: captureRouteTone },
  ] satisfies DiagnosticItem[];
}

function buildCapabilityReadiness(options: {
  systemStatus?: SystemStatus;
  settings?: AppSettings;
}) {
  const { systemStatus, settings } = options;
  const cookieStored = Boolean(settings?.bilibili?.cookie_stored || settings?.bilibili?.cookie_configured);
  const cookieActive = Boolean(settings?.bilibili?.cookie_active);
  const asrConfigured = Boolean(systemStatus?.asr?.configured || settings?.asr?.configured);
  const asrLocalReady = Boolean(systemStatus?.asr?.local_runtime_ready || settings?.asr?.local_runtime_ready);
  const ffmpegReady = Boolean(systemStatus?.asr?.ffmpeg_available || settings?.asr?.ffmpeg_available);
  const modelReady = Boolean(systemStatus?.models?.chat_model_ready);
  const providerReady = Boolean(systemStatus?.models?.provider_ready);

  const items: CapabilityItem[] = [
    {
      label: "B站登录态",
      value: cookieActive ? "已启用" : cookieStored ? "已保存待启用" : "未配置",
      detail: cookieActive
        ? "会员或登录态字幕更容易直接拿到，导入成功率会更稳。"
        : cookieStored
          ? "Cookie 已经有了，但还没启用；很多需要登录态的字幕仍然拿不到。"
          : "没有登录态时，部分视频只能退回到简介或音频转写。",
      tone: cookieActive ? "success" : cookieStored ? "info" : "warning",
      focus: "bilibili",
    },
    {
      label: "音频转写",
      value: asrConfigured ? "已就绪" : "未配置",
      detail: asrConfigured
        ? "无字幕视频可以继续走转写补正文。"
        : "长视频和无字幕视频会明显更容易落到弱材料。",
      tone: asrConfigured ? "success" : "warning",
      focus: "asr",
    },
    {
      label: "ffmpeg",
      value: ffmpegReady ? "可用" : asrLocalReady ? "待补齐" : "非关键",
      detail: ffmpegReady
        ? "音频切片和本地转写链路更稳定。"
        : asrLocalReady
          ? "本地 ASR 已可用，但缺 ffmpeg 时音频链路容易卡在预处理。"
          : "如果主要走远端 ASR，这一项暂时不是首要瓶颈。",
      tone: ffmpegReady ? "success" : asrLocalReady ? "warning" : "info",
      focus: "asr",
    },
    {
      label: "理解模型",
      value: modelReady ? "可提炼" : providerReady ? "已连通待校验" : "未连接",
      detail: modelReady
        ? "问答和笔记整理会更自然，也更适合后续追问。"
        : providerReady
          ? "模型配置基本可用，但还需要实际验证回答质量。"
          : "没有主模型时，系统会偏保守，能检索但不一定讲得够清楚。",
      tone: modelReady ? "success" : providerReady ? "info" : "warning",
      focus: "model",
    },
  ];

  const warningCount = items.filter((item) => item.tone === "warning").length;
  const summary =
    warningCount === 0
      ? "当前这台机器已经具备比较完整的导入和问答能力。"
      : warningCount === 1
        ? "主链路基本可用，还有 1 个能力会影响内容完整度。"
        : `当前有 ${warningCount} 个能力会影响导入完整度。`;

  return { summary, items };
}

function buildRecoveryHints(options: {
  preview: ImportResponse["job"]["preview"] | null;
  metadata: Record<string, unknown>;
  noteQuality: NoteQuality | null;
  transcriptSegmentCount: number;
  systemStatus?: SystemStatus;
  settings?: AppSettings;
}) {
  const { preview, metadata, noteQuality, transcriptSegmentCount, systemStatus, settings } = options;
  if (!preview) return [];

  const hints: RecoveryHint[] = [];
  const status = preview.status;
  const cookieActive = Boolean(settings?.bilibili?.cookie_active);
  const cookieStored = Boolean(settings?.bilibili?.cookie_stored || settings?.bilibili?.cookie_configured);
  const asrConfigured = Boolean(systemStatus?.asr?.configured || settings?.asr?.configured);
  const chatModelReady = Boolean(systemStatus?.models?.chat_model_ready);

  if (status === "needs_cookie") {
    hints.push({
      label: "B站登录态",
      value: cookieActive ? "已启用，可重试" : cookieStored ? "已保存待启用" : "未启用",
      detail: cookieActive
        ? "当前可重新整理这条内容，让系统再次尝试字幕层。"
        : "这条视频的字幕需要登录态，不补这一步通常只能停留在基础建档。",
      tone: cookieActive ? "info" : "warning",
      focus: "bilibili",
    });
  }

  if (status === "needs_asr" || status === "asr_failed" || transcriptSegmentCount === 0) {
    hints.push({
      label: "音频转写",
      value: asrConfigured ? "已配置，可重试" : "未配置",
      detail: asrConfigured
        ? "系统已经有转写能力，但这条内容还需要重新整理一遍才能补正文。"
        : "当前还没有稳定的转写能力，长视频和无字幕视频会明显受影响。",
      tone: asrConfigured ? "info" : "warning",
      focus: "asr",
    });
  }

  if (!noteQuality?.question_answer_ready || !noteQuality?.llm_enhanced) {
    hints.push({
      label: "理解模型",
      value: chatModelReady ? "已可用" : "未连接",
      detail: chatModelReady
        ? "接下来更适合做模型精炼和理解增强，笔记可读性会更好。"
        : "没有主模型时系统会更保守，能检索但不一定能整理出更聪明的结论。",
      tone: chatModelReady ? "info" : "warning",
      focus: "model",
    });
  }

  const captureAction = getMetadataText(metadata, "capture_recommended_action");
  if (captureAction && !hints.some((item) => item.detail === captureAction)) {
    hints.push({
      label: "采集状态",
      value: "查看说明",
      detail: captureAction,
      tone: "info",
      focus: status === "needs_cookie" ? "bilibili" : status === "needs_asr" || status === "asr_failed" ? "asr" : "model",
    });
  }

  const deduped: RecoveryHint[] = [];
  const signatures = new Set<string>();
  for (const item of hints) {
    const signature = `${item.label}:${item.value}:${item.detail}`;
    if (signatures.has(signature)) continue;
    signatures.add(signature);
    deduped.push(item);
    if (deduped.length >= 4) break;
  }
  return deduped;
}

function buildImportIssueList(
  metadata: Record<string, unknown>,
  noteQuality: NoteQuality | null,
  enabled: boolean,
) {
  if (!enabled) return [] as string[];

  return [
    metadata.noisy_asr_detected === true ? "检测到转写噪声，当前更适合围绕时间片段继续提问并核对原视频。" : "",
    getMetadataText(metadata, "asr_model_used") ? `本次转写模型：${getMetadataText(metadata, "asr_model_used")}` : "",
    metadata.asr_model_auto_upgraded === true && getMetadataText(metadata, "asr_model_used")
      ? `已自动抬升本地模型到 ${getMetadataText(metadata, "asr_model_used")} 尝试保底。`
      : "",
    getMetadataText(metadata, "capture_blocked_reason"),
    ...getStringList(metadata.metadata_fetch_errors),
    getMetadataText(metadata, "subtitle_error") ? `字幕获取：${getMetadataText(metadata, "subtitle_error")}` : "",
    getMetadataText(metadata, "asr_error") ? `转写过程：${getMetadataText(metadata, "asr_error")}` : "",
    !noteQuality?.time_jump_ready && getMetadataText(metadata, "capture_recommended_action"),
  ].filter((item): item is string => Boolean(item));
}

function plainText(value: string) {
  return value
    .replace(/\[(.*?)\]\((.*?)\)/g, "$1")
    .replace(/^[#>*-]\s*/gm, "")
    .replace(/`/g, "")
    .replace(/\n+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function snippet(primary: string, fallback: string, limit = 140) {
  const value = plainText(primary || fallback);
  if (!value) return "";
  return value.length <= limit ? value : `${value.slice(0, limit).trimEnd()}...`;
}

function chatLink(query: string, options?: { contentId?: string; title?: string }) {
  const search = new URLSearchParams();
  search.set("q", query);
  if (options?.contentId) search.set("contentId", options.contentId);
  if (options?.title) search.set("title", options.title);
  return `/chat?${search.toString()}`;
}

function buildImportResultFromContent(content: ContentDetail): ImportResponse {
  return {
    job: {
      id: `reparse-${content.id}`,
      status: "completed",
      progress: 100,
      step: "done",
      preview: {
        source_type: content.source_type ?? "",
        platform: content.platform ?? "",
        source_url: content.source_url ?? undefined,
        source_file: content.source_file ?? undefined,
        title: content.title,
        content_text: content.content_text,
        summary: content.summary,
        key_points: content.key_points,
        tags: content.tags,
        metadata: content.metadata,
        content_id: content.id,
        status: content.status,
      },
    },
    content: {
      id: content.id,
      title: content.title,
      summary: content.summary,
      tags: content.tags,
      status: content.status,
    },
  };
}

function buildImportResultFromReparseResponse(result: ReparseContentResponse): ImportResponse | null {
  if (result.job) {
    return {
      job: result.job,
      content: result.content
        ? {
            id: result.content.id,
            title: result.content.title,
            summary: result.content.summary,
            tags: result.content.tags,
            status: result.content.status,
          }
        : null,
    };
  }

  if (result.content) {
    return buildImportResultFromContent(result.content);
  }

  return null;
}

function buildImportFirstQuestions(options: {
  preview: ImportResponse["job"]["preview"];
  metadata: Record<string, unknown>;
  noteQuality: NoteQuality | null;
}) {
  const { preview, metadata, noteQuality } = options;
  const seedQueries = getStringList(metadata.material_seed_queries);
  const title = preview.title.trim();
  const suggestions = [...seedQueries];

  if (title) {
    if (noteQuality?.question_answer_ready) {
      suggestions.push(`请概括《${title}》最值得记住的三个结论`);
      suggestions.push(`《${title}》里有哪些做法可以直接拿来用？`);
    } else if (noteQuality?.retrieval_ready) {
      suggestions.push(`只基于当前证据，先讲清《${title}》最稳的线索是什么`);
      suggestions.push(`围绕《${title}》，我应该优先回看哪几个片段？`);
    } else {
      suggestions.push(`当前材料下，《${title}》最值得继续核对的问题是什么？`);
      suggestions.push(`请只基于现在拿到的内容，整理出《${title}》的主题线索`);
    }
  }

  const deduped: string[] = [];
  for (const item of suggestions) {
    const cleaned = item.trim();
    if (!cleaned || deduped.includes(cleaned)) continue;
    deduped.push(cleaned);
    if (deduped.length >= 4) break;
  }
  return deduped;
}

function buildImportResultFromJob(job: ImportJob): ImportResponse {
  return {
    job,
    content: job.preview.content_id
      ? {
          // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
          id: job.preview.content_id!,
          title: job.preview.title,
          summary: job.preview.summary,
          tags: job.preview.tags,
          status: job.preview.status,
        }
      : null,
  };
}

export default function ImportPanel({ onImportCompleted }: ImportPanelProps) {
  const { displayText } = useLanguage();
  const queryClient = useQueryClient();
  const desktopRuntime = isTauriRuntime();
  const [urlValue, setUrlValue] = useState("");
  const [filePathValue, setFilePathValue] = useState("");
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [noteStyle, setNoteStyle] = useState("structured");
  const [summaryFocus, setSummaryFocus] = useState("");
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [lastResult, setLastResult] = useState<ImportResponse | null>(null);
  const [lastProbeResult, setLastProbeResult] = useState<BilibiliProbeResponse | null>(null);
  const [lastProbedUrl, setLastProbedUrl] = useState("");
  const [awaitingImportConfirmation, setAwaitingImportConfirmation] = useState(false);
  const [activeImportJobId, setActiveImportJobId] = useState("");
  const [activeImportJob, setActiveImportJob] = useState<ImportJob | null>(null);
  const [reparseFeedbackMessage, setReparseFeedbackMessage] = useState("");
  const [retryingImportJobId, setRetryingImportJobId] = useState("");
  const systemStatusQuery = useQuery({
    queryKey: ["system-status"],
    queryFn: getSystemStatus,
    retry: 1,
    staleTime: 30000,
  });
  const settingsQuery = useQuery({
    queryKey: ["settings"],
    queryFn: getSettings,
    retry: 1,
    staleTime: 30000,
  });

  function reportImportCompleted(
    preview: ImportResponse["job"]["preview"] | null | undefined,
    metadataInput?: Record<string, unknown>,
    noteQualityInput?: NoteQuality | null,
  ) {
    const contentId = preview?.content_id?.trim();
    const title = preview?.title?.trim();
    const status = preview?.status?.trim();
    if (!contentId || !title || !status) {
      return;
    }
    const safePreview = preview;
    if (!safePreview) {
      return;
    }
    const metadata =
      metadataInput ??
      (safePreview.metadata && typeof safePreview.metadata === "object" ? (safePreview.metadata as Record<string, unknown>) : {});
    const noteQuality = noteQualityInput ?? getNoteQuality(metadata);
    onImportCompleted?.({
      contentId,
      title,
      status,
      suggestedQuestions: buildImportFirstQuestions({
        preview: safePreview,
        metadata,
        noteQuality,
      }),
    });
  }

  function acceptImportResponse(
    data: ImportResponse,
    options?: { clearUrl?: boolean; clearFilePath?: boolean; clearSelectedFile?: boolean; preserveReparseFeedback?: boolean },
  ) {
    if (options?.clearUrl) setUrlValue("");
    if (options?.clearFilePath) setFilePathValue("");
    if (options?.clearSelectedFile) setSelectedFile(null);
    if (!options?.preserveReparseFeedback) {
      setReparseFeedbackMessage("");
    }
    setLastProbeResult(null);
    setLastProbedUrl("");
    setAwaitingImportConfirmation(false);
    reparseMutation.reset();

    if (!isImportJobTerminal(data.job.status)) {
      setLastResult(null);
      setActiveImportJobId(data.job.id);
      setActiveImportJob(data.job);
      return;
    }

    setActiveImportJobId("");
    setActiveImportJob(null);
    setLastResult(data);
    const metadata =
      data.job.preview.metadata && typeof data.job.preview.metadata === "object"
        ? (data.job.preview.metadata as Record<string, unknown>)
        : {};
    reportImportCompleted(data.job.preview, metadata, getNoteQuality(metadata));
    queryClient.invalidateQueries({ queryKey: ["contents"] });
  }

  const probeMutation = useMutation({
    mutationFn: (url: string) => probeBilibiliUrl(url),
    onSuccess: (data, url) => {
      setLastProbeResult(data);
      setLastProbedUrl(url.trim());
      setAwaitingImportConfirmation(preflightNeedsConfirmation(data.probe.predicted_status));
    },
  });

  const urlMutation = useMutation({
    mutationFn: ({ url, noteStyle, summaryFocus }: { url: string; noteStyle: string; summaryFocus: string }) =>
      createUrlImport(url, { noteStyle, summaryFocus, asyncMode: true }),
    onSuccess: (data) => {
      acceptImportResponse(data, { clearUrl: true });
    },
  });

  const fileMutation = useMutation({
    mutationFn: (filePath: string) => createFileImport(filePath, { asyncMode: true }),
    onSuccess: (data) => {
      acceptImportResponse(data, { clearFilePath: true });
    },
  });

  const fileUploadMutation = useMutation({
    mutationFn: (file: File) => uploadFileImport(file, { asyncMode: true }),
    onSuccess: (data) => {
      acceptImportResponse(data, { clearSelectedFile: true });
    },
  });
  const reparseMutation = useMutation({
    mutationFn: ({ contentId, noteStyle, summaryFocus }: { contentId: string; noteStyle?: string; summaryFocus?: string }) =>
      reparseContent(contentId, {
        note_style: noteStyle,
        summary_focus: summaryFocus,
        async_mode: true,
      }),
    onMutate: () => {
      setReparseFeedbackMessage("");
    },
    onSuccess: async (result) => {
      const payload = buildImportResultFromReparseResponse(result);
      if (!payload) {
        return;
      }
      if (!result.job || isImportJobTerminal(result.job.status)) {
        setReparseFeedbackMessage(result.message || "系统已经按当前设置重新处理材料，下面的预览已更新。");
      }
      acceptImportResponse(payload);
      if (!result.job || isImportJobTerminal(result.job.status)) {
        await queryClient.invalidateQueries({ queryKey: ["contents"] });
      }
    },
  });

  useEffect(() => {
    if (!activeImportJobId) {
      return;
    }

    let cancelled = false;
    let timer: number | undefined;
    const pollTimeoutMs = resolveImportPollTimeoutMs(activeImportJob);
    const startedAt = Date.now();

    const poll = async () => {
      try {
        // 超时检测
        if (Date.now() - startedAt > pollTimeoutMs) {
          if (!cancelled) {
            setActiveImportJobId("");
            setActiveImportJob((current) =>
              current
                ? {
                    ...current,
                    status: "failed",
                    progress: 100,
                    step: "failed",
                    error_message: buildImportTimeoutMessage(current),
                  }
                : null,
            );
          }
          return;
        }

        const job = await getImportJob(activeImportJobId);
        if (cancelled) {
          return;
        }

        setActiveImportJob((current) => {
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
          setActiveImportJobId("");
          if (job.status === "completed") {
            const metadata =
              job.preview.metadata && typeof job.preview.metadata === "object"
                ? (job.preview.metadata as Record<string, unknown>)
                : {};
            const jobMessage = typeof metadata.job_message === "string" ? metadata.job_message.trim() : "";
            if (jobMessage) {
              setReparseFeedbackMessage(jobMessage);
            }
            acceptImportResponse(buildImportResultFromJob(job), { preserveReparseFeedback: Boolean(jobMessage) });
            setActiveImportJob(null);
          } else {
            setActiveImportJob(null);
          }
          return;
        }

        timer = window.setTimeout(() => {
          void poll();
        }, 1400);
      } catch (error) {
        if (cancelled) {
          return;
        }
        setActiveImportJobId("");
        setActiveImportJob((current) =>
          current
            ? {
                ...current,
                status: "failed",
                progress: 100,
                step: "failed",
                error_message: error instanceof Error ? error.message : "读取导入状态失败",
              }
            : null,
        );
      }
    };

    void poll();

    return () => {
      cancelled = true;
      if (timer) {
        window.clearTimeout(timer);
      }
    };
  }, [activeImportJobId, queryClient]);

  const preview = lastResult?.job.preview ?? null;
  const metadata = getMetadata(lastResult);
  const noteQuality = getNoteQuality(metadata);
  const probe = lastProbeResult?.probe ?? null;
  const runningImportJob = activeImportJob && !isImportJobTerminal(activeImportJob.status) ? activeImportJob : null;
  const isImporting =
    Boolean(runningImportJob) || urlMutation.isPending || fileMutation.isPending || fileUploadMutation.isPending;
  const activeError =
    (urlMutation.error as Error | null)?.message ||
    (fileMutation.error as Error | null)?.message ||
    (fileUploadMutation.error as Error | null)?.message ||
    (activeImportJob?.status === "failed" ? activeImportJob.error_message || "导入任务执行失败，请稍后再试。" : "") ||
    "";
  const importStageItems = useMemo(
    () => getImportStageItems(runningImportJob?.source_kind),
    [runningImportJob?.source_kind],
  );
  const importStepMeta = useMemo(
    () => getImportJobStepMeta(runningImportJob?.step),
    [runningImportJob?.step],
  );
  const importStageIndex = useMemo(
    () => resolveImportStageIndex(runningImportJob?.step, runningImportJob?.source_kind),
    [runningImportJob?.source_kind, runningImportJob?.step],
  );

  const evidenceSnippet = useMemo(() => {
    const raw = typeof metadata.raw_transcript_markdown === "string" ? metadata.raw_transcript_markdown : "";
    return snippet(raw, preview?.content_text || "");
  }, [metadata.raw_transcript_markdown, preview?.content_text]);
  const transcriptSegmentCount = useMemo(() => {
    if (typeof noteQuality?.transcript_segments === "number") {
      return noteQuality.transcript_segments;
    }
    return Array.isArray(metadata.transcript_segments) ? metadata.transcript_segments.length : 0;
  }, [metadata.transcript_segments, noteQuality?.transcript_segments]);
  const probeDiagnostics = useMemo(() => (probe ? buildProbeDiagnostics(probe) : []), [probe]);
  const importDiagnostics = useMemo(
    () =>
      preview
        ? buildImportDiagnostics({
            noteQuality,
            metadata,
            transcriptSegmentCount,
          })
        : [],
    [metadata, noteQuality, preview, transcriptSegmentCount],
  );
  const probeIssues = useMemo(() => {
    if (!probe) return [];
    return [
      ...getStringList(probe.metadata_fetch_errors),
      probe.subtitle_error ? `字幕获取：${probe.subtitle_error}` : "",
      probe.audio_error ? `音频探测：${probe.audio_error}` : "",
      !probe.asr_configured && probe.asr_runtime_summary ? `转写能力：${probe.asr_runtime_summary}` : "",
    ].filter((item): item is string => Boolean(item));
  }, [probe]);
  const importIssues = useMemo(() => buildImportIssueList(metadata, noteQuality, Boolean(preview)), [metadata, noteQuality, preview]);
  const probeNeedsSettings = Boolean(
    probe &&
      (probe.predicted_status === "needs_cookie" ||
        probe.predicted_status === "needs_asr" ||
        /Cookie|转写|ASR|设置/.test(probe.predicted_recommended_action)),
  );
  const importNeedsSettings = Boolean(
    preview &&
      (preview.status === "needs_cookie" ||
        preview.status === "needs_asr" ||
        preview.status === "asr_failed" ||
        /Cookie|转写|ASR|设置/.test(
          noteQuality?.recommended_action || getMetadataText(metadata, "capture_recommended_action"),
        )),
  );
  const firstQuestions = useMemo(
    () => (preview ? buildImportFirstQuestions({ preview, metadata, noteQuality }) : []),
    [metadata, noteQuality, preview],
  );
  const shouldOfferReparse = Boolean(
    preview?.content_id &&
      (preview.status === "needs_cookie" ||
        preview.status === "needs_asr" ||
        preview.status === "asr_failed" ||
        preview.status === "limited" ||
        !noteQuality?.question_answer_ready),
  );
  const recoveryHints = useMemo(
    () =>
      buildRecoveryHints({
        preview,
        metadata,
        noteQuality,
        transcriptSegmentCount,
        systemStatus: systemStatusQuery.data,
        settings: settingsQuery.data,
      }),
    [metadata, noteQuality, preview, settingsQuery.data, systemStatusQuery.data, transcriptSegmentCount],
  );
  const shouldShowRecoveryPanel = Boolean(recoveryHints.length && (importNeedsSettings || !noteQuality?.question_answer_ready));
  const probeRequiresConfirmation = Boolean(probe && preflightNeedsConfirmation(probe.predicted_status));
  const capabilityReadiness = useMemo(
    () =>
      buildCapabilityReadiness({
        systemStatus: systemStatusQuery.data,
        settings: settingsQuery.data,
      }),
    [settingsQuery.data, systemStatusQuery.data],
  );
  const failedPreview = useMemo(
    () => (!preview && activeImportJob?.status === "failed" ? activeImportJob.preview : null),
    [activeImportJob, preview],
  );
  const failedMetadata = useMemo(() => {
    const raw = failedPreview?.metadata;
    return raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  }, [failedPreview]);
  const failedNoteQuality = useMemo(() => getNoteQuality(failedMetadata), [failedMetadata]);
  const failedTranscriptSegmentCount = useMemo(() => {
    if (typeof failedNoteQuality?.transcript_segments === "number") {
      return failedNoteQuality.transcript_segments;
    }
    return Array.isArray(failedMetadata.transcript_segments) ? failedMetadata.transcript_segments.length : 0;
  }, [failedMetadata.transcript_segments, failedNoteQuality?.transcript_segments]);
  const failedImportIssues = useMemo(
    () => [
      activeImportJob?.error_code ? `错误代码：${activeImportJob.error_code}` : "",
      ...buildImportIssueList(failedMetadata, failedNoteQuality, Boolean(failedPreview)),
    ].filter((item): item is string => Boolean(item)),
    [activeImportJob?.error_code, failedMetadata, failedNoteQuality, failedPreview],
  );
  const failedRecoveryHints = useMemo(
    () =>
      buildRecoveryHints({
        preview: failedPreview,
        metadata: failedMetadata,
        noteQuality: failedNoteQuality,
        transcriptSegmentCount: failedTranscriptSegmentCount,
        systemStatus: systemStatusQuery.data,
        settings: settingsQuery.data,
      }),
    [failedMetadata, failedNoteQuality, failedPreview, failedTranscriptSegmentCount, settingsQuery.data, systemStatusQuery.data],
  );
  const probeFailureHints = useMemo(
    () =>
      capabilityReadiness.items
        .filter((item) => item.tone !== "success")
        .slice(0, 3)
        .map((item) => ({
          label: item.label,
          value: item.value,
          detail: item.detail,
          tone: item.tone,
          focus: item.focus,
        })),
    [capabilityReadiness.items],
  );

  async function handleUrlImportStart() {
    const trimmedUrl = urlValue.trim();
    if (!trimmedUrl || isImporting) {
      return;
    }

    const bilibili = isBilibiliLink(trimmedUrl);
    const hasCurrentProbe = bilibili && lastProbedUrl === trimmedUrl && probe;

    if (bilibili && !hasCurrentProbe) {
      try {
        const probeResult = await probeMutation.mutateAsync(trimmedUrl);
        if (preflightNeedsConfirmation(probeResult.probe.predicted_status)) {
          return;
        }
      } catch {
        return;
      }
    }

    if (bilibili && hasCurrentProbe && probeRequiresConfirmation && awaitingImportConfirmation) {
      setAwaitingImportConfirmation(false);
      return;
    }

    urlMutation.mutate({ url: trimmedUrl, noteStyle, summaryFocus: summaryFocus.trim() });
  }

  function resetPanel() {
    setUrlValue("");
    setFilePathValue("");
    setSelectedFile(null);
    setSummaryFocus("");
    setReparseFeedbackMessage("");
    setLastResult(null);
    setLastProbeResult(null);
    setLastProbedUrl("");
    setAwaitingImportConfirmation(false);
    setActiveImportJobId("");
    setActiveImportJob(null);
    reparseMutation.reset();
    probeMutation.reset();
    urlMutation.reset();
    fileMutation.reset();
    fileUploadMutation.reset();
  }

  return (
    <section className="card import-panel product-import-panel smart-import-panel">
      <div className="panel-heading import-panel-header smart-import-header">
        <div>
          <p className="eyebrow">{displayText("智能导入")}</p>
          <h3>{displayText("导入内容")}</h3>
        </div>
      </div>

      <ImportCapabilityCard readiness={capabilityReadiness} />

      <ImportInputSection
        urlValue={urlValue}
        setUrlValue={setUrlValue}
        onUrlChange={() => { setLastProbeResult(null); setLastProbedUrl(""); setAwaitingImportConfirmation(false); probeMutation.reset(); }}
        noteStyle={noteStyle}
        setNoteStyle={setNoteStyle}
        summaryFocus={summaryFocus}
        setSummaryFocus={setSummaryFocus}
        showAdvanced={showAdvanced}
        setShowAdvanced={setShowAdvanced}
        awaitingImportConfirmation={awaitingImportConfirmation}
        probeRequiresConfirmation={probeRequiresConfirmation}
        lastProbedUrl={lastProbedUrl}
        isImporting={isImporting}
        isProbePending={probeMutation.isPending}
        isUrlPending={urlMutation.isPending}
        desktopRuntime={desktopRuntime}
        filePathValue={filePathValue}
        setFilePathValue={setFilePathValue}
        selectedFile={selectedFile}
        setSelectedFile={setSelectedFile}
        onProbe={() => probeMutation.mutate(urlValue.trim())}
        onUrlImportStart={() => { void handleUrlImportStart(); }}
        onFileMutate={(path) => fileMutation.mutate(path)}
        onFileUploadMutate={(file) => fileUploadMutation.mutate(file)}
      />

      {probeMutation.error && (
        <FailureGuideCard
          eyebrow="预检失败"
          title="这次没能顺利拿到预检结果"
          description="补齐相关能力后再重新预检，结果会更稳定。"
          message={(probeMutation.error as Error).message}
          hints={probeFailureHints}
          issues={urlValue.trim() ? [`当前链接：${urlValue.trim()}`] : []}
          actions={(
            <>
              <button className="secondary-button" type="button" onClick={() => probeMutation.reset()}>
                {displayText("收起提示")}
              </button>
              <Link className="secondary-button button-link" to="/settings">
                {displayText("打开设置")}
              </Link>
            </>
          )}
        />
      )}

      {probe && (
        <ImportProbeResultCard
          probe={probe}
          probeDiagnostics={probeDiagnostics}
          probeIssues={probeIssues}
          probeNeedsSettings={probeNeedsSettings}
          urlValue={urlValue}
          isUrlPending={urlMutation.isPending}
          isProbePending={probeMutation.isPending}
          noteStyle={noteStyle}
          summaryFocus={summaryFocus}
          onDirectImport={() => { setAwaitingImportConfirmation(false); urlMutation.mutate({ url: urlValue.trim(), noteStyle, summaryFocus: summaryFocus.trim() }); }}
          onCollapse={() => { setLastProbeResult(null); setLastProbedUrl(""); setAwaitingImportConfirmation(false); }}
        />
      )}

      {isImporting && (
        <ImportProgressCard
          runningImportJob={runningImportJob}
          importStepMeta={importStepMeta}
          importStageItems={importStageItems}
          importStageIndex={importStageIndex}
        />
      )}

      {Boolean(activeError) && (
        <FailureGuideCard
          eyebrow="导入失败"
          title="这次没有顺利完成"
          description={urlValue.trim() ? "补齐相关能力后再重试，结果通常更稳定。" : "重新开始前可确认当前能力链路。"}
          message={activeError}
          hints={failedRecoveryHints}
          issues={failedImportIssues}
          actions={(
            <>
              <button className="secondary-button" type="button" onClick={resetPanel} disabled={retryingImportJobId === activeImportJob?.id}>
                {displayText("重新开始")}
              </button>
              {activeImportJob?.status === "failed" && activeImportJob.id && (
                <button
                  className="secondary-button"
                  type="button"
                  disabled={retryingImportJobId === activeImportJob.id}
                  onClick={async () => {
                    setRetryingImportJobId(activeImportJob.id);
                    try {
                      const result = await retryImportJob(activeImportJob.id);
                      setActiveImportJob(result.job);
                      setActiveImportJobId(result.job.id);
                    } catch {}
                    finally {
                      setRetryingImportJobId("");
                    }
                  }}
                >
                  {displayText(retryingImportJobId === activeImportJob.id ? "正在重试..." : "重试导入")}
                </button>
              )}
              <Link className="secondary-button button-link" to="/settings">
                {displayText("打开设置")}
              </Link>
            </>
          )}
        />
      )}

      {preview && (
        <ImportResultCard
          preview={preview}
          metadata={metadata}
          noteQuality={noteQuality}
          noteStyle={noteStyle}
          importDiagnostics={importDiagnostics}
          importIssues={importIssues}
          importNeedsSettings={importNeedsSettings}
          firstQuestions={firstQuestions}
          shouldOfferReparse={shouldOfferReparse}
          recoveryHints={recoveryHints}
          shouldShowRecoveryPanel={shouldShowRecoveryPanel}
          transcriptSegmentCount={transcriptSegmentCount}
          evidenceSnippet={evidenceSnippet}
          summaryFocus={summaryFocus}
          isReparsePending={reparseMutation.isPending || Boolean(runningImportJob)}
          isReparseSuccess={Boolean(reparseFeedbackMessage) && !Boolean(runningImportJob)}
          reparseMessage={reparseFeedbackMessage}
          isReparseError={reparseMutation.isError || activeImportJob?.status === "failed"}
          reparseErrorMessage={(reparseMutation.error as Error | null)?.message || activeImportJob?.error_message || undefined}
          onReparse={() => reparseMutation.mutate({ contentId: preview.content_id!, noteStyle, summaryFocus: summaryFocus.trim() })}
          onReset={resetPanel}
        />
      )}
    </section>
  );
}
