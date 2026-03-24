import type { ImportJob } from "./api";

export type ImportProgressMode = "import" | "reparse";

export type ImportStageItem = {
  key: string;
  label: string;
};

export type ImportStepMeta = {
  label: string;
  description: string;
};

type ImportTimeoutPolicy = {
  maxIdleMs: number;
  hardCapMs: number;
};

function readJobMetadata(job: ImportJob | null | undefined) {
  const metadata = job?.preview?.metadata;
  return metadata && typeof metadata === "object" ? (metadata as Record<string, unknown>) : {};
}

function readJobTextMetadata(job: ImportJob | null | undefined, key: string) {
  const value = readJobMetadata(job)[key];
  return typeof value === "string" ? value.trim() : "";
}

function parseTimestamp(value: string | null | undefined) {
  if (!value) {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function getTimeoutScopeLabel(mode: ImportProgressMode) {
  return mode === "reparse" ? "重新解析" : "导入";
}

function getTimeoutPolicy(job: ImportJob | null | undefined, mode: ImportProgressMode): ImportTimeoutPolicy {
  const previewPlatform = job?.preview?.platform?.trim().toLowerCase() || "";
  const isBilibili = previewPlatform === "bilibili";
  const isTranscribing = job?.step === "transcribing_audio";

  if (isTranscribing) {
    return {
      maxIdleMs: 3 * 60 * 1000,
      hardCapMs: 35 * 60 * 1000,
    };
  }

  if (isBilibili) {
    return {
      maxIdleMs: 90 * 1000,
      hardCapMs: mode === "reparse" ? 18 * 60 * 1000 : 20 * 60 * 1000,
    };
  }

  if (job?.source_kind === "file" || job?.source_kind === "file_upload") {
    return {
      maxIdleMs: 75 * 1000,
      hardCapMs: mode === "reparse" ? 10 * 60 * 1000 : 8 * 60 * 1000,
    };
  }

  return {
    maxIdleMs: 60 * 1000,
    hardCapMs: mode === "reparse" ? 10 * 60 * 1000 : 6 * 60 * 1000,
  };
}

function formatDurationLabel(milliseconds: number) {
  const totalMinutes = Math.max(1, Math.round(milliseconds / 60000));
  return `${totalMinutes} 分钟`;
}

export function getImportJobActivityTimestamp(job: ImportJob | null | undefined) {
  return (
    parseTimestamp(readJobTextMetadata(job, "job_runtime_last_heartbeat_at")) ??
    parseTimestamp(job?.updated_at) ??
    parseTimestamp(job?.created_at) ??
    null
  );
}

export function buildImportTimeoutMessage(job: ImportJob | null | undefined, mode: ImportProgressMode = "import") {
  const scopeLabel = getTimeoutScopeLabel(mode);
  const policy = getTimeoutPolicy(job, mode);
  const previewPlatform = job?.preview?.platform?.trim().toLowerCase() || "";
  const isBilibili = previewPlatform === "bilibili";
  const isTranscribing = job?.step === "transcribing_audio";

  if (isTranscribing) {
    return `${scopeLabel}长时间没有新进度（超过 ${formatDurationLabel(policy.maxIdleMs)} 未更新，最长等待 ${formatDurationLabel(policy.hardCapMs)}）。这类视频可能卡在本地转写，请检查转写运行时后重试。`;
  }

  if (isBilibili) {
    return `${scopeLabel}超时（超过 ${formatDurationLabel(policy.hardCapMs)}），请检查小助手、Cookie 或转写运行时后重试。`;
  }

  if (job?.source_kind === "file" || job?.source_kind === "file_upload") {
    return `${scopeLabel}超时（超过 ${formatDurationLabel(policy.hardCapMs)}），请检查文件内容和服务状态后重试。`;
  }

  return `${scopeLabel}超时（超过 ${formatDurationLabel(policy.hardCapMs)}），请检查服务状态后重试。`;
}

export function resolveImportJobTimeoutState(
  job: ImportJob | null | undefined,
  pollStartedAtMs: number,
  mode: ImportProgressMode = "import",
  nowMs: number = Date.now(),
) {
  const policy = getTimeoutPolicy(job, mode);
  const lastActivityAt = getImportJobActivityTimestamp(job) ?? pollStartedAtMs;
  const hardCapExceeded = nowMs - pollStartedAtMs > policy.hardCapMs;
  const idleExceeded = nowMs - lastActivityAt > policy.maxIdleMs;

  return {
    timedOut: hardCapExceeded || idleExceeded,
    message: buildImportTimeoutMessage(job, mode),
    hardCapExceeded,
    idleExceeded,
  };
}

function normalizeImportStageStep(step: string | undefined) {
  if (step === "fetching_subtitle" || step === "fetching_audio" || step === "transcribing_audio" || step === "capturing_screenshots") {
    return "parsing_content";
  }
  return step;
}

export function isImportJobTerminal(status: string | undefined) {
  return status === "completed" || status === "failed" || status === "cancelled";
}

export function getImportJobStepMeta(
  step: string | undefined,
  mode: ImportProgressMode = "import",
): ImportStepMeta {
  const isReparse = mode === "reparse";

  if (step === "queued") {
    return isReparse
      ? { label: "已接收任务", description: "当前重整理任务已进入队列。" }
      : { label: "已接收任务", description: "当前导入任务已进入队列。" };
  }

  if (step === "detecting_source") {
    return isReparse
      ? { label: "识别来源", description: "正在确认当前内容的重解析来源，并选择合适的抓取方式。" }
      : { label: "识别来源", description: "正在确认这是视频、网页还是文件，并选择合适的抓取方式。" };
  }

  if (step === "reading_file") {
    return isReparse
      ? { label: "读取文件", description: "正在重新读取原始文件内容，并准备生成新的结构化笔记。" }
      : { label: "读取文件", description: "正在读取文件正文，并准备生成后续的结构化笔记。" };
  }

  if (step === "parsing_content") {
    return isReparse
      ? { label: "提取内容", description: "正在重新整理正文、字幕、截图和可回看的证据层。" }
      : { label: "提取内容", description: "正在整理正文、字幕、截图和可回看的证据层。" };
  }

  if (step === "fetching_subtitle") {
    return { label: "检查字幕", description: "正在确认当前视频是否有可直接使用的字幕与时间轴。" };
  }

  if (step === "fetching_audio") {
    return { label: "检查音频", description: "当前没有公开字幕，正在确认是否能回退到音频正文。" };
  }

  if (step === "transcribing_audio") {
    return { label: "音频转写", description: "正在执行本地转写，这一步通常最久，请耐心等待。" };
  }

  if (step === "capturing_screenshots") {
    return { label: "整理片段", description: "正在生成关键片段、截图与回看线索。" };
  }

  if (step === "saving_content") {
    return isReparse
      ? { label: "刷新当前内容", description: "正在保存版本历史，并用新的结果刷新当前内容。" }
      : { label: "整理入库", description: "正在生成笔记、评估质量，并写入知识库。" };
  }

  if (step === "done") {
    return isReparse
      ? { label: "重解析完成", description: "当前内容已刷新完成，可继续阅读或回看。" }
      : { label: "导入完成", description: "内容整理完成，可继续阅读、回看或提问。" };
  }

  if (step === "failed") {
    return isReparse
      ? { label: "重解析失败", description: "当前内容未能完成刷新，可调整后重新提交。" }
      : { label: "导入失败", description: "当前任务未能产出可用内容，可调整后重新提交。" };
  }

  return isReparse
    ? { label: "处理中", description: "系统正在继续整理当前重解析任务。" }
    : { label: "处理中", description: "系统正在继续整理当前导入任务。" };
}

export function getImportStageItems(
  sourceKind?: string,
  mode: ImportProgressMode = "import",
) {
  const savingLabel = mode === "reparse" ? "刷新内容" : "整理入库";

  if (sourceKind === "file" || sourceKind === "file_upload") {
    return [
      { key: "queued", label: "接收任务" },
      { key: "reading_file", label: "读取文件" },
      { key: "parsing_content", label: "提取内容" },
      { key: "saving_content", label: savingLabel },
    ] satisfies ImportStageItem[];
  }

  return [
    { key: "queued", label: "接收任务" },
    { key: "detecting_source", label: "识别来源" },
    { key: "parsing_content", label: "提取内容" },
    { key: "saving_content", label: savingLabel },
  ] satisfies ImportStageItem[];
}

export function resolveImportStageIndex(
  step: string | undefined,
  sourceKind?: string,
  mode: ImportProgressMode = "import",
) {
  const stages = getImportStageItems(sourceKind, mode);
  if (step === "done") return stages.length - 1;
  const normalizedStep = normalizeImportStageStep(step);
  const index = stages.findIndex((item) => item.key === normalizedStep);
  return index >= 0 ? index : 0;
}

export function getImportStepShortLabel(step: string | null | undefined) {
  if (step === "queued") return "已进入队列";
  if (step === "detecting_source") return "识别来源";
  if (step === "reading_file") return "读取文件";
  if (step === "parsing_content") return "提取内容";
  if (step === "fetching_subtitle") return "检查字幕";
  if (step === "fetching_audio") return "检查音频";
  if (step === "transcribing_audio") return "音频转写";
  if (step === "capturing_screenshots") return "整理片段";
  if (step === "saving_content") return "整理入库";
  if (step === "done") return "已完成";
  if (step === "failed") return "处理失败";
  return "处理中";
}
