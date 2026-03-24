import { useLanguage } from "../../lib/language";
import StageDigest from "../StageDigest";
import {
  buildStageDigestCards,
  buildStageDigestSeeds,
  parseNoteScreenshots,
  splitStageDigestText,
} from "../../lib/stageDigest";

type StageItem = { key: string; label: string };
type StepMeta = { label: string; description: string };
type RunningJob = {
  progress?: number;
  step?: string;
  created_at?: string;
  updated_at?: string;
  preview: {
    platform?: string;
    title?: string;
    summary?: string;
    content_text?: string;
    key_points?: string[];
    metadata?: Record<string, unknown>;
  };
};

type Props = {
  runningImportJob: RunningJob | null;
  importStepMeta: StepMeta;
  importStageItems: StageItem[];
  importStageIndex: number;
};

function readMetadataText(metadata: Record<string, unknown>, key: string) {
  const value = metadata[key];
  return typeof value === "string" ? value.trim() : "";
}

function getPredictedOutcome(status: string) {
  if (status === "ready") return { label: "预估结果：可直接导入", tone: "success" as const };
  if (status === "ready_estimated") return { label: "预估结果：可转写补全", tone: "info" as const };
  if (status === "needs_cookie") return { label: "预估结果：可能卡在登录态", tone: "warning" as const };
  if (status === "needs_asr") return { label: "预估结果：需要补转写", tone: "warning" as const };
  if (status === "asr_failed") return { label: "预估结果：转写需重试", tone: "warning" as const };
  if (status === "limited") return { label: "预估结果：只能先建基础档案", tone: "warning" as const };
  return null;
}

