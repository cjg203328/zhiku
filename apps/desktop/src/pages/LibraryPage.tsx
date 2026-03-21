import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import ImportPanel from "../components/ImportPanel";
import {
  assignContentCollection,
  createCollection,
  deleteCollection,
  deleteContent,
  getContents,
  listCollections,
  listImportJobs,
  upgradeContents,
  type Collection,
} from "../lib/api";
import { useLanguage } from "../lib/language";

const SEARCH_HISTORY_KEY = "zhiku_search_history";
const SEARCH_HISTORY_MAX = 5;

function loadSearchHistory(): string[] {
  try {
    const raw = localStorage.getItem(SEARCH_HISTORY_KEY);
    return raw ? (JSON.parse(raw) as string[]) : [];
  } catch { return []; }
}

function saveSearchHistory(term: string) {
  const prev = loadSearchHistory().filter((t) => t !== term);
  const next = [term, ...prev].slice(0, SEARCH_HISTORY_MAX);
  try { localStorage.setItem(SEARCH_HISTORY_KEY, JSON.stringify(next)); } catch {}
}

type FilterKey = "all" | "video" | "article" | "note";

type LibraryCardItem = {
  id: string;
  title: string;
  source: string;
  summary: string;
  tags: string[];
  coverUrl: string | null;
  parseMode: string | null;
  noteStyle: string | null;
  status: string | null;
  isDemo: boolean;
};

type PendingFocusItem = {
  contentId: string;
  title: string;
  status: string;
  suggestedQuestions: string[];
};

function getNoteStyleLabel(value: string | null) {
  if (value === "qa") return "问答笔记";
  if (value === "brief") return "快速速记";
  if (value === "structured") return "结构化笔记";
  return null;
}

function getSourceDescription(source: string) {
  if (source.toLowerCase().includes("bilibili")) return "公开视频";
  if (source.toLowerCase().includes("doc")) return "结构化文档";
  if (source.toLowerCase().includes("assistant")) return "对话沉淀";
  return "知识来源";
}

function getStatusLabel(status: string | null | undefined, parseMode: string | null, noteStyle: string | null) {
  if (status === "ready") return "可直接验证";
  if (status === "ready_estimated") return "正文已恢复";
  if (status === "needs_cookie") return "需登录态补全";
  if (status === "needs_asr") return "需转写补全";
  if (status === "asr_failed") return "转写待修复";
  if (status === "limited") return "仅基础建档";
  if (parseMode === "api") return "解析较完整";
  if (noteStyle) return "已生成笔记";
  return "待继续验证";
}

function getStatusPillClass(status: string | null | undefined) {
  if (status === "ready" || status === "ready_estimated") return "pill pill-success";
  if (status === "needs_cookie" || status === "needs_asr" || status === "asr_failed") return "pill pill-warning";
  if (status === "import_pending") return "pill pill-muted";
  return "pill subtle-pill";
}

const mockCards: LibraryCardItem[] = [
  {
    id: "demo-bilibili-001",
    title: "AI 时代的学习方法",
    source: "Bilibili",
    summary: "强调收集、整理、输出的闭环，让知识真正可以被复用。",
    tags: ["学习", "AI", "知识管理"],
    coverUrl: null,
    parseMode: null,
    noteStyle: null,
    status: null,
    isDemo: true,
  },
  {
    id: "demo-docx-001",
    title: "产品访谈纪要",
    source: "DOCX",
    summary: "6 位用户描述了知识工具最值得优先解决的核心痛点。",
    tags: ["调研", "访谈", "产品"],
    coverUrl: null,
    parseMode: null,
    noteStyle: null,
    status: null,
    isDemo: true,
  },
];

const filterItems: { key: FilterKey; label: string; hint: string }[] = [
  { key: "all", label: "全部内容", hint: "总览" },
  { key: "video", label: "视频内容", hint: "B 站优先" },
  { key: "article", label: "网页文章", hint: "正文抽取" },
  { key: "note", label: "问答沉淀", hint: "知识卡片" },
];

