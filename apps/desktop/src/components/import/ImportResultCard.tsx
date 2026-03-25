import { Link } from "react-router-dom";
import { useLanguage } from "../../lib/language";
import type { NoteGenerationMode, NoteQuality } from "../../lib/api";
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
  if (status === "ready") return { label: "完整", tone: "success", hint: "可直接查看与提问。" };
  if (status === "ready_estimated") return { label: "已补正文", tone: "info", hint: "正文来自转写。" };
  if (status === "needs_cookie") return { label: "需登录态", tone: "warning", hint: "当前缺字幕。" };
  if (status === "needs_asr") return { label: "需转写", tone: "warning", hint: "当前缺字幕。" };
  if (status === "asr_failed") return { label: "转写失败", tone: "warning", hint: "当前只保留部分材料。" };
  if (status === "limited") return { label: "基础材料", tone: "info", hint: "当前以基础材料为主。" };
  return { label: "已入库", tone: "info", hint: "内容已归档。" };
}

function getNoteStyleLabel(value: string) {
  if (value === "bilinote") return "阅读版";
  if (value === "qa") return "问答版";
  if (value === "brief") return "速览版";
  return "结构版";
}

function getNoteGenerationModeLabel(value: unknown) {
  if (value === "model_draft") return "模型成稿";
  if (value === "local_only") return "本地整理";
  return "混合模式";
}

function getCaptureGapItems(noteQuality: NoteQuality | null) {
  const rawItems = noteQuality?.capture_gap_report?.items;
  if (!Array.isArray(rawItems)) {
    return [] as Array<{ label: string; detail: string; severity: string }>;
  }
  return rawItems
    .map((item) => ({
      label: item.label?.trim() || "",
      detail: item.detail?.trim() || item.label?.trim() || "",
      severity: item.severity || "info",
    }))
    .filter((item) => item.label || item.detail);
}

function getCoverageMissingSections(noteQuality: NoteQuality | null) {
  const rawItems = noteQuality?.note_coverage_report?.missing_sections;
  if (!Array.isArray(rawItems)) {
    return [] as Array<{ label: string; excerpt: string }>;
  }
  return rawItems
    .map((item) => ({
      label: item.label?.trim() || item.position?.trim() || "",
      excerpt: item.excerpt?.trim() || "",
    }))
    .filter((item) => item.label || item.excerpt);
}

function buildSettingsLink(focus?: string) {
  return `/settings?focus=${focus ?? "model"}`;
}

function buildChatLink(q: string, opts: { contentId?: string; title?: string }) {
  const search = new URLSearchParams();
  search.set("q", q);
  if (opts.contentId?.trim()) search.set("contentId", opts.contentId.trim());
  if (opts.title?.trim()) search.set("title", opts.title.trim());
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
  isReparsePending: boolean;
  isReparseSuccess: boolean;
  reparseMessage?: string;
  isReparseError: boolean;
  reparseErrorMessage?: string;
  reparseNoteGenerationMode: NoteGenerationMode;
  onReparseNoteGenerationModeChange: (value: NoteGenerationMode) => void;
  onReparse: () => void;
  onReset: () => void;
};

const REPARSE_MODE_ITEMS: Array<{ value: NoteGenerationMode; label: string }> = [
  { value: "model_draft", label: "模型成稿" },
  { value: "hybrid", label: "混合模式" },
  { value: "local_only", label: "本地整理" },
];