function formatElapsedLabel(createdAt: string | undefined) {
  if (!createdAt) {
    return "";
  }

  const startedAt = Date.parse(createdAt);
  if (Number.isNaN(startedAt)) {
    return "";
  }

  const totalSeconds = Math.max(1, Math.floor((Date.now() - startedAt) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}小时${minutes}分`;
  }
  if (minutes > 0) {
    return `${minutes}分${seconds}秒`;
  }
  return `${seconds}秒`;
}

function formatRecentUpdateLabel(updatedAt: string | undefined) {
  if (!updatedAt) {
    return "";
  }

  const timestamp = Date.parse(updatedAt);
  if (Number.isNaN(timestamp)) {
    return "";
  }

  const diffSeconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (diffSeconds <= 5) {
    return "刚刚";
  }
  if (diffSeconds < 60) {
    return `${diffSeconds}秒前`;
  }

  const minutes = Math.floor(diffSeconds / 60);
  if (minutes < 60) {
    return `${minutes}分钟前`;
  }

  const hours = Math.floor(minutes / 60);
  return `${hours}小时前`;
}

function getPlatformLabel(platform: string | undefined) {
  if (!platform) return "";
  if (platform === "bilibili") return "B站";
  if (platform === "local_file") return "文件";
  if (platform === "webpage") return "网页";
  return platform;
}

export default function ImportProgressCard({ runningImportJob, importStepMeta, importStageItems, importStageIndex }: Props) {
  const { displayText } = useLanguage();
  const progressValue = Math.min(100, Math.max(runningImportJob?.progress ?? 0, 5));
  const progressPreview = runningImportJob?.preview;
  const progressMetadata =
    progressPreview?.metadata && typeof progressPreview.metadata === "object"
      ? (progressPreview.metadata as Record<string, unknown>)
      : {};
  const runtimeSummary = readMetadataText(progressMetadata, "job_runtime_summary");
  const predictedSummary = readMetadataText(progressMetadata, "predicted_summary");
  const predictedStatus = readMetadataText(progressMetadata, "predicted_status");
  const hasRuntimePreview = Boolean(runtimeSummary || readMetadataText(progressMetadata, "job_runtime_step"));
  const jobSeededFromProbe = progressMetadata.job_seeded_from_probe === true;
  const progressTitle = progressPreview?.title?.trim() || importStepMeta.label;
  const progressSummarySource = runtimeSummary || (hasRuntimePreview ? progressPreview?.summary || progressPreview?.content_text || importStepMeta.description || "" : importStepMeta.description || "");
  const provisionalTitle = hasRuntimePreview ? "当前还在处理中" : "当前还是预估阶段";
  const provisionalBody = hasRuntimePreview
    ? "下面展示的是阶段性预览，不代表最终结论；导入完成后会自动替换为真正的结果卡片。"
    : "下面这部分主要来自导入前预检和初始排队信息，不代表最终正文已经拿到。";
  const predictedOutcome = getPredictedOutcome(predictedStatus);
  const progressScreenshots = parseNoteScreenshots(progressPreview?.metadata);
  const isBilibiliTranscribing = progressPreview?.platform === "bilibili" && runningImportJob?.step === "transcribing_audio";
  const elapsedLabel = formatElapsedLabel(runningImportJob?.created_at);
  const lastHeartbeatAt =
    readMetadataText(progressMetadata, "job_runtime_last_heartbeat_at") || runningImportJob?.updated_at || "";
  const lastHeartbeatLabel = formatRecentUpdateLabel(lastHeartbeatAt);
  const runtimeActivityLabel = readMetadataText(progressMetadata, "job_runtime_activity_label");
  const platformLabel = getPlatformLabel(progressPreview?.platform);
  const progressStageSeeds = (progressPreview?.key_points?.length ?? 0) > 0
    ? buildStageDigestSeeds(progressPreview?.key_points ?? [], {
        idPrefix: "progress-point",
        eyebrowPrefix: "重点",
        titlePrefix: "阶段",
        limit: 3,
      })
    : buildStageDigestSeeds(splitStageDigestText(progressSummarySource, 3), {
        idPrefix: "progress-summary",
        eyebrowPrefix: "进度",
        titlePrefix: "阶段",
        limit: 3,
      });
  const progressStageDigestItems = buildStageDigestCards(progressStageSeeds, progressScreenshots, { limit: 3 });

  return (
    <article className="preview-card smart-status-card">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">{displayText("处理中")}</p>
          <h4>{displayText(progressTitle)}</h4>
        </div>
        <span className="pill">{displayText(`${progressValue}%`)}</span>
      </div>

      <div className="pill-row import-progress-meta-row">
        {progressTitle !== importStepMeta.label ? <span className="pill">{displayText(importStepMeta.label)}</span> : null}
        {platformLabel ? <span className="pill">{displayText(platformLabel)}</span> : null}
        {elapsedLabel ? <span className="pill">{displayText(`已耗时 ${elapsedLabel}`)}</span> : null}
        {isBilibiliTranscribing && lastHeartbeatLabel ? <span className="pill">{displayText(`最近更新 ${lastHeartbeatLabel}`)}</span> : null}
      </div>

      <div className="smart-progress-track" aria-hidden="true">
        <div className="smart-progress-fill" style={{ width: `${progressValue}%` }} />
      </div>

      <article className="result-callout">
        <strong>{displayText(provisionalTitle)}</strong>
        <p>{displayText(provisionalBody)}</p>
      </article>

      {jobSeededFromProbe && predictedSummary ? (
        <article className="smart-progress-preview">
          {predictedOutcome ? (
            <div className="pill-row">
              <span className={`result-badge result-badge-${predictedOutcome.tone}`}>{displayText(predictedOutcome.label)}</span>
            </div>
          ) : null}
          <p>{displayText(predictedSummary)}</p>
        </article>
      ) : null}

      {isBilibiliTranscribing ? (
        <p className="muted-text import-progress-note">
          {displayText(
            runtimeActivityLabel
              ? `${runtimeActivityLabel}。`
              : lastHeartbeatLabel
                ? `当前已切换到本地转写，任务仍在继续，最近一次状态更新在${lastHeartbeatLabel}。`
                : "当前已切换到本地转写，短视频通常也需要等待 1-3 分钟。",
          )}
        </p>
      ) : null}

      <div className="status-timeline">
        {importStageItems.map((stage, index) => (
          <div
            key={stage.key}
            className={
              index === importStageIndex
                ? "status-step status-step-active"
                : index < importStageIndex
                  ? "status-step status-step-done"
                  : "status-step"
            }
          >
            {displayText(stage.label)}
          </div>
        ))}
      </div>

      {progressSummarySource ? (
        <article className="smart-progress-preview">
          <p>{displayText(progressSummarySource)}</p>
        </article>
      ) : null}

      {!!progressStageDigestItems.length && (
        <StageDigest
          eyebrow={jobSeededFromProbe && !hasRuntimePreview ? "预检线索" : "处理中"}
          title={jobSeededFromProbe && !hasRuntimePreview ? "当前预估路线" : "当前动作"}
          items={progressStageDigestItems}
          compact
          className="import-progress-stage-digest"
        />
      )}
    </article>
  );
}
