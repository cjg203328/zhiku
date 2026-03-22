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
  preview: {
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

export default function ImportProgressCard({ runningImportJob, importStepMeta, importStageItems, importStageIndex }: Props) {
  const { displayText } = useLanguage();
  const progressValue = Math.min(100, Math.max(runningImportJob?.progress ?? 0, 5));
  const progressPreview = runningImportJob?.preview;
  const progressSummarySource = progressPreview?.summary || progressPreview?.content_text || "";
  const progressScreenshots = parseNoteScreenshots(progressPreview?.metadata);
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
          <p className="eyebrow">{displayText("解析进度")}</p>
          <h4>{displayText(importStepMeta.label)}</h4>
          <p className="muted-text">{displayText(importStepMeta.description)}</p>
        </div>
        <span className="pill">{displayText(`${progressValue}%`)}</span>
      </div>
      <div className="smart-progress-track" aria-hidden="true">
        <div className="smart-progress-fill" style={{ width: `${progressValue}%` }} />
      </div>
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
      {progressPreview?.title && (
        <article className="smart-progress-preview">
          <strong>{displayText(progressPreview.title)}</strong>
          <p>{displayText(progressSummarySource || "系统正在持续整理内容。")}</p>
        </article>
      )}
      {!!progressStageDigestItems.length && (
        <StageDigest
          eyebrow="处理中"
          title="当前重点"
          description="已提取内容会在这里持续刷新。"
          items={progressStageDigestItems}
          compact
          className="import-progress-stage-digest"
        />
      )}
    </article>
  );
}
