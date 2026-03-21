import { Link } from "react-router-dom";
import { useLanguage } from "../../lib/language";
import type { NoteQuality } from "../../lib/api";

type DiagnosticItem = { label: string; value: string; tone: string };
type RecoveryHint = { label: string; value: string; detail: string; tone: string; focus?: "model" | "asr" | "bilibili" };
type Preview = {
  content_id?: string;
  title: string;
  summary: string;
  content_text: string;
  status: string;
  platform?: string;
  key_points: string[];
};

function getStatusTone(status: string) {
  if (status === "ready") return { label: "结果完整", tone: "success", hint: "已经形成可读笔记和可追问证据。" };
  if (status === "ready_estimated") return { label: "正文已恢复", tone: "info", hint: "当前正文来自转写，建议核对关键片段。" };
  if (status === "needs_cookie") return { label: "需要 Cookie", tone: "warning", hint: "这条视频需要登录态才能拿到完整字幕。" };
  if (status === "needs_asr") return { label: "需要转写", tone: "warning", hint: "当前没有字幕，补全转写后可大幅提升质量。" };
  if (status === "asr_failed") return { label: "转写失败", tone: "warning", hint: "转写过程有异常，当前只有部分材料。" };
  if (status === "limited") return { label: "仅基础建档", tone: "info", hint: "当前只采集到基础元数据，后续可补强。" };
  return { label: "已建档", tone: "info", hint: "内容已归档，可以继续提问。" };
}

function getNoteStyleLabel(value: string) {
  if (value === "qa") return "问答导向";
  if (value === "brief") return "精简速记";
  return "结构化笔记";
}

function buildSettingsLink(focus?: string) {
  return `/settings?focus=${focus ?? "model"}`;
}

function buildChatLink(q: string, opts: { contentId?: string; title?: string }) {
  const search = new URLSearchParams();
  search.set("q", q);
  if (opts.contentId) search.set("contentId", opts.contentId);
  if (opts.title) search.set("title", opts.title);
  return `/chat?${search.toString()}`;
}

type Props = {
  preview: Preview;
  metadata: Record<string, unknown>;
  noteQuality: NoteQuality | null;
  noteStyle: string;
  importDiagnostics: DiagnosticItem[];
  importIssues: string[];
  importNeedsSettings: boolean;
  firstQuestions: string[];
  shouldOfferReparse: boolean;
  recoveryHints: RecoveryHint[];
  shouldShowRecoveryPanel: boolean;
  transcriptSegmentCount: number;
  evidenceSnippet: string;
  summaryFocus: string;
  isReparsePending: boolean;
  isReparseSuccess: boolean;
  reparseMessage?: string;
  isReparseError: boolean;
  reparseErrorMessage?: string;
  onReparse: () => void;
  onReset: () => void;
};

