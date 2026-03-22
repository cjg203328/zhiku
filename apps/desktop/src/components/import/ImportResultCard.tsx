import { Link } from "react-router-dom";
import { useLanguage } from "../../lib/language";
import type { NoteQuality } from "../../lib/api";
import FailureGuideCard from "./FailureGuideCard";
import StageDigest from "../StageDigest";
import {
  buildStageDigestCards,
  buildStageDigestSeeds,
  parseNoteScreenshots,
  splitStageDigestText,
} from "../../lib/stageDigest";

type DiagnosticItem = { label: string; value: string; tone: "success" | "info" | "warning" };
type RecoveryHint = { label: string; value: string; detail: string; tone: "success" | "info" | "warning"; focus?: "model" | "asr" | "bilibili" };
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
  if (status === "ready_estimated") return { label: "正文已恢复", tone: "info", hint: "当前正文来自转写，可结合证据层核对。" };
  if (status === "needs_cookie") return { label: "需要 Cookie", tone: "warning", hint: "这条视频需要登录态才能拿到完整字幕。" };
  if (status === "needs_asr") return { label: "需要转写", tone: "warning", hint: "当前没有字幕，补全转写后可大幅提升质量。" };
  if (status === "asr_failed") return { label: "转写失败", tone: "warning", hint: "转写过程有异常，当前只有部分材料。" };
  if (status === "limited") return { label: "仅基础建档", tone: "info", hint: "当前以基础材料为主，可按需继续补强。" };
  return { label: "已建档", tone: "info", hint: "内容已归档，可以继续提问。" };
}

function getNoteStyleLabel(value: string) {
  if (value === "bilinote") return "阅读版";
  if (value === "qa") return "问答版";
  if (value === "brief") return "速览版";
  return "结构版";
}

function getCaptureStrategyPill(metadata: Record<string, unknown>) {
  if (metadata.subtitle_ytdlp_fallback_used === true || metadata.audio_ytdlp_fallback_used === true) {
    return "yt-dlp 兜底";
  }
  if (typeof metadata.subtitle_fetch_strategy === "string" || typeof metadata.audio_fetch_strategy === "string") {
    return "原生采集";
  }
  return "";
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
  transcriptSegmentCount, evidenceSnippet,
  isReparsePending, isReparseSuccess, reparseMessage, isReparseError, reparseErrorMessage,
  onReparse, onReset,
}: Props) {
  const { displayText } = useLanguage();
  const statusTone = getStatusTone(preview.status);
  const captureStrategyPill = getCaptureStrategyPill(metadata);
  const visibleRecoveryHints = recoveryHints.slice(0, 3);
  const visibleFirstQuestions = firstQuestions.slice(0, 3);
  const previewScreenshots = parseNoteScreenshots(metadata);
  const previewStageSeeds = preview.key_points.length
    ? buildStageDigestSeeds(preview.key_points, {
        idPrefix: `${preview.content_id ?? preview.title}-point`,
        eyebrowPrefix: "重点",
        titlePrefix: "阶段",
        limit: 4,
      })
    : buildStageDigestSeeds(splitStageDigestText(preview.summary || preview.content_text, 4), {
        idPrefix: `${preview.content_id ?? preview.title}-summary`,
        eyebrowPrefix: "摘要",
        titlePrefix: "阶段",
        limit: 4,
      });
  const previewStageDigestItems = buildStageDigestCards(previewStageSeeds, previewScreenshots, { limit: 3 });

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
          {captureStrategyPill && <span className="pill">{displayText(captureStrategyPill)}</span>}
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
          (typeof metadata.capture_recommended_action === "string" ? metadata.capture_recommended_action : "可打开详情页继续查看当前内容。"),
        )}</p>
      </article>

      {isReparseSuccess && (
        <article className="result-callout">
          <strong>{displayText("已重新整理这条内容")}</strong>
          <p>{displayText(reparseMessage || "系统已经按当前设置重新处理材料，下面的预览已更新。")}</p>
        </article>
      )}
      {isReparseError && (
        <FailureGuideCard
          eyebrow="重新整理失败"
          title="这次没有顺利刷新内容"
          description="补齐当前关键能力后再重新整理，结果通常会更稳定。"
          message={reparseErrorMessage || "当前无法重新整理，请稍后再试。"}
          hints={recoveryHints}
          issues={importIssues}
        />
      )}

      {!!importIssues.length && (
        <details className="smart-inline-details">
          <summary>{displayText(`查看诊断细节 · ${Math.min(importIssues.length, 4)}`)}</summary>
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

      {!!previewStageDigestItems.length && (
        <StageDigest
          eyebrow="阶段总结"
          title="阶段摘要"
          description="当前结果已压缩为几个重点。"
          items={previewStageDigestItems}
          compact
          className="import-stage-digest"
        />
      )}

      {shouldShowRecoveryPanel && (
        <details className="smart-inline-details smart-inline-details-block">
          <summary>{displayText("待补能力")}</summary>
          <div className="smart-inline-panel">
            <div className="advice-grid">
              {visibleRecoveryHints.map((item) => (
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
          </div>
        </details>
      )}

      {!!visibleFirstQuestions.length && (
        <details className="smart-inline-details smart-inline-details-block">
          <summary>{displayText("问题入口")}</summary>
          <div className="smart-inline-panel">
            <div className="pill-row chip-grid">
              {visibleFirstQuestions.map((item) => (
                <Link
                  key={item}
                  className="secondary-button button-link suggestion-chip"
                  to={buildChatLink(item, { contentId: preview.content_id, title: preview.title })}
                >
                  {displayText(item)}
                </Link>
              ))}
            </div>
          </div>
        </details>
      )}

      {!previewStageDigestItems.length && !!preview.key_points.length && (
        <ul className="bullet-list compact-list">
          {preview.key_points.slice(0, 3).map((point) => (
            <li key={point}>{displayText(point)}</li>
          ))}
        </ul>
      )}

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
          {displayText("新建导入")}
        </button>
      </div>
    </article>
  );
}
