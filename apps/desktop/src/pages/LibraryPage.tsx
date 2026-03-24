import React, { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "react-router-dom";
import ImportPanel from "../components/ImportPanel";
import StageDigest from "../components/StageDigest";
import {
  assignContentCollection,
  createCollection,
  deleteCollection,
  deleteContent,
  getContent,
  getContents,
  listCollections,
  listImportJobs,
  upgradeContents,
  type Collection,
  type ContentDetail,
} from "../lib/api";
import { useLanguage } from "../lib/language";
import {
  buildStageDigestCards,
  buildStageDigestSeeds,
  parseNoteScreenshots,
  splitStageDigestText,
} from "../lib/stageDigest";
import { getImportStepShortLabel } from "../lib/importProgress";

const SEARCH_HISTORY_KEY = "zhiku_search_history";
const SEARCH_HISTORY_MAX = 6;

type FilterKey = "all" | "video" | "article" | "note";

type LibraryCardItem = {
  id: string;
  title: string;
  source: string;
  sourceUrl?: string | null;
  sourceFile?: string | null;
  summary: string;
  tags: string[];
  coverUrl: string | null;
  parseMode: string | null;
  noteStyle: string | null;
  status: string | null;
  updatedAt: string;
  isDemo: boolean;
};

type PendingFocusItem = {
  contentId: string;
  title: string;
  status: string;
  suggestedQuestions: string[];
};

type WorkspaceNotice = {
  title: string;
  description: string;
  linkTo?: string;
  linkLabel?: string;
  tone?: "default" | "warning";
};

function buildLibraryCardSourceKey(item: LibraryCardItem) {
  const sourceUrl = item.sourceUrl?.trim().toLowerCase();
  if (sourceUrl) {
    return `url:${sourceUrl}`;
  }

  const sourceFile = item.sourceFile?.trim().toLowerCase();
  if (sourceFile) {
    return `file:${sourceFile}`;
  }

  const normalizedTitle = item.title.trim().toLowerCase();
  const normalizedSource = item.source.trim().toLowerCase();
  const normalizedNoteStyle = (item.noteStyle ?? "").trim().toLowerCase();
  if (normalizedTitle) {
    return `fallback:${normalizedSource}:${normalizedNoteStyle}:${normalizedTitle}`;
  }

  return `id:${item.id}`;
}

function dedupeLibraryCards(items: LibraryCardItem[]) {
  const deduped: LibraryCardItem[] = [];
  const seen = new Set<string>();

  for (const item of items) {
    const key = buildLibraryCardSourceKey(item);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(item);
  }

  return deduped;
}

function loadSearchHistory(): string[] {
  try {
    const raw = window.localStorage.getItem(SEARCH_HISTORY_KEY);
    return raw ? (JSON.parse(raw) as string[]) : [];
  } catch {
    return [];
  }
}

function clearSearchHistory() {
  try { window.localStorage.removeItem(SEARCH_HISTORY_KEY); } catch {}
}

function saveSearchHistory(term: string) {
  const trimmed = term.trim();
  if (!trimmed) {
    return;
  }
  const next = [trimmed, ...loadSearchHistory().filter((item) => item !== trimmed)].slice(0, SEARCH_HISTORY_MAX);
  try {
    window.localStorage.setItem(SEARCH_HISTORY_KEY, JSON.stringify(next));
  } catch {
    // Ignore local storage failures and keep the page interactive.
  }
}

function getNoteStyleLabel(value: string | null) {
  if (value === "bilinote") return "阅读版";
  if (value === "qa") return "问答版";
  if (value === "brief") return "速览版";
  if (value === "structured") return "结构版";
  return "原始建档";
}

function getSourceDescription(source: string) {
  const normalized = source.toLowerCase();
  if (normalized.includes("bilibili") || normalized.includes("video")) return "视频内容";
  if (normalized.includes("web") || normalized.includes("article")) return "网页文章";
  if (normalized.includes("doc") || normalized.includes("file")) return "文档资料";
  if (normalized.includes("assistant") || normalized.includes("note")) return "对话沉淀";
  return "知识来源";
}

function getStatusLabel(status: string | null | undefined, parseMode: string | null, noteStyle: string | null) {
  if (status === "ready") return "完整可用";
  if (status === "ready_estimated") return "正文已恢复";
  if (status === "needs_cookie") return "待补登录态";
  if (status === "needs_asr") return "待补转写";
  if (status === "asr_failed") return "转写失败";
  if (status === "limited") return "材料偏弱";
  if (parseMode === "api") return "官方信息较完整";
  if (noteStyle) return "已生成笔记";
  return "基础建档";
}

function getStatusPillClass(status: string | null | undefined) {
  if (status === "ready" || status === "ready_estimated") return "pill pill-success";
  if (status === "needs_cookie" || status === "needs_asr" || status === "asr_failed") return "pill pill-warning";
  if (status === "limited") return "pill";
  return "pill subtle-pill";
}

function getPendingStepLabel(step: string | null | undefined) {
  if (step === "queued") return "已进入队列";
  if (step === "detecting_source") return "识别来源";
  if (step === "reading_file") return "读取文件";
  if (step === "parsing_content") return "提取正文";
  if (step === "saving_content") return "整理入库";
  if (step === "done") return "已完成";
  if (step === "failed") return "处理失败";
  return "处理中";
}

function plainText(value: string) {
  return value
    .replace(/<[^>]+>/g, " ")
    .replace(/\[(.*?)\]\((.*?)\)/g, "$1")
    .replace(/`/g, "")
    .replace(/[#>*_-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function snippet(value: string, limit = 200) {
  const clean = plainText(value);
  if (!clean) return "";
  return clean.length <= limit ? clean : `${clean.slice(0, limit).trimEnd()}...`;
}

function getMetadata(detail: ContentDetail | undefined) {
  const raw = detail?.metadata;
  return raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
}

function getNotePreview(detail: ContentDetail | undefined) {
  if (!detail) {
    return "";
  }
  const metadata = getMetadata(detail);
  const refined = typeof metadata.refined_note_markdown === "string" ? metadata.refined_note_markdown : "";
  const note = typeof metadata.note_markdown === "string" ? metadata.note_markdown : "";
  const source = refined || note || detail.content_text || detail.summary;
  return snippet(source, 800);
}

function getTranscriptSegmentCount(detail: ContentDetail | undefined) {
  const metadata = getMetadata(detail);
  const noteQuality = metadata.note_quality;
  if (
    noteQuality &&
    typeof noteQuality === "object" &&
    typeof (noteQuality as { transcript_segments?: unknown }).transcript_segments === "number"
  ) {
    return (noteQuality as { transcript_segments: number }).transcript_segments;
  }
  return Array.isArray(metadata.transcript_segments) ? metadata.transcript_segments.length : 0;
}

function getQualityScore(detail: ContentDetail | undefined) {
  const metadata = getMetadata(detail);
  const noteQuality = metadata.note_quality;
  if (
    noteQuality &&
    typeof noteQuality === "object" &&
    typeof (noteQuality as { score?: unknown }).score === "number"
  ) {
    return (noteQuality as { score: number }).score;
  }
  return null;
}

function formatDateTime(value: string | null | undefined) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toLocaleString();
}

function buildQuickQuestions(detail: ContentDetail | undefined) {
  if (!detail) return [];
  const title = detail.title.trim();
  if (!title) return [];
  return [
    `请概括《${title}》最值得记住的三个结论`,
    `围绕《${title}》，还可以继续展开哪些问题`,
    `如果把《${title}》整理成一页复盘，应该保留哪些信息`,
  ];
}

const mockCards: LibraryCardItem[] = [
  {
    id: "demo-bilibili-001",
    title: "AI 时代的学习方法",
    source: "Bilibili",
    sourceUrl: null,
    sourceFile: null,
    summary: "把视频里的观点沉淀成结构化笔记，再继续追问和回看证据。",
    tags: ["学习", "AI", "知识管理"],
    coverUrl: null,
    parseMode: null,
    noteStyle: "structured",
    status: "ready",
    updatedAt: "",
    isDemo: true,
  },
  {
    id: "demo-docx-001",
    title: "用户访谈纪要",
    source: "DOCX",
    sourceUrl: null,
    sourceFile: null,
    summary: "保留文档导入能力，适合把调研和访谈资料也统一沉淀进来。",
    tags: ["调研", "访谈", "产品"],
    coverUrl: null,
    parseMode: null,
    noteStyle: "brief",
    status: "ready",
    updatedAt: "",
    isDemo: true,
  },
];

function highlightKeyword(
  text: string,
  keyword: string,
  displayText: (value: string | null | undefined) => string,
): React.ReactNode {
  const renderedText = displayText(text);
  const renderedKeyword = displayText(keyword).trim();
  if (!renderedKeyword || !renderedText) return renderedText;
  const escaped = renderedKeyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const parts = renderedText.split(new RegExp(`(${escaped})`, "gi"));
  if (parts.length === 1) return renderedText;
  return parts.map((part, i) =>
    part.toLowerCase() === renderedKeyword.toLowerCase()
      ? <mark key={i} className="search-highlight">{part}</mark>
      : part
  );
}

const filterItems: { key: FilterKey; label: string; hint: string }[] = [
  { key: "all", label: "全部内容", hint: "总览" },
  { key: "video", label: "视频笔记", hint: "视频来源" },
  { key: "article", label: "网页文章", hint: "正文导入" },
  { key: "note", label: "问答沉淀", hint: "卡片回看" },
];

export default function LibraryPage() {
  const { displayText } = useLanguage();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const importPanelRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [searchTerm, setSearchTerm] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [searchHistory, setSearchHistory] = useState<string[]>(() => loadSearchHistory());
  const [showSearchHistory, setShowSearchHistory] = useState(false);
  const [activeFilter, setActiveFilter] = useState<FilterKey>("all");
  const [activeCollectionId, setActiveCollectionId] = useState<string | null>(null);
  const [showCollectionPanel, setShowCollectionPanel] = useState(false);
  const [newCollectionName, setNewCollectionName] = useState("");
  const [maintenanceMessage, setMaintenanceMessage] = useState("");
  const [selectedCardId, setSelectedCardId] = useState("");
  const [pendingFocusItem, setPendingFocusItem] = useState<PendingFocusItem | null>(null);
  const [workspaceNotice, setWorkspaceNotice] = useState<WorkspaceNotice | null>(null);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const trimmed = searchTerm.trim();
      setDebouncedSearch(trimmed);
      if (trimmed) {
        saveSearchHistory(trimmed);
        setSearchHistory(loadSearchHistory());
      }
    }, 320);
    return () => window.clearTimeout(timer);
  }, [searchTerm]);

  const pendingJobsQuery = useQuery({
    queryKey: ["imports", "pending"],
    queryFn: () => listImportJobs("pending"),
    refetchInterval: (query) => ((query.state.data?.pending_count ?? 0) > 0 ? 1600 : false),
  });
  const pendingCount = pendingJobsQuery.data?.pending_count ?? 0;

  const contentsQuery = useQuery({
    queryKey: ["contents", debouncedSearch, activeCollectionId],
    queryFn: () => getContents(debouncedSearch, activeCollectionId),
    retry: 1,
    refetchInterval: pendingCount > 0 ? 1800 : false,
  });

  const collectionsQuery = useQuery({
    queryKey: ["collections"],
    queryFn: listCollections,
    retry: 1,
  });

  const createCollectionMutation = useMutation({
    mutationFn: (name: string) => createCollection({ name }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["collections"] });
      setNewCollectionName("");
      setShowCollectionPanel(false);
    },
  });

  const deleteCollectionMutation = useMutation({
    mutationFn: (id: string) => deleteCollection(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["collections"] });
      if (activeCollectionId) {
        setActiveCollectionId(null);
      }
    },
  });

  const assignCollectionMutation = useMutation({
    mutationFn: ({ contentId, collectionId }: { contentId: string; collectionId: string | null }) =>
      assignContentCollection(contentId, collectionId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["contents"] }),
  });

  const upgradeMutation = useMutation({
    mutationFn: () =>
      upgradeContents({
        limit: 40,
        retry_incomplete: true,
      }),
    onSuccess: async (result) => {
      await queryClient.invalidateQueries({ queryKey: ["contents"] });
      setMaintenanceMessage(result.message);
    },
    onError: (error) => {
      setMaintenanceMessage(error instanceof Error ? error.message : "旧内容升级失败，请稍后再试。");
    },
  });

  const cards = useMemo<LibraryCardItem[]>(() => {
    if (contentsQuery.data?.items?.length) {
      return contentsQuery.data.items.map((item) => ({
        id: item.id,
        title: item.title,
        sourceUrl: item.source_url ?? null,
        sourceFile: item.source_file ?? null,
        source: item.platform ?? item.source_type ?? "未知来源",
        summary: item.summary || "当前还没有摘要。",
        tags: item.tags,
        coverUrl: item.cover_url ?? null,
        parseMode: item.parse_mode ?? null,
        noteStyle: item.note_style ?? null,
        status: item.status ?? null,
        updatedAt: item.updated_at,
        isDemo: false,
      }));
    }

    if (contentsQuery.isSuccess) {
      return [];
    }

    return mockCards;
  }, [contentsQuery.data, contentsQuery.isSuccess]);

  const dedupedCards = useMemo(() => dedupeLibraryCards(cards), [cards]);

  const filteredCards = useMemo(() => {
    let result = dedupedCards;
    if (activeFilter !== "all") {
      result = result.filter((item) => {
        const source = item.source.toLowerCase();
        if (activeFilter === "video") return source.includes("bilibili") || source.includes("video");
        if (activeFilter === "article") return source.includes("web") || source.includes("article") || source.includes("网页");
        return source.includes("assistant") || source.includes("note") || item.noteStyle !== null;
      });
    }
    return result;
  }, [activeFilter, dedupedCards]);

  useEffect(() => {
    if (!filteredCards.length) {
      setSelectedCardId("");
      return;
    }
    if (!selectedCardId || !filteredCards.some((item) => item.id === selectedCardId)) {
      setSelectedCardId(filteredCards[0].id);
    }
  }, [filteredCards, selectedCardId]);

  useEffect(() => {
    if (!pendingFocusItem) {
      return;
    }
    const matchedCard = dedupedCards.find((item) => item.id === pendingFocusItem.contentId);
    if (!matchedCard) {
      return;
    }
    setSelectedCardId(matchedCard.id);
    setPendingFocusItem(null);
  }, [dedupedCards, pendingFocusItem]);

  const selectedCard = useMemo(
    () => filteredCards.find((item) => item.id === selectedCardId) ?? filteredCards[0] ?? null,
    [filteredCards, selectedCardId],
  );

  function jumpToImportPanel() {
    importPanelRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    window.setTimeout(() => {
      const input = document.getElementById("url-input");
      if (input instanceof HTMLInputElement) {
        input.focus();
      }
    }, 220);
  }

  const detailQuery = useQuery({
    queryKey: ["content", selectedCard?.id],
    queryFn: () => getContent(selectedCard!.id),
    enabled: Boolean(selectedCard && !selectedCard.isDemo),
    retry: 1,
  });

  const deleteMutation = useMutation({
    mutationFn: (contentId: string) => deleteContent(contentId),
    onSuccess: async (_, contentId) => {
      await queryClient.invalidateQueries({ queryKey: ["contents"] });
      await queryClient.invalidateQueries({ queryKey: ["trash"] });
      const card = cards.find((item) => item.id === contentId);
      setWorkspaceNotice({
        title: "已移入回收站",
        description: `《${card?.title || "这条内容"}》已移入回收站。`,
        linkTo: "/trash",
        linkLabel: "查看回收站",
        tone: "warning",
      });
    },
  });

  const collections = collectionsQuery.data?.items ?? [];
  const total = dedupedCards.length;
  const readyCount = dedupedCards.filter((item) => item.status === "ready" || item.status === "ready_estimated").length;
  const noteCount = dedupedCards.filter((item) => item.noteStyle).length;
  const pendingJobs = pendingJobsQuery.data?.items ?? [];
  const notePreview = getNotePreview(detailQuery.data);
  const quickQuestions = buildQuickQuestions(detailQuery.data);
  const visibleQuickQuestions = quickQuestions.slice(0, 2);
  const transcriptSegmentCount = getTranscriptSegmentCount(detailQuery.data);
  const qualityScore = getQualityScore(detailQuery.data);
  const detailMetadata = getMetadata(detailQuery.data);
  const captureSummary = typeof detailMetadata.capture_summary === "string" ? detailMetadata.capture_summary : "";
  const previewScreenshots = useMemo(() => parseNoteScreenshots(detailMetadata), [detailMetadata]);
  const previewStageSeeds = useMemo(() => {
    if (detailQuery.data?.key_points.length) {
      return buildStageDigestSeeds(detailQuery.data.key_points, {
        idPrefix: `${detailQuery.data?.id ?? "preview"}-point`,
        eyebrowPrefix: "重点",
        titlePrefix: "阶段",
        limit: 4,
      });
    }

    return buildStageDigestSeeds(splitStageDigestText(notePreview, 4), {
      idPrefix: `${detailQuery.data?.id ?? "preview"}-summary`,
      eyebrowPrefix: "摘要",
      titlePrefix: "阶段",
      limit: 4,
    });
  }, [detailQuery.data?.id, detailQuery.data?.key_points, notePreview]);
  const previewStageDigestItems = useMemo(
    () => buildStageDigestCards(previewStageSeeds, previewScreenshots, { limit: 3 }),
    [previewScreenshots, previewStageSeeds],
  );

  function handleDelete(contentId: string, title: string) {
    if (!window.confirm(displayText(`确认将《${title}》移入回收站吗？`))) {
      return;
    }
    deleteMutation.mutate(contentId);
  }

  function handleImportCompleted(payload: PendingFocusItem) {
    setActiveFilter("all");
    if (searchTerm.trim()) {
      setSearchTerm("");
    }
    setPendingFocusItem(payload);
    setWorkspaceNotice({
      title: payload.status === "ready" || payload.status === "ready_estimated" ? "导入完成" : "材料已入库",
      description:
        payload.status === "ready" || payload.status === "ready_estimated"
          ? `《${payload.title}》已完成导入，右侧已更新当前笔记。`
          : `《${payload.title}》已完成基础建档，右侧会显示当前材料状态。`,
    });
  }

  return (
    <section className="page bili-note-page">
      <div className="bili-note-shell">
        <div className="bili-note-column bili-note-column-left">
          <article className="card glass-panel bili-note-hero-card">
            <div className="bili-note-hero-copy">
              <h2>{displayText("内容库")}</h2>
              <p className="muted-text">{displayText("导入与预览")}</p>
            </div>
            <div className="bili-note-stat-grid">
              <article className="bili-note-stat-card">
                <span>{displayText("知识条目")}</span>
                <strong>{total}</strong>
              </article>
              <article className="bili-note-stat-card">
                <span>{displayText("完整笔记")}</span>
                <strong>{readyCount}</strong>
              </article>
              <article className="bili-note-stat-card">
                <span>{displayText("可追问")}</span>
                <strong>{noteCount}</strong>
              </article>
            </div>
          </article>

          <div ref={importPanelRef}>
            <ImportPanel onImportCompleted={handleImportCompleted} />
          </div>

          <article className="card glass-panel bili-note-collection-card">
            <div className="bili-note-section-head">
              <div>
                <p className="eyebrow">{displayText("分组管理")}</p>
                <h3>{displayText("内容分组")}</h3>
              </div>
              <button
                type="button"
                className="secondary-button"
                onClick={() => setShowCollectionPanel((value) => !value)}
              >
                {displayText(showCollectionPanel ? "收起" : "新建分组")}
              </button>
            </div>

            {showCollectionPanel && (
              <div className="bili-note-collection-create">
                <input
                  className="search-input"
                  placeholder={displayText("输入分组名称")}
                  value={newCollectionName}
                  onChange={(event) => setNewCollectionName(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && newCollectionName.trim()) {
                      createCollectionMutation.mutate(newCollectionName.trim());
                    }
                  }}
                />
                <button
                  type="button"
                  className="primary-button"
                  disabled={!newCollectionName.trim() || createCollectionMutation.isPending}
                  onClick={() => createCollectionMutation.mutate(newCollectionName.trim())}
                >
                  {displayText(createCollectionMutation.isPending ? "创建中..." : "创建")}
                </button>
              </div>
            )}

            <div className="bili-note-collection-list">
              <button
                type="button"
                className={activeCollectionId === null ? "collection-item collection-item-active" : "collection-item"}
                onClick={() => setActiveCollectionId(null)}
              >
                <span className="collection-item-icon">●</span>
                <span className="collection-item-name">{displayText("全部内容")}</span>
              </button>
              {collections.map((collection: Collection) => (
                <div className="bili-note-collection-row" key={collection.id}>
                  <button
                    type="button"
                    className={activeCollectionId === collection.id ? "collection-item collection-item-active" : "collection-item"}
                    onClick={() => setActiveCollectionId(collection.id)}
                  >
                    <span className="collection-item-icon" style={{ color: collection.color }}>{collection.icon}</span>
                    <span className="collection-item-name">{collection.name}</span>
                  </button>
                  <button
                    type="button"
                    className="collection-item-delete collection-item-delete-visible"
                    title={displayText("删除分组")}
                    onClick={() => deleteCollectionMutation.mutate(collection.id)}
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>

            {selectedCard && !selectedCard.isDemo && collections.length > 0 && (
              <div className="bili-note-collection-assign">
                <p className="eyebrow">{displayText("当前卡片快捷归档")}</p>
                <div className="pill-row">
                  {collections.map((collection) => (
                    <button
                      key={collection.id}
                      type="button"
                      className="secondary-button"
                      onClick={() => assignCollectionMutation.mutate({ contentId: selectedCard.id, collectionId: collection.id })}
                    >
                      {displayText(collection.name)}
                    </button>
                  ))}
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={() => assignCollectionMutation.mutate({ contentId: selectedCard.id, collectionId: null })}
                  >
                    {displayText("移出分组")}
                  </button>
                </div>
              </div>
            )}
          </article>
        </div>

        <div className="bili-note-column bili-note-column-center">
          <article className="card glass-panel bili-note-history-card">
            <div className="bili-note-section-head">
              <div>
                <p className="eyebrow">{displayText("知识库")}</p>
                <h3>{displayText("笔记列表")}</h3>
              </div>
              <div className="header-actions">
                <div className="pill-row">
                  <span className="pill">{displayText(`${filteredCards.length} 条当前结果`)}</span>
                  {pendingCount > 0 && <span className="pill pill-warning">{displayText(`${pendingCount} 条处理中`)}</span>}
                </div>
                {selectedCard && !selectedCard.isDemo && (
                  <Link className="secondary-button button-link" to={`/library/${selectedCard.id}`}>
                    {displayText("打开详情")}
                  </Link>
                )}
              </div>
            </div>

            <div className="bili-note-search-wrap">
              <input
                ref={searchRef}
                className="search-input"
                placeholder={displayText("按标题、摘要或正文搜索")}
                value={searchTerm}
                onChange={(event) => setSearchTerm(event.target.value)}
                onFocus={() => setShowSearchHistory(true)}
                onBlur={() => window.setTimeout(() => setShowSearchHistory(false), 120)}
              />
              {showSearchHistory && searchHistory.length > 0 && !searchTerm.trim() && (
                <div className="bili-note-search-history">
                  {searchHistory.map((item) => (
                    <button
                      key={item}
                      type="button"
                      className="bili-note-search-history-item"
                      onMouseDown={() => {
                        setSearchTerm(item);
                        setShowSearchHistory(false);
                      }}
                    >
                      {item}
                    </button>
                  ))}
                  <button
                    type="button"
                    className="bili-note-search-history-clear"
                    onMouseDown={() => { clearSearchHistory(); setSearchHistory([]); setShowSearchHistory(false); }}
                  >
                    {displayText("清除历史")}
                  </button>
                </div>
              )}
            </div>

            <div className="segment-rail library-filter-rail">
              {filterItems.map((item) => (
                <button
                  key={item.key}
                  type="button"
                  className={activeFilter === item.key ? "segment-pill segment-pill-active" : "segment-pill"}
                  onClick={() => setActiveFilter(item.key)}
                >
                  {displayText(item.label)}
                </button>
              ))}
            </div>

            {pendingJobs.length > 0 && (
              <div className="bili-note-pending-list">
                {pendingJobs.slice(0, 3).map((job) => (
                  <article className="bili-note-pending-item" key={job.id}>
                    <div>
                      <strong>{displayText(job.preview.title || "未命名任务")}</strong>
                      <p className="muted-text">{displayText(getImportStepShortLabel(job.step))}</p>
                    </div>
                    <span className="pill">{displayText(`${Math.max(job.progress ?? 0, 5)}%`)}</span>
                  </article>
                ))}
              </div>
            )}

            {workspaceNotice && (
              <div
                className={
                  workspaceNotice.tone === "warning"
                    ? "bili-note-status-strip bili-note-status-strip-warning"
                    : "bili-note-status-strip"
                }
              >
                <div>
                  <strong>{displayText(workspaceNotice.title)}</strong>
                  <p className="muted-text">{displayText(workspaceNotice.description)}</p>
                </div>
                {workspaceNotice.linkTo && workspaceNotice.linkLabel && (
                  <Link to={workspaceNotice.linkTo} className="link-inline bili-note-status-strip-link">
                    {displayText(workspaceNotice.linkLabel)}
                  </Link>
                )}
              </div>
            )}

            {contentsQuery.isLoading && <p className="muted-text">{displayText("正在加载知识库内容...")}</p>}
            {contentsQuery.isError && (
              <p className="muted-text">{displayText("本地服务未连接，当前显示示例卡片。")}</p>
            )}

            {!filteredCards.length ? (
              <div className="knowledge-empty-list">
                {debouncedSearch ? (
                  <>
                    <strong>{displayText(`没有找到包含“${debouncedSearch}”的内容`)}</strong>
                    <p className="muted-text">{displayText("换一个关键词，或清空搜索后查看全部内容。")}</p>
                  </>
                ) : (
                  <>
                    <strong>{displayText("内容列表还是空的")}</strong>
                    <p className="muted-text">{displayText("导入一条视频或文档后，这里会自动出现新的内容卡片。")}</p>
                    <button
                      className="primary-button"
                      type="button"
                      style={{ marginTop: "var(--space-3)" }}
                      onClick={jumpToImportPanel}
                    >
                      {displayText("去导入内容")}
                    </button>
                  </>
                )}
              </div>
            ) : (
              <div className="bili-note-history-list">
                {filteredCards.map((item) => {
                  const selected = selectedCard?.id === item.id;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      className={selected ? "bili-note-history-item bili-note-history-item-active" : "bili-note-history-item"}
                      title={displayText(selected && !item.isDemo ? "再次点击可打开详情" : "点击切换到右侧预览")}
                      onClick={() => {
                        if (selected && !item.isDemo) {
                          navigate(`/library/${item.id}`);
                          return;
                        }
                        setSelectedCardId(item.id);
                      }}
                    >
                      <div className="bili-note-history-item-head">
                        <div className="pill-row">
                          <span className="pill">{displayText(item.source)}</span>
                          <span className={getStatusPillClass(item.status)}>
                            {displayText(getStatusLabel(item.status, item.parseMode, item.noteStyle))}
                          </span>
                        </div>
                        {item.noteStyle && (
                          <span className="pill">{displayText(getNoteStyleLabel(item.noteStyle))}</span>
                        )}
                      </div>
                      <strong className="knowledge-list-item-title">
                        {debouncedSearch ? highlightKeyword(item.title, debouncedSearch, displayText) : displayText(item.title)}
                      </strong>
                      <p className="knowledge-list-item-summary">
                        {debouncedSearch ? highlightKeyword(item.summary || "", debouncedSearch, displayText) : displayText(item.summary)}
                      </p>
                      <div className="tag-row-soft bili-note-history-item-tags">
                        {(item.tags.length ? item.tags : ["暂无标签"]).slice(0, 3).map((tag) => (
                          <span className="pill" key={`${item.id}-${tag}`}>
                            {displayText(tag)}
                          </span>
                        ))}
                      </div>
                      <div className="bili-note-history-item-foot">
                        <span className="muted-text">{displayText(item.updatedAt ? formatDateTime(item.updatedAt) : "示例内容")}</span>
                        <span className="bili-note-history-item-cta">
                          {displayText(selected && !item.isDemo ? "再次点击打开详情" : "点击预览")}
                        </span>
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </article>
        </div>

        <div className="bili-note-column bili-note-column-right">
          <article className="card glass-panel bili-note-preview-card">
            {selectedCard ? (
              selectedCard.isDemo ? (
                <div className="bili-note-preview-empty">
                  <p className="eyebrow">{displayText("当前预览")}</p>
                  <h3>{displayText(selectedCard.title)}</h3>
                  <p className="muted-text">{displayText(selectedCard.summary)}</p>
                  <div className="pill-row">
                    <span className="pill">{displayText(selectedCard.source)}</span>
                    <span className="pill">{displayText(getNoteStyleLabel(selectedCard.noteStyle))}</span>
                  </div>
                  <div className="bili-note-reader">
                    <p>{displayText("接入真实内容后，这里会切到当前笔记。")}</p>
                  </div>
                </div>
              ) : detailQuery.isLoading ? (
                <div className="bili-note-preview-empty">
                  <p className="eyebrow">{displayText("当前预览")}</p>
                  <h3>{displayText("正在加载")}</h3>
                </div>
              ) : detailQuery.isError || !detailQuery.data ? (
                <div className="bili-note-preview-empty">
                  <p className="eyebrow">{displayText("当前预览")}</p>
                  <h3>{displayText(selectedCard.title)}</h3>
                  <p className="muted-text">{displayText("暂时没拿到详情数据。")}</p>
                  <div className="header-actions">
                    <Link className="primary-button button-link" to={`/library/${selectedCard.id}`}>
                      {displayText("打开详情")}
                    </Link>
                  </div>
                </div>
              ) : (
                <>
                  <div className="bili-note-preview-head">
                    <div>
                      <p className="eyebrow">{displayText("当前笔记")}</p>
                      <h3>{displayText(detailQuery.data.title)}</h3>
                      {(captureSummary || detailQuery.data.summary) ? (
                        <p className="muted-text">{displayText(captureSummary || detailQuery.data.summary)}</p>
                      ) : null}
                    </div>
                    <div className="pill-row">
                      <span className={getStatusPillClass(detailQuery.data.status)}>
                        {displayText(getStatusLabel(detailQuery.data.status, selectedCard.parseMode, selectedCard.noteStyle))}
                      </span>
                      <span className="pill">{displayText(detailQuery.data.platform ?? detailQuery.data.source_type ?? "未知来源")}</span>
                      <span className="pill">{displayText(getNoteStyleLabel(selectedCard.noteStyle))}</span>
                    </div>
                  </div>

                  <div className="bili-note-metric-strip">
                    <article className="bili-note-metric-card">
                      <span>{displayText("来源")}</span>
                      <strong>{displayText(getSourceDescription(selectedCard.source))}</strong>
                    </article>
                    <article className="bili-note-metric-card">
                      <span>{displayText("片段")}</span>
                      <strong>
                        {displayText(
                          transcriptSegmentCount > 0
                            ? `${transcriptSegmentCount} 证据 / ${detailQuery.data.chunks.length} 检索`
                            : `${detailQuery.data.chunks.length} 检索`,
                        )}
                      </strong>
                    </article>
                    <article className="bili-note-metric-card">
                      <span>{displayText("质量")}</span>
                      <strong>{displayText(qualityScore !== null ? String(qualityScore) : "待评估")}</strong>
                    </article>
                  </div>

                  {!!previewStageDigestItems.length ? (
                    <StageDigest
                      eyebrow="阶段"
                      title="重点"
                      items={previewStageDigestItems}
                      compact
                      className="library-stage-digest"
                    />
                  ) : (
                    <article className="bili-note-preview-block">
                      <p className="eyebrow">{displayText("正文预览")}</p>
                      <div className="bili-note-reader">
                        {notePreview ? (
                          notePreview.split(/(?<=。|！|？|\.)\s+/).slice(0, 6).map((paragraph, index) => (
                            <p key={`${detailQuery.data.id}-paragraph-${index}`}>{displayText(paragraph)}</p>
                          ))
                        ) : (
                          <p>{displayText("这条内容还没有稳定的笔记正文，可打开详情页继续查看。")}</p>
                        )}
                      </div>
                    </article>
                  )}

                  <article className="bili-note-preview-block bili-note-preview-block-compact">
                    <div className="bili-note-preview-block-head">
                      <div>
                        <p className="eyebrow">{displayText("快捷入口")}</p>
                      </div>
                    </div>
                    {!!visibleQuickQuestions.length && (
                      <div className="pill-row chip-grid">
                        {visibleQuickQuestions.map((question) => (
                          <Link
                            key={question}
                            className="secondary-button button-link suggestion-chip"
                            to={`/chat?q=${encodeURIComponent(question)}&contentId=${detailQuery.data.id}&title=${encodeURIComponent(detailQuery.data.title)}`}
                          >
                            {displayText(question)}
                          </Link>
                        ))}
                      </div>
                    )}
                    <div className="pill-row bili-note-preview-meta-pills">
                      <span className="pill">{displayText(`作者 ${detailQuery.data.author || "未知"}`)}</span>
                      <span className="pill">{displayText(`更新 ${formatDateTime(detailQuery.data.updated_at)}`)}</span>
                      <span className="pill">{displayText(`检索 ${detailQuery.data.chunks.length}`)}</span>
                    </div>
                    <div className="tag-row-soft bili-note-preview-tag-row">
                      {(detailQuery.data.tags.length ? detailQuery.data.tags : ["暂无标签"]).slice(0, 4).map((tag) => (
                        <span className="pill" key={`${detailQuery.data.id}-tag-${tag}`}>
                          {displayText(tag)}
                        </span>
                      ))}
                    </div>
                  </article>

                  <div className="header-actions bili-note-preview-actions">
                    <Link className="primary-button button-link" to={`/library/${detailQuery.data.id}`}>
                      {displayText("打开详情")}
                    </Link>
                    <Link
                      className="secondary-button button-link"
                      to={`/chat?q=${encodeURIComponent(detailQuery.data.title)}&contentId=${detailQuery.data.id}&title=${encodeURIComponent(detailQuery.data.title)}`}
                    >
                      {displayText("提问")}
                    </Link>
                    <button
                      className="danger-button"
                      type="button"
                      disabled={deleteMutation.isPending && deleteMutation.variables === detailQuery.data.id}
                      onClick={() => handleDelete(detailQuery.data.id, detailQuery.data.title)}
                    >
                      {displayText(deleteMutation.isPending && deleteMutation.variables === detailQuery.data.id ? "删除中..." : "删除")}
                    </button>
                  </div>
                </>
              )
            ) : (
              <div className="bili-note-preview-empty">
                <strong>{displayText("导入内容后，这里会显示当前笔记")}</strong>
              </div>
            )}
          </article>

          <details className="card glass-panel maintenance-details bili-note-maintenance-card">
            <summary>{displayText("旧内容")}</summary>
            <div className="header-actions">
              <button
                className="secondary-button"
                type="button"
                disabled={upgradeMutation.isPending}
                onClick={() => upgradeMutation.mutate()}
              >
                {displayText(upgradeMutation.isPending ? "处理中..." : "补跑旧内容")}
              </button>
            </div>

            {(maintenanceMessage || upgradeMutation.data) && (
              <div className="signal-card">
                <div className="signal-list">
                  <div className="signal-item">
                    <strong>{displayText(upgradeMutation.data?.message || "处理结果")}</strong>
                    <span className={upgradeMutation.isError ? "error-text" : "muted-text"}>
                      {displayText(maintenanceMessage || "本轮处理已完成。")}
                    </span>
                  </div>
                </div>

                {upgradeMutation.data && (
                  <div className="pill-row">
                    <span className="pill">{displayText(`已处理 ${upgradeMutation.data.summary.upgraded} 条`)}</span>
                    <span className="pill">{displayText(`本地修复 ${upgradeMutation.data.summary.repaired}`)}</span>
                    <span className="pill">{displayText(`重新抓取 ${upgradeMutation.data.summary.reimported}`)}</span>
                    {upgradeMutation.data.summary.fallback_repaired > 0 && (
                      <span className="pill">{displayText(`回退修复 ${upgradeMutation.data.summary.fallback_repaired}`)}</span>
                    )}
                    {upgradeMutation.data.summary.failed > 0 && (
                      <span className="pill">{displayText(`失败 ${upgradeMutation.data.summary.failed}`)}</span>
                    )}
                  </div>
                )}
              </div>
            )}
          </details>
        </div>
      </div>
    </section>
  );
}