export default function LibraryPage() {
  const { displayText } = useLanguage();
  const [searchTerm, setSearchTerm] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [searchHistory, setSearchHistory] = useState<string[]>(loadSearchHistory);
  const [showSearchHistory, setShowSearchHistory] = useState(false);
  const [activeFilter, setActiveFilter] = useState<FilterKey>("all");
  const [activeCollectionId, setActiveCollectionId] = useState<string | null>(null);
  const [showCollectionPanel, setShowCollectionPanel] = useState(false);
  const [newCollectionName, setNewCollectionName] = useState("");
  const [maintenanceMessage, setMaintenanceMessage] = useState("");
  const [selectedCardId, setSelectedCardId] = useState("");
  const [pendingFocusItem, setPendingFocusItem] = useState<PendingFocusItem | null>(null);
  const [recentImportGuide, setRecentImportGuide] = useState<PendingFocusItem | null>(null);
  const [workbenchMessage, setWorkbenchMessage] = useState("");
  const queryClient = useQueryClient();
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const id = setTimeout(() => {
      const trimmed = searchTerm.trim();
      setDebouncedSearch(trimmed);
      if (trimmed) {
        saveSearchHistory(trimmed);
        setSearchHistory(loadSearchHistory());
      }
    }, 300);
    return () => clearTimeout(id);
  }, [searchTerm]);

  const pendingJobsQuery = useQuery({
    queryKey: ["imports", "pending"],
    queryFn: () => listImportJobs("pending"),
    refetchInterval: (query) =>
      (query.state.data?.pending_count ?? 0) > 0 ? 2000 : false,
  });
  const pendingCount = pendingJobsQuery.data?.pending_count ?? 0;

  const contentsQuery = useQuery({
    queryKey: ["contents", debouncedSearch, activeCollectionId],
    queryFn: () => getContents(debouncedSearch, activeCollectionId),
    retry: 1,
    refetchInterval: pendingCount > 0 ? 2000 : false,
  });

  const collectionsQuery = useQuery({
    queryKey: ["collections"],
    queryFn: listCollections,
    retry: 1,
  });

  const createCollectionMutation = useMutation({
    mutationFn: (name: string) => createCollection({ name }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["collections"] });
      setNewCollectionName("");
    },
  });

  const deleteCollectionMutation = useMutation({
    mutationFn: (id: string) => deleteCollection(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["collections"] });
      setActiveCollectionId(null);
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
      setMaintenanceMessage(error instanceof Error ? error.message : "旧内容升级失败，请稍后重试。");
    },
  });

  const [deleteGuideTitle, setDeleteGuideTitle] = useState("");

  const deleteMutation = useMutation({
    mutationFn: (contentId: string) => deleteContent(contentId),
    onSuccess: async (_, contentId) => {
      await queryClient.invalidateQueries({ queryKey: ["contents"] });
      await queryClient.invalidateQueries({ queryKey: ["trash"] });
      // 显示撤销/回收站引导（5秒后自动清除）
      const card = cards.find((c) => c.id === contentId);
      setDeleteGuideTitle(card?.title || "内容");
      setTimeout(() => setDeleteGuideTitle(""), 6000);
    },
  });

  const cards = useMemo<LibraryCardItem[]>(() => {
    if (contentsQuery.data?.items?.length) {
      return contentsQuery.data.items.map((item) => ({
        id: item.id,
        title: item.title,
        source: item.platform ?? item.source_type ?? "未知来源",
        summary: item.summary || "当前还没有摘要。",
        tags: item.tags,
        coverUrl: item.cover_url ?? null,
        parseMode: item.parse_mode ?? null,
        noteStyle: item.note_style ?? null,
        status: item.status ?? null,
        isDemo: false,
      }));
    }

    if (contentsQuery.isSuccess) {
      return [];
    }

    return mockCards;
  }, [contentsQuery.data, contentsQuery.isSuccess]);

  const collections = collectionsQuery.data?.items ?? [];

  const filteredCards = useMemo(() => {
    let result = cards;
    if (activeFilter !== "all") {
      result = result.filter((item) => {
        const source = item.source.toLowerCase();
        if (activeFilter === "video") return source.includes("bilibili") || source.includes("video");
        if (activeFilter === "article") return source.includes("web") || source.includes("article") || source.includes("网页");
        return source.includes("assistant") || source.includes("note") || item.noteStyle !== null;
      });
    }
    return result;
  }, [activeFilter, cards]);

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

    const matchedCard = cards.find((item) => item.id === pendingFocusItem.contentId);
    if (!matchedCard) {
      return;
    }

    setSelectedCardId(matchedCard.id);
    setWorkbenchMessage(`已自动切换到新导入内容：《${pendingFocusItem.title}》`);
    setPendingFocusItem(null);
  }, [cards, pendingFocusItem]);

  const selectedCard = useMemo(
    () => filteredCards.find((item) => item.id === selectedCardId) ?? filteredCards[0] ?? null,
    [filteredCards, selectedCardId],
  );
  const total = contentsQuery.data?.total ?? 0;
  const trimmedSearch = debouncedSearch;
  const recentCards = cards.slice(0, 4);
  const parsedCount = cards.filter((item) => item.status === "ready" || item.status === "ready_estimated").length;
  const noteCount = cards.filter((item) => item.noteStyle).length;
  const readyLabel = selectedCard
    ? getStatusLabel(selectedCard.status, selectedCard.parseMode, selectedCard.noteStyle)
    : "等待内容";
  const noteStyleLabel = getNoteStyleLabel(selectedCard?.noteStyle ?? null);
  const showRecentImportGuide = Boolean(
    recentImportGuide &&
      selectedCard &&
      !selectedCard.isDemo &&
      selectedCard.id === recentImportGuide.contentId,
  );

  function handleDelete(contentId: string, title: string) {
    if (!window.confirm(displayText(`确认将《${title}》移入回收站吗？`))) return;
    deleteMutation.mutate(contentId);
  }

  function handleImportCompleted(payload: PendingFocusItem) {
    setActiveFilter("all");
    if (searchTerm.trim()) {
      setSearchTerm("");
    }
    setPendingFocusItem(payload);
    setRecentImportGuide(payload);
    setWorkbenchMessage(
      payload.status === "ready" || payload.status === "ready_estimated"
        ? `《${payload.title}》已经导入完成，正在为你切到这条内容。`
        : `《${payload.title}》已经完成基础建档，正在切到这条内容继续处理。`,
    );
  }

  return (
    <section className="page knowledge-workbench-page">
      <div className="knowledge-workbench">
        {/* Collection 侧边栏 */}
        <div className="knowledge-column knowledge-column-collections">
          <article className="card glass-panel knowledge-collections-card">
            <div className="knowledge-collections-head">
              <p className="eyebrow">{displayText("分组")}</p>
              <button
                type="button"
                className="icon-button"
                title={displayText("新建分组")}
                onClick={() => setShowCollectionPanel((v) => !v)}
              >+</button>
            </div>

            <button
              type="button"
              className={activeCollectionId === null ? "collection-item collection-item-active" : "collection-item"}
              onClick={() => setActiveCollectionId(null)}
            >
              <span className="collection-item-icon">◫</span>
              <span className="collection-item-name">{displayText("全部内容")}</span>
              <span className="collection-item-count">{cards.filter(c => !c.isDemo).length}</span>
            </button>

            {collections.map((col: Collection) => (
              <button
                key={col.id}
                type="button"
                className={activeCollectionId === col.id ? "collection-item collection-item-active" : "collection-item"}
                onClick={() => setActiveCollectionId(col.id)}
              >
                <span className="collection-item-icon" style={{ color: col.color }}>{col.icon}</span>
                <span className="collection-item-name">{col.name}</span>
                <button
                  type="button"
                  className="collection-item-delete"
                  title={displayText("删除分组")}
                  onClick={(e) => { e.stopPropagation(); deleteCollectionMutation.mutate(col.id); }}
                >×</button>
              </button>
            ))}

            {showCollectionPanel && (
              <div className="collection-create-panel">
                <input
                  className="search-input"
                  placeholder={displayText("分组名称")}
                  value={newCollectionName}
                  onChange={(e) => setNewCollectionName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && newCollectionName.trim()) {
                      createCollectionMutation.mutate(newCollectionName.trim());
                      setShowCollectionPanel(false);
                    }
                  }}
                />
                <button
                  type="button"
                  className="primary-button"
                  disabled={!newCollectionName.trim() || createCollectionMutation.isPending}
                  onClick={() => {
                    if (newCollectionName.trim()) {
                      createCollectionMutation.mutate(newCollectionName.trim());
                      setShowCollectionPanel(false);
                    }
                  }}
                >
                  {displayText("创建")}
                </button>
              </div>
            )}

            {selectedCard && !selectedCard.isDemo && collections.length > 0 && (
              <div className="collection-assign-panel">
                <p className="eyebrow">{displayText("移入分组")}</p>
                {collections.map((col: Collection) => (
                  <button
                    key={col.id}
                    type="button"
                    className="collection-assign-item"
                    onClick={() => assignCollectionMutation.mutate({ contentId: selectedCard.id, collectionId: col.id })}
                  >
                    <span style={{ color: col.color }}>{col.icon}</span> {col.name}
                  </button>
                ))}
                <button
                  type="button"
                  className="collection-assign-item"
                  onClick={() => assignCollectionMutation.mutate({ contentId: selectedCard.id, collectionId: null })}
                >
                  {displayText("移出分组")}
                </button>
              </div>
            )}
          </article>
        </div>
        <div className="knowledge-column knowledge-column-import">
          <article className="card glass-panel knowledge-overview-card">
            <div className="knowledge-overview-head">
              <div>
                <p className="eyebrow">{displayText("知识工作台")}</p>
                <h2>{displayText("导入 B 站视频，沉淀成可搜索、可提问的知识笔记")}</h2>
                <p className="muted-text">
                  {displayText("粘贴链接即可导入，自动提取字幕、生成摘要，支持全库智能问答。")}
                </p>
              </div>
              <div className="pill-row">
                <span className="pill">{displayText("B 站优先")}</span>
                <span className="pill">{displayText("导入即建档")}</span>
              </div>
            </div>

            <div className="knowledge-stat-grid">
              <article className="knowledge-stat-card">
                <span>{displayText("知识条目")}</span>
                <strong>{total}</strong>
              </article>
              <article className="knowledge-stat-card">
                <span>{displayText("解析较完整")}</span>
                <strong>{parsedCount}</strong>
              </article>
              <article className="knowledge-stat-card">
                <span>{displayText("已生成笔记")}</span>
                <strong>{noteCount}</strong>
              </article>
            </div>

            {!!recentCards.length && (
              <div className="knowledge-mini-list">
                {recentCards.map((item) => (
                  <button
                    className={selectedCard?.id === item.id ? "knowledge-mini-item knowledge-mini-item-active" : "knowledge-mini-item"}
                    key={item.id}
                    type="button"
                    onClick={() => setSelectedCardId(item.id)}
                  >
                    <strong>{displayText(item.title)}</strong>
                    <span className="muted-text">{displayText(getStatusLabel(item.status, item.parseMode, item.noteStyle))}</span>
                  </button>
                ))}
              </div>
            )}

            {workbenchMessage && (
              <div className="glass-callout">
                <strong>{displayText("刚刚更新")}</strong>
                <p className="muted-text">{displayText(workbenchMessage)}</p>
              </div>
            )}
            {deleteGuideTitle && (
              <div className="glass-callout delete-guide-callout">
                <p className="muted-text">
                  {displayText(`《${deleteGuideTitle}》已移入回收站。`)}
                  {" "}
                  <Link to="/trash" className="link-inline">{displayText("查看回收站")}</Link>
                </p>
              </div>
            )}
          </article>

          <ImportPanel onImportCompleted={handleImportCompleted} />
        </div>

        <div className="knowledge-column knowledge-column-list">
          <article className="card glass-panel knowledge-list-card">
            <div className="knowledge-list-toolbar">
              <div>
                <p className="eyebrow">{displayText("内容列表")}</p>
                <h3>{displayText("全部内容")}</h3>
              </div>
              <div className="pill-row">
                <span className="pill">{displayText(`${filteredCards.length} 条当前结果`)}</span>
                {pendingCount > 0 && (
                  <span className="pill pill-warning">{displayText(`${pendingCount} 条导入中`)}</span>
                )}
              </div>
            </div>

            <div style={{ position: "relative" }}>
              <input
                ref={searchRef}
                className="search-input"
                placeholder={displayText("按标题、摘要或正文搜索")}
                value={searchTerm}
                onChange={(event) => setSearchTerm(event.target.value)}
                onFocus={() => setShowSearchHistory(true)}
                onBlur={() => setTimeout(() => setShowSearchHistory(false), 150)}
              />
              {showSearchHistory && searchHistory.length > 0 && !searchTerm && (
                <div style={{
                  position: "absolute", top: "100%", left: 0, right: 0, zIndex: 20,
                  background: "var(--bg-elevated)", border: "1px solid var(--border)",
                  borderRadius: "var(--radius-md)", marginTop: 4, overflow: "hidden",
                }}>
                  {searchHistory.map((term) => (
                    <button
                      key={term}
                      type="button"
                      style={{
                        display: "block", width: "100%", textAlign: "left",
                        padding: "8px 12px", background: "none", border: "none",
                        color: "var(--text-secondary)", cursor: "pointer", fontSize: "0.875rem",
                      }}
                      onMouseDown={() => { setSearchTerm(term); setShowSearchHistory(false); }}
                    >
                      {term}
                    </button>
                  ))}
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
                  <small className="library-filter-hint">{displayText(item.hint)}</small>
                </button>
              ))}
            </div>

            <p className="muted-text search-panel-copy">
              {contentsQuery.isSuccess
                ? displayText(
                    `当前共 ${total} 条内容，当前视图 ${filteredCards.length} 条${
                      trimmedSearch ? `，搜索词：${trimmedSearch}` : "，可直接切到你现在要处理的那条"
                    }`,
                  )
                : displayText("本地服务未连接时，会先展示示例内容，方便继续看页面结构。")}
            </p>

            {pendingFocusItem && (
              <div className="glass-callout">
                <strong>{displayText("正在切到最新导入")}</strong>
                <p className="muted-text">{displayText(`正在等待《${pendingFocusItem.title}》进入当前列表。`)}</p>
              </div>
            )}

            {contentsQuery.isLoading && <p className="muted-text">{displayText("正在加载知识库内容...")}</p>}
            {contentsQuery.isError && <p className="muted-text">{displayText("本地服务未连接，当前只展示示例卡片。")}</p>}

            {!filteredCards.length ? (
              <div className="knowledge-empty-list">
                {trimmedSearch ? (
                  <>
                    <strong>{displayText(`没找到包含「${trimmedSearch}」的内容`)}</strong>
                    <p className="muted-text">{displayText("试试换个关键词，或清空搜索看全部内容。")}</p>
                  </>
                ) : (
                  <>
                    <strong>{displayText("知识库还没有内容")}</strong>
                    <p className="muted-text">{displayText("先导入一条 B 站链接，内容会自动整理到这里。")}</p>
                  </>
                )}
              </div>
            ) : (
              <div className="knowledge-list">
                {filteredCards.map((item) => {
                  const selected = selectedCard?.id === item.id;
                  const itemNoteStyle = getNoteStyleLabel(item.noteStyle);
                  return (
                    <button
                      className={selected ? "knowledge-list-item knowledge-list-item-active" : "knowledge-list-item"}
                      key={item.id}
                      type="button"
                      onClick={() => setSelectedCardId(item.id)}
                    >
                      <div className="knowledge-list-item-head">
                        <div className="pill-row">
                          <span className="pill">{displayText(item.source)}</span>
                          <span className={getStatusPillClass(item.status)}>{displayText(getStatusLabel(item.status, item.parseMode, item.noteStyle))}</span>
                        </div>
                        {itemNoteStyle && <span className="pill">{displayText(itemNoteStyle)}</span>}
                      </div>
                      <strong className="knowledge-list-item-title">{displayText(item.title)}</strong>
                      <p className="knowledge-list-item-summary">{displayText(item.summary)}</p>
                      <div className="tag-row-soft">
                        {(item.tags.length ? item.tags : ["暂无标签"]).slice(0, 3).map((tag) => (
                          <span className="pill" key={`${item.id}-${tag}`}>
                            {displayText(tag)}
                          </span>
                        ))}
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </article>
        </div>

        <div className="knowledge-column knowledge-column-preview">
          <article className="card glass-panel knowledge-preview-card">
            {selectedCard ? (
              <>
                <div className="knowledge-preview-head">
                  <div>
                    <p className="eyebrow">{displayText("当前预览")}</p>
                    <h3>{displayText(selectedCard.title)}</h3>
                  </div>
                  <div className="pill-row">
                    {workbenchMessage && selectedCard.id === selectedCardId && <span className="pill">{displayText("当前焦点")}</span>}
                    <span className="pill">{displayText(readyLabel)}</span>
                    {selectedCard.parseMode && (
                      <span className="pill">{displayText(selectedCard.parseMode === "api" ? "官方信息" : "页面补充")}</span>
                    )}
                  </div>
                </div>

                {selectedCard.coverUrl ? (
                  <img className="cover-image knowledge-preview-cover" src={selectedCard.coverUrl} alt={selectedCard.title} />
                ) : (
                  <div className="knowledge-preview-placeholder">
                    <span>{displayText(getSourceDescription(selectedCard.source))}</span>
                  </div>
                )}

                <article className="knowledge-preview-block">
                  <span className="pill">{displayText(selectedCard.source)}</span>
                  <p>{displayText(selectedCard.summary)}</p>
                </article>

                <div className="knowledge-preview-meta">
                  <article className="knowledge-preview-metric">
                    <span>{displayText("来源定位")}</span>
                    <strong>{displayText(getSourceDescription(selectedCard.source))}</strong>
                  </article>
                  <article className="knowledge-preview-metric">
                    <span>{displayText("笔记形态")}</span>
                    <strong>{displayText(noteStyleLabel || "原始建档")}</strong>
                  </article>
                </div>

                {showRecentImportGuide && recentImportGuide && (
                  <article className="knowledge-preview-block">
                    <p className="eyebrow">{displayText("建议先这样验证")}</p>
                    <strong>{displayText("这条内容已经切到当前焦点，先跑一轮首问会更顺。")}</strong>
                    <p>{displayText(
                      recentImportGuide.status === "ready" || recentImportGuide.status === "ready_estimated"
                        ? "先用一条总结类问题验证回答质量，再看引用跳转和详情页回看是不是顺手。"
                        : "这条内容还在补强阶段，先问材料线索和可核对问题，比直接追求最终结论更稳。",
                    )}</p>
                    <div className="header-actions knowledge-preview-actions">
                      {recentImportGuide.suggestedQuestions.slice(0, 2).map((item) => (
                        <Link
                          className="secondary-button button-link"
                          key={item}
                          to={`/chat?q=${encodeURIComponent(item)}&contentId=${recentImportGuide.contentId}&title=${encodeURIComponent(recentImportGuide.title)}`}
                        >
                          {displayText(item)}
                        </Link>
                      ))}
                      <button className="secondary-button" type="button" onClick={() => setRecentImportGuide(null)}>
                        {displayText("稍后再看")}
                      </button>
                    </div>
                  </article>
                )}

                <div className="knowledge-preview-block">
                  <p className="eyebrow">{displayText("标签")}</p>
                  <div className="tag-row-soft">
                    {(selectedCard.tags.length ? selectedCard.tags : ["暂无标签"]).map((tag) => (
                      <span className="pill" key={`${selectedCard.id}-preview-${tag}`}>
                        {displayText(tag)}
                      </span>
                    ))}
                  </div>
                </div>

                <div className="header-actions knowledge-preview-actions">
                  {!selectedCard.isDemo ? (
                    <>
                      <Link className="primary-button button-link" to={`/library/${selectedCard.id}`}>
                        {displayText("打开知识详情")}
                      </Link>
                      <Link className="secondary-button button-link" to={`/chat?q=${encodeURIComponent(selectedCard.title)}&contentId=${selectedCard.id}&title=${encodeURIComponent(selectedCard.title)}`}>
                        {displayText("围绕它提问")}
                      </Link>
                      <button
                        className="danger-button"
                        type="button"
                        disabled={deleteMutation.isPending && deleteMutation.variables === selectedCard.id}
                        onClick={() => handleDelete(selectedCard.id, selectedCard.title)}
                      >
                        {deleteMutation.isPending && deleteMutation.variables === selectedCard.id
                          ? displayText("删除中...")
                          : displayText("删除")}
                      </button>
                    </>
                  ) : (
                    <span className="pill">{displayText("示例内容，仅用于预览布局")}</span>
                  )}
                </div>
              </>
            ) : (
              <div className="knowledge-preview-empty">
                <strong>{displayText("导入后，这里会显示当前知识卡片")}</strong>
                <p className="muted-text">{displayText("你可以像看工作台一样，在左边导入，中间选条目，右边直接预览和继续操作。")}</p>
              </div>
            )}
          </article>

          <details className="card glass-panel maintenance-details knowledge-maintenance-card">
            <summary>{displayText("旧内容维护")}</summary>
            <p className="muted-text search-panel-copy">
              {displayText("只在需要时使用。它会补齐质量标记、时间跳转，并重试仍未完整转化的条目。")}
            </p>
            <div className="header-actions">
              <button
                className="secondary-button"
                type="button"
                disabled={upgradeMutation.isPending}
                onClick={() => upgradeMutation.mutate()}
              >
                {upgradeMutation.isPending ? displayText("升级中...") : displayText("升级旧内容")}
              </button>
            </div>

            {(maintenanceMessage || upgradeMutation.data) && (
              <div className="signal-card">
                <div className="signal-list">
                  <div className="signal-item">
                    <strong>{displayText(upgradeMutation.data?.message || "旧内容升级反馈")}</strong>
                    <span className={upgradeMutation.isError ? "error-text" : "muted-text"}>
                      {displayText(maintenanceMessage || "这次升级已经完成。")}
                    </span>
                  </div>
                </div>

                {upgradeMutation.data && (
                  <div className="pill-row">
                    <span className="pill">{displayText(`已处理 ${upgradeMutation.data.summary.upgraded} 条`)}</span>
                    <span className="pill">{displayText(`本地修复 ${upgradeMutation.data.summary.repaired}`)}</span>
                    <span className="pill">{displayText(`重新抓取 ${upgradeMutation.data.summary.reimported}`)}</span>
                    {upgradeMutation.data.summary.fallback_repaired > 0 && (
                      <span className="pill">{displayText(`失败回退修复 ${upgradeMutation.data.summary.fallback_repaired}`)}</span>
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
