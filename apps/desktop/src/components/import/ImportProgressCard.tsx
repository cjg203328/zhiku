import { useLanguage } from "../../lib/language";

type StageItem = { key: string; label: string };
type StepMeta = { label: string; description: string };
type RunningJob = { progress?: number; preview: { title?: string; summary?: string } };

type Props = {
  runningImportJob: RunningJob | null;
  importStepMeta: StepMeta;
  importStageItems: StageItem[];
  importStageIndex: number;
};

export default function ImportProgressCard({ runningImportJob, importStepMeta, importStageItems, importStageIndex }: Props) {
  const { displayText } = useLanguage();
  return (
    <article className="preview-card smart-status-card">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">{displayText("解析进度")}</p>
          <h4>{displayText(importStepMeta.label)}</h4>
          <p className="muted-text">{displayText(importStepMeta.description)}</p>
        </div>
        <span className="pill">{displayText(`${Math.max(runningImportJob?.progress ?? 0, 5)}%`)}</span>
      </div>
      <div className="smart-progress-track" aria-hidden="true">
        <div
          className="smart-progress-fill"
          style={{ width: `${Math.min(100, Math.max(runningImportJob?.progress ?? 0, 5))}%` }}
        />
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
      {runningImportJob?.preview.title && (
        <div className="glass-callout">
          <strong>{displayText(runningImportJob.preview.title)}</strong>
          <p className="muted-text">
            {displayText(runningImportJob.preview.summary || "系统正在持续整理内容，完成后会自动展示结果。")}
          </p>
        </div>
      )}
    </article>
  );
}
