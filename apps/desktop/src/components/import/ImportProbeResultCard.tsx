import { Link } from "react-router-dom";
import { useLanguage } from "../../lib/language";
import StageDigest from "../StageDigest";
import { buildStageDigestCards, buildStageDigestSeeds, splitStageDigestText } from "../../lib/stageDigest";

type DiagnosticItem = { label: string; value: string; tone: string };
type ProbeResult = {
  title: string;
  predicted_summary: string;
  predicted_status: string;
  predicted_recommended_action: string;
};

function getProbeTone(status: string) {
  if (status === "ready") return { label: "可直接导入", tone: "success", hint: "字幕与元数据已经就绪。" };
  if (status === "ready_estimated") return { label: "可转写补全", tone: "info", hint: "当前没有公开字幕，但已经具备正文回退能力。" };
  if (status === "needs_cookie") return { label: "需登录态", tone: "warning", hint: "不补登录态时，很可能只能拿到基础档案。" };
  if (status === "needs_asr") return { label: "需转写", tone: "warning", hint: "当前没有字幕，补齐转写后成功率会明显更高。" };
  if (status === "asr_failed") return { label: "转写待重试", tone: "warning", hint: "转写链路没有成功，这还不是最终完整结果。" };
  if (status === "limited") return { label: "仅基础档案", tone: "warning", hint: "目前只能确认基础材料，不等于完整视频正文。" };
  return { label: "预检完成", tone: "info", hint: "当前展示的是导入前的能力判断。" };
}

function buildSettingsLink(focus?: string) {
  return `/settings?focus=${focus ?? "model"}`;
}

function getNoteStyleLabel(value: string) {
  if (value === "bilinote") return "阅读版";
  if (value === "qa") return "问答版";
  if (value === "brief") return "速览版";
  return "结构版";
}

function getNoteStyleDescription(noteStyle: string, summaryFocus: string) {
  const focus = summaryFocus.trim();
  if (noteStyle === "bilinote") {
    return focus
      ? `围绕“${focus}”整理重点。`
      : "整理重点。";
  }
  if (noteStyle === "qa") {
    return focus
      ? `围绕“${focus}”组织问答。`
      : "组织问答。";
  }
  if (noteStyle === "brief") {
    return focus
      ? `围绕“${focus}”生成摘要。`
      : "生成摘要。";
  }
  return focus
    ? `围绕“${focus}”生成笔记。`
    : "生成笔记。";
}

type Props = {
  probe: ProbeResult;
  probeDiagnostics: DiagnosticItem[];
  probeIssues: string[];
  probeNeedsSettings: boolean;
  urlValue: string;
  isUrlPending: boolean;
  isProbePending: boolean;
  noteStyle: string;
  summaryFocus: string;
  onDirectImport: () => void;
  onCollapse: () => void;
};

export default function ImportProbeResultCard({
  probe, probeDiagnostics, probeIssues, probeNeedsSettings,
  urlValue, isUrlPending, isProbePending,
  noteStyle, summaryFocus,
  onDirectImport, onCollapse,
}: Props) {
  const { displayText } = useLanguage();
  const tone = getProbeTone(probe.predicted_status);
  const probeStageDigestItems = buildStageDigestCards(
    buildStageDigestSeeds(splitStageDigestText(probe.predicted_summary, 3), {
      idPrefix: "probe-summary",
      eyebrowPrefix: "预览",
      titlePrefix: "阶段",
      limit: 3,
    }),
    [],
    { limit: 3 },
  );
  const noteStyleLabel = getNoteStyleLabel(noteStyle);
  const probeSummary =
    tone.tone === "success"
      ? getNoteStyleDescription(noteStyle, summaryFocus)
      : probe.predicted_status === "ready_estimated"
        ? `${getNoteStyleDescription(noteStyle, summaryFocus)} 导入时会优先尝试转写回退。`
      : probe.predicted_recommended_action || getNoteStyleDescription(noteStyle, summaryFocus);

  return (
    <article className="preview-card smart-result-card">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">{displayText("预检")}</p>
          <h4>{displayText(probe.title)}</h4>
          <p className="muted-text">{displayText(probe.predicted_summary)}</p>
        </div>
        <div className="pill-row">
          <span className={`result-badge result-badge-${tone.tone}`}>
            {displayText(tone.label)}
          </span>
          <span className="pill">{displayText(noteStyleLabel)}</span>
        </div>
      </div>
      <div className="smart-diagnostic-strip">
        {probeDiagnostics.map((item) => (
          <article className={`smart-diagnostic-card smart-diagnostic-card-${item.tone}`} key={item.label}>
            <span>{displayText(item.label)}</span>
            <strong>{displayText(item.value)}</strong>
          </article>
        ))}
      </div>
      <article className="result-callout">
        <strong>{displayText(tone.hint)}</strong>
        <p>{displayText(probeSummary || "预检通过后即可继续正式导入。")}</p>
      </article>
      {!!probeStageDigestItems.length && (
        <StageDigest
          eyebrow="预览"
          title="重点"
          items={probeStageDigestItems}
          compact
          className="import-probe-stage-digest"
        />
      )}
      {!!probeIssues.length && (
        <details className="smart-inline-details">
          <summary>{displayText(`问题 ${Math.min(probeIssues.length, 4)}`)}</summary>
          <div className="smart-issue-list">
            {probeIssues.slice(0, 4).map((item) => (
              <p className="muted-text" key={item}>{displayText(item)}</p>
            ))}
          </div>
        </details>
      )}
      <div className="header-actions">
        <button
          className="primary-button"
          type="button"
          disabled={!urlValue.trim() || isUrlPending || isProbePending}
          onClick={onDirectImport}
        >
          {displayText("直接导入")}
        </button>
        <button className="secondary-button" type="button" onClick={onCollapse}>
          {displayText("收起")}
        </button>
        {probeNeedsSettings && (
          <Link
            className="secondary-button button-link"
            to={buildSettingsLink(
              probe.predicted_status === "needs_cookie"
                ? "bilibili"
                : probe.predicted_status === "needs_asr"
                  ? "asr"
                  : "model",
            )}
          >
            {displayText("设置")}
          </Link>
        )}
      </div>
    </article>
  );
}
