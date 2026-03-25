import { useLanguage } from "../lib/language";
import type { StageDigestCard } from "../lib/stageDigest";

type StageDigestProps = {
  eyebrow: string;
  title: string;
  description?: string;
  items: StageDigestCard[];
  compact?: boolean;
  className?: string;
};

export default function StageDigest({
  eyebrow,
  title,
  description,
  items,
  compact = false,
  className = "",
}: StageDigestProps) {
  const { displayText } = useLanguage();

  if (!items.length) {
    return null;
  }

  const sectionClassName = compact
    ? `stage-digest stage-digest-compact ${className}`.trim()
    : `stage-digest ${className}`.trim();

  return (
    <section className={sectionClassName}>
      <div className="panel-heading">
        <div>
          <p className="eyebrow">{displayText(eyebrow)}</p>
          <h4>{displayText(title)}</h4>
          {description ? <p className="muted-text">{displayText(description)}</p> : null}
        </div>
        <div className="pill-row">
          <span className="pill">{displayText(`${items.length} 节`)}</span>
        </div>
      </div>

      <div className="stage-digest-grid">
        {items.map((item) => {
          const summaryParagraphs = item.summary
            .split(/\n+/)
            .map((part) => part.trim())
            .filter(Boolean);
          const content = (
            <>
              {item.imageUrl ? (
                <div className="stage-digest-image-wrap">
                  <img className="stage-digest-image" src={item.imageUrl} alt={item.imageAlt} loading="lazy" />
                  {item.badge ? <span className="stage-digest-badge">{displayText(item.badge)}</span> : null}
                </div>
              ) : null}
              <div className="stage-digest-copy">
                <span className="eyebrow">{displayText(item.eyebrow)}</span>
                <strong>{displayText(item.title)}</strong>
                {summaryParagraphs.length > 0 ? (
                  summaryParagraphs.map((paragraph, index) => (
                    <p key={`${item.id}-summary-${index}`}>{displayText(paragraph)}</p>
                  ))
                ) : (
                  <p>{displayText("已保留阶段摘要。")}</p>
                )}
              </div>
            </>
          );

          return item.href ? (
            <a className={item.imageUrl ? "stage-digest-card" : "stage-digest-card stage-digest-card-text"} key={item.id} href={item.href} target="_blank" rel="noreferrer">
              {content}
            </a>
          ) : (
            <article className={item.imageUrl ? "stage-digest-card" : "stage-digest-card stage-digest-card-text"} key={item.id}>
              {content}
            </article>
          );
        })}
      </div>
    </section>
  );
}
