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
  if (status === "ready") return { label: "可直接导入", tone: "success", hint: "字幕和元数据均已就绪。" };
  if (status === "needs_cookie") return { label: "需要 Cookie", tone: "warning", hint: "这条视频需要登录态才能拿到字幕。" };
  if (status === "needs_asr") return { label: "需要转写", tone: "info", hint: "当前没有字幕，可通过转写补正文。" };
  return { label: "可尝试导入", tone: "info", hint: "当前已完成基础预检，可继续导入。" };
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
      ? `正式导入后会优先围绕“${focus}”整理速览、重点和时间线回看。`
      : "正式导入后会更强调速览、重点、时间线与片段回看。";
  }
  if (noteStyle === "qa") {
    return focus
      ? `正式导入后会优先围绕“${focus}”组织可追问的问题与证据。`
      : "正式导入后会更偏向问答准备，方便继续追问。";
  }
  if (noteStyle === "brief") {
    return focus
      ? `正式导入后会围绕“${focus}”生成更短、更聚焦的结论摘要。`
      : "正式导入后会更偏向短摘要，适合快速过一遍。";
  }
  return focus
    ? `正式导入后会围绕“${focus}”生成一版结构化笔记。`
    : "正式导入后会生成兼顾摘要、要点和正文整理的结构化笔记。";
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
  const probeSummary = probe.predicted_recommended_action || getNoteStyleDescription(noteStyle, summaryFocus);

  return (
    <article className="preview-card smart-result-card">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">{displayText("预检结果")}</p>
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
          eyebrow="阶段预览"
          title="导入后重点"
          description="预检结果已压缩为几个关键段落。"
          items={probeStageDigestItems}
          compact
          className="import-probe-stage-digest"
        />
      )}
      {!!probeIssues.length && (
        <details className="smart-inline-details">
          <summary>{displayText("查看诊断细节")}</summary>
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
            {displayText("打开设置")}
          </Link>
        )}
      </div>
    </article>
  );
}