export default function ImportResultCard({
  preview, metadata, noteQuality, noteStyle,
  importDiagnostics, importIssues, importNeedsSettings,
  firstQuestions, shouldOfferReparse, recoveryHints, shouldShowRecoveryPanel,
  isReparsePending, isReparseSuccess, reparseMessage, isReparseError, reparseErrorMessage,
  reparseNoteGenerationMode, onReparseNoteGenerationModeChange,
  onReparse, onReset,
}: Props) {
  const { displayText } = useLanguage();
  const statusTone = getStatusTone(preview.status);
  const captureSummary = typeof metadata.capture_summary === "string" ? metadata.capture_summary.trim() : "";
  const captureAction = typeof metadata.capture_recommended_action === "string" ? metadata.capture_recommended_action.trim() : "";
  const visibleRecoveryHints = recoveryHints.slice(0, 3);
  const visibleFirstQuestions = firstQuestions.slice(0, 3);
  const captureGapItems = getCaptureGapItems(noteQuality).slice(0, 3);
  const coverageMissingSections = getCoverageMissingSections(noteQuality).slice(0, 3);
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
  const resultCalloutBody =
    statusTone.tone === "warning"
      ? captureAction || noteQuality?.summary || captureSummary || "当前可先查看已保留结果。"
      : captureSummary || noteQuality?.summary || "可打开详情继续查看。";

  return (
    <article className="preview-card smart-result-card">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">{displayText("结果")}</p>
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
          <span className="pill">{displayText(getNoteGenerationModeLabel(metadata.note_generation_mode))}</span>
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
        <p>{displayText(resultCalloutBody)}</p>
      </article>

      {(captureGapItems.length > 0 || coverageMissingSections.length > 0) && (
        <details className="smart-inline-details smart-inline-details-block">
          <summary>{displayText("缺口")}</summary>
          <div className="smart-inline-panel">
            {!!captureGapItems.length && (
              <div className="smart-issue-list">
                {captureGapItems.map((item) => (
                  <p className="muted-text" key={`${item.label}-${item.detail}`}>
                    {displayText(item.detail || item.label)}
                  </p>
                ))}
              </div>
            )}
            {!!coverageMissingSections.length && (
              <div className="smart-issue-list">
                {coverageMissingSections.map((item) => (
                  <p className="muted-text" key={`${item.label}-${item.excerpt}`}>
                    {displayText(item.excerpt ? `${item.label}：${item.excerpt}` : item.label)}
                  </p>
                ))}
              </div>
            )}
          </div>
        </details>
      )}

      {isReparseSuccess && (
        <article className="result-callout">
          <strong>{displayText("已刷新内容")}</strong>
          <p>{displayText(reparseMessage || "已更新。")}</p>
        </article>
      )}
      {isReparseError && (
        <FailureGuideCard
          eyebrow="重新整理失败"
          title="刷新失败"
          description="补齐后再试。"
          message={reparseErrorMessage || "当前无法重新整理，请稍后再试。"}
          hints={recoveryHints}
          issues={importIssues}
        />
      )}

      {!!importIssues.length && (
        <details className="smart-inline-details">
          <summary>{displayText(`问题 ${Math.min(importIssues.length, 4)}`)}</summary>
          <div className="smart-issue-list">
            {importIssues.slice(0, 4).map((item) => (
              <p className="muted-text" key={item}>{displayText(item)}</p>
            ))}
          </div>
        </details>
      )}

      {!!previewStageDigestItems.length && (
        <StageDigest
          eyebrow="阶段"
          title="重点"
          items={previewStageDigestItems}
          compact
          className="import-stage-digest"
        />
      )}

      {shouldShowRecoveryPanel && (
        <details className="smart-inline-details smart-inline-details-block">
          <summary>{displayText("处理")}</summary>
          <div className="smart-inline-panel">
            <div className="advice-grid">
              {visibleRecoveryHints.map((item) => (
                <article className="advice-card" key={`${item.label}-${item.value}`}>
                  <span className={`result-badge result-badge-${item.tone}`}>{displayText(item.label)}</span>
                  <strong>{displayText(item.value)}</strong>
                  <p>{displayText(item.detail)}</p>
                  {item.focus ? (
                    <Link className="text-link-inline" to={buildSettingsLink(item.focus)}>
                      {displayText("设置")}
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
          <summary>{displayText("可提问")}</summary>
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
          {displayText("问答")}
        </Link>
        {shouldOfferReparse && preview.content_id && (
          <div className="result-reparse-mode-box">
            <span>{displayText("重解析成稿")}</span>
            <div className="segment-rail result-reparse-mode-rail">
              {REPARSE_MODE_ITEMS.map((item) => (
                <button
                  key={item.value}
                  type="button"
                  className={reparseNoteGenerationMode === item.value ? "segment-pill segment-pill-active" : "segment-pill"}
                  onClick={() => onReparseNoteGenerationModeChange(item.value)}
                  disabled={isReparsePending}
                >
                  {displayText(item.label)}
                </button>
              ))}
            </div>
          </div>
        )}
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
