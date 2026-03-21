import { Link } from "react-router-dom";
import { useLanguage } from "../../lib/language";

type CapabilityItem = {
  label: string;
  value: string;
  detail: string;
  tone: "success" | "info" | "warning";
  focus: "model" | "asr" | "bilibili";
};

type CapabilityReadiness = {
  summary: string;
  items: CapabilityItem[];
};

function buildSettingsLink(focus: "model" | "asr" | "bilibili") {
  return `/settings?focus=${focus}`;
}

type Props = {
  readiness: CapabilityReadiness;
};

export default function ImportCapabilityCard({ readiness }: Props) {
  const { displayText } = useLanguage();
  return (
    <article className="preview-card smart-status-card capability-readiness-card">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">{displayText("当前能力")}</p>
          <h4>{displayText("导入前先看这 4 项")}</h4>
          <p className="muted-text">{displayText(readiness.summary)}</p>
        </div>
        <Link className="secondary-button button-link" to="/settings">
          {displayText("去设置")}
        </Link>
      </div>
      <div className="capability-grid">
        {readiness.items.map((item) => (
          <article className={`smart-diagnostic-card smart-diagnostic-card-${item.tone} capability-card`} key={item.label}>
            <span>{displayText(item.label)}</span>
            <strong>{displayText(item.value)}</strong>
            <p>{displayText(item.detail)}</p>
            <Link className="text-link-inline" to={buildSettingsLink(item.focus)}>
              {displayText("去设置")}
            </Link>
          </article>
        ))}
      </div>
    </article>
  );
}
