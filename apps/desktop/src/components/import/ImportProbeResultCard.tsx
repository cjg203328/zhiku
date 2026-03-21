import { Link } from "react-router-dom";
import { useLanguage } from "../../lib/language";

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
  if (status === "needs_asr") return { label: "需要转写", tone: "info", hint: "当前没有字幕，可以先补转写再导入。" };
  return { label: "可尝试导入", tone: "info", hint: "先导入看看结果，可以后续补强。" };
}

function buildSettingsLink(focus?: string) {
  return `/settings?focus=${focus ?? "model"}`;
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

  return (
    <article className="preview-card smart-result-card">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">{displayText("预检结果")}</p>
          <h4>{displayText(probe.title)}</h4>
          <p className="muted-text">{displayText(probe.predicted_summary)}</p>
        </div>
        <span className={`result-badge result-badge-${tone.tone}`}>
          {displayText(tone.label)}
        </span>
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
        <p>{displayText(probe.predicted_recommended_action || "预检通过后即可继续正式导入。")}</p>
      </article>
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
