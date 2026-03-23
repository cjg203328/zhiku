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
  const progressTitle = progressPreview?.title?.trim() || importStepMeta.label;
  const progressSummarySource = progressPreview?.summary || progressPreview?.content_text || importStepMeta.description || "";
  const progressScreenshots = parseNoteScreenshots(progressPreview?.metadata);
  const isBilibiliTranscribing = progressPreview?.platform === "bilibili" && runningImportJob?.step === "transcribing_audio";
  const elapsedLabel = formatElapsedLabel(runningImportJob?.created_at);
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
      </div>

      <div className="smart-progress-track" aria-hidden="true">
        <div className="smart-progress-fill" style={{ width: `${progressValue}%` }} />
      </div>

      {isBilibiliTranscribing ? (
        <p className="muted-text import-progress-note">
          {displayText("当前已切换到本地转写，短视频通常也需要等待 1-3 分钟。")}
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
          eyebrow="处理中"
          title="当前动作"
          items={progressStageDigestItems}
          compact
          className="import-progress-stage-digest"
        />
      )}
    </article>
  );
}