export default function ImportResultCard({
  preview, metadata, noteQuality, noteStyle,
  importDiagnostics, importIssues, importNeedsSettings,
  firstQuestions, shouldOfferReparse, recoveryHints, shouldShowRecoveryPanel,
  transcriptSegmentCount, evidenceSnippet, summaryFocus,
  isReparsePending, isReparseSuccess, reparseMessage, isReparseError, reparseErrorMessage,
  onReparse, onReset,
}: Props) {
  const { displayText } = useLanguage();
  const statusTone = getStatusTone(preview.status);

  return (
    <article className="preview-card smart-result-card">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">{displayText("导入结果")}</p>
          <h4>{displayText(preview.title)}</h4>
          <p className="muted-text">{displayText(
            typeof metadata.capture_summary === "string"
              ? metadata.capture_summary
              : preview.summary || preview.content_text.slice(0, 120),
          )}</p>
        </div>
        <div className="pill-row">
          <span className={`result-badge result-badge-${statusTone.tone}`}>{displayText(statusTone.label)}</span>
          <span className="pill">{displayText(preview.platform || "未知来源")}</span>
          <span className="pill">{displayText(getNoteStyleLabel(noteStyle))}</span>
          {typeof noteQuality?.score === "number" && <span className="pill">{displayText(`质量 ${noteQuality.score}`)}</span>}
          {metadata.llm_enhanced === true && <span className="pill">{displayText("模型增强")}</span>}
          {metadata.noisy_asr_detected === true && <span className="pill">{displayText("转写噪声")}</span>}
        </div>
      </div>

      <div className="smart-diagnostic-strip">
        {importDiagnostics.map((item) => (
          <article className={`smart-diagnostic-card smart-diagnostic-card-${item.tone}`} key={item.label}>
            <span>{displayText(item.label)}</span>
            <strong>{displayText(item.value)}</strong>
          </article>
        ))}
      </div>

      <article className="result-callout">
        <strong>{displayText(statusTone.hint)}</strong>
        <p>{displayText(
          noteQuality?.summary ||
          (typeof metadata.capture_recommended_action === "string" ? metadata.capture_recommended_action : "下一步建议直接打开详情页继续验证。"),
        )}</p>
      </article>

      {isReparseSuccess && (
        <article className="result-callout">
          <strong>{displayText("已重新整理这条内容")}</strong>
          <p>{displayText(reparseMessage || "系统已经按当前设置重新处理材料，下面的预览已更新。")}</p>
        </article>
      )}
      {isReparseError && (
        <article className="preview-card smart-status-card">
          <p className="eyebrow">{displayText("重新整理失败")}</p>
          <p className="error-text">{displayText(reparseErrorMessage || "当前无法重新整理，请稍后再试。")}</p>
        </article>
      )}

      {!!importIssues.length && (
        <details className="smart-inline-details">
          <summary>{displayText("查看诊断细节")}</summary>
          <div className="smart-issue-list">
            {importIssues.slice(0, 4).map((item) => (
              <p className="muted-text" key={item}>{displayText(item)}</p>
            ))}
          </div>
        </details>
      )}

      <div className="result-metric-strip result-metric-strip-compact">
        <article className="result-metric-card">
          <span>{displayText("要点")}</span>
          <strong>{displayText(String(preview.key_points.length))}</strong>
        </article>
        <article className="result-metric-card">
          <span>{displayText("问答")}</span>
          <strong>{displayText(
            noteQuality?.question_answer_ready ? "可提问" : noteQuality?.retrieval_ready ? "可检索" : "待补强",
          )}</strong>
        </article>
        <article className="result-metric-card">
          <span>{displayText("证据")}</span>
          <strong>{displayText(
            transcriptSegmentCount > 0 ? String(transcriptSegmentCount) : evidenceSnippet ? "已生成" : "较弱",
          )}</strong>
        </article>
      </div>

      {shouldShowRecoveryPanel && (
        <>
          <article className="result-callout">
            <strong>{displayText("先补这几项")}</strong>
            <p>{displayText("系统已经定位到当前短板，补齐后再重整理会更稳。")}</p>
          </article>
          <div className="advice-grid">
            {recoveryHints.map((item) => (
              <article className="advice-card" key={`${item.label}-${item.value}`}>
                <span className={`result-badge result-badge-${item.tone}`}>{displayText(item.label)}</span>
                <strong>{displayText(item.value)}</strong>
                <p>{displayText(item.detail)}</p>
                {item.focus ? (
                  <Link className="text-link-inline" to={buildSettingsLink(item.focus)}>
                    {displayText("去设置")}
                  </Link>
                ) : null}
              </article>
            ))}
          </div>
        </>
      )}

      {!!firstQuestions.length && (
        <>
          <article className="result-callout">
            <strong>{displayText("建议先这样问")}</strong>
            <p>{displayText(
              noteQuality?.question_answer_ready
                ? "先用 1 到 2 个首问验证总结和证据。"
                : "先围绕材料线索提问，不要一上来追求最终结论。",
            )}</p>
          </article>
          <div className="pill-row chip-grid">
            {firstQuestions.map((item) => (
              <Link
                key={item}
                className="secondary-button button-link suggestion-chip"
                to={buildChatLink(item, { contentId: preview.content_id, title: preview.title })}
              >
                {displayText(item)}
              </Link>
            ))}
          </div>
        </>
      )}

      {!!preview.key_points.length && (
        <ul className="bullet-list compact-list">
          {preview.key_points.slice(0, 3).map((point) => (
            <li key={point}>{displayText(point)}</li>
          ))}
        </ul>
      )}

      <div className="pill-row chip-grid">
        {preview.title && (
          <Link
            className="secondary-button button-link suggestion-chip"
            to={buildChatLink(`请概括《${preview.title}》最值得记住的三个结论`, { contentId: preview.content_id, title: preview.title })}
          >
            {displayText("生成总结")}
          </Link>
        )}
        {preview.title && (
          <Link
            className="secondary-button button-link suggestion-chip"
            to={buildChatLink(`如果把《${preview.title}》整理成一页复盘，应该保留哪些信息？`, { contentId: preview.content_id, title: preview.title })}
          >
            {displayText("继续提问")}
          </Link>
        )}
      </div>

      <div className="header-actions">
        {preview.content_id && (
          <Link className="primary-button button-link" to={`/library/${preview.content_id}`}>
            {displayText("打开详情")}
          </Link>
        )}
        <Link
          className="secondary-button button-link"
          to={buildChatLink("请基于这条内容继续展开", { contentId: preview.content_id, title: preview.title })}
        >
          {displayText("去问答页")}
        </Link>
        {shouldOfferReparse && preview.content_id && (
          <button
            className="secondary-button"
            type="button"
            disabled={isReparsePending}
            onClick={onReparse}
          >
            {displayText(isReparsePending ? "重新整理中..." : "一键补强材料")}
          </button>
        )}
        {importNeedsSettings && (
          <Link
            className="secondary-button button-link"
            to={buildSettingsLink(
              preview.status === "needs_cookie"
                ? "bilibili"
                : preview.status === "needs_asr" || preview.status === "asr_failed"
                  ? "asr"
                  : "model",
            )}
          >
            {displayText("打开设置")}
          </Link>
        )}
        <button className="secondary-button" type="button" onClick={onReset}>
          {displayText("继续导入")}
        </button>
      </div>
    </article>
  );
}
