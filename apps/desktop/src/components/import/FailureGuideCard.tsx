import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { useLanguage } from "../../lib/language";

type GuideHint = {
  label: string;
  value: string;
  detail: string;
  tone: "success" | "info" | "warning";
  focus?: "model" | "asr" | "bilibili";
};

type FailureGuideCardProps = {
  eyebrow: string;
  title: string;
  message: string;
  description?: string;
  hints?: GuideHint[];
  issues?: string[];
  actions?: ReactNode;
};

export default function FailureGuideCard({
  eyebrow,
  title,
  message,
  description = "",
  hints = [],
  issues = [],
  actions = null,
}: FailureGuideCardProps) {
  const { displayText } = useLanguage();

  return (
    <article className="preview-card smart-status-card failure-guide-card">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">{displayText(eyebrow)}</p>
          <h4>{displayText(title)}</h4>
          {description && !hints.length && !issues.length ? <p className="muted-text">{displayText(description)}</p> : null}
        </div>
      </div>

      <p className="error-text failure-guide-message">{displayText(message)}</p>

      {!!hints.length && (
        <div className="failure-guide-list">
          {hints.slice(0, 3).map((item, index) => (
            <article className="failure-guide-item" key={`hint-${index}`}>
              <div className="failure-guide-item-head">
                <span className={`result-badge result-badge-${item.tone}`}>{displayText(item.label)}</span>
                {item.focus ? (
                  <Link className="text-link-inline" to={`/settings?focus=${item.focus}`}>
                    {displayText("设置")}
                  </Link>
                ) : null}
              </div>
              <strong>{displayText(item.value)}</strong>
              <p>{displayText(item.detail)}</p>
            </article>
          ))}
        </div>
      )}

      {!!issues.length && (
        <details className="smart-inline-details">
          <summary>{displayText(`详情 ${issues.length}`)}</summary>
          <div className="smart-issue-list">
            {issues.slice(0, 5).map((item, index) => (
              <p className="muted-text" key={`issue-${index}`}>{displayText(item)}</p>
            ))}
          </div>
        </details>
      )}

      {actions ? <div className="header-actions">{actions}</div> : null}
    </article>
  );
}
