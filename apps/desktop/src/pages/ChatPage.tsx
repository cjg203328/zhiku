import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { formatMilliseconds, formatTimeRange } from "../lib/utils";
import {
  deleteChatSession,
  fetchModelCatalog,
  getChatSession,
  getSettings,
  listChatSessions,
  saveChatNote,
  saveChatTurn,
  streamChat,
  type ChatCitation,
  type ChatResponse,
  type ChatSessionMessage,
} from "../lib/api";
import { useLanguage } from "../lib/language";

const CHAT_MODEL_OVERRIDE_STORAGE_KEY = "zhiku:chat:model-override:v1";
const CHAT_WEB_SEARCH_STORAGE_KEY = "zhiku:chat:web-search:v1";

const GLOBAL_SUGGESTED_QUESTIONS = [
  "最近有哪些值得深挖的内容？",
  "帮我找学习方法相关的片段",
  "今天最值得回看的内容是什么？",
];

const SCOPED_SUGGESTED_QUESTIONS = [
  "这条内容的核心结论是什么？",
  "这里有哪些可直接拿来用的方法？",
  "最值得回看的片段是哪几段？",
];

function readStoredChatModelOverride() {
  if (typeof window === "undefined") return "";
  return window.localStorage.getItem(CHAT_MODEL_OVERRIDE_STORAGE_KEY)?.trim() || "";
}

function readStoredChatWebSearchEnabled() {
  if (typeof window === "undefined") return false;
  return window.localStorage.getItem(CHAT_WEB_SEARCH_STORAGE_KEY) === "1";
}

function isExternalCitation(citation: ChatCitation) {
  const contentId = citation.content_id?.trim();
  return !contentId || contentId.startsWith("web:");
}

function formatChunkLabel(citation: ChatCitation) {
  if (isExternalCitation(citation)) {
    return citation.platform?.trim() === "web" ? "联网来源" : citation.heading?.trim() || "外部来源";
  }
  const timestampLabel = formatTimeRange(citation.start_ms, citation.end_ms);
  if (typeof citation.chunk_index !== "number") {
    return citation.heading?.trim() || timestampLabel;
  }
  const indexLabel = timestampLabel || `片段 ${citation.chunk_index + 1}`;
  const heading = citation.heading?.trim();
  return heading ? `${indexLabel} · ${heading}` : indexLabel;
}



function buildSeekUrl(citation: ChatCitation) {
  if (citation.seek_url?.trim()) {
    return citation.seek_url;
  }
  if (!citation.source_url?.trim()) {
    return null;
  }
  try {
    const url = new URL(citation.source_url);
    if (typeof citation.start_ms === "number" && citation.start_ms >= 0) {
      url.searchParams.set("t", String(Math.floor(citation.start_ms / 1000)));
    }
    return url.toString();
  } catch {
    return citation.source_url;
  }
}

function formatMessageTime(value?: string) {
  if (!value) {
    return "";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toLocaleString();
}

function buildChatLink(options: {
  q?: string;
  sessionId?: string;
  contentId?: string;
  chunkId?: string;
  title?: string;
  chunkLabel?: string;
}) {
  const search = new URLSearchParams();
  if (options.q?.trim()) search.set("q", options.q.trim());
  if (options.sessionId?.trim()) search.set("sessionId", options.sessionId.trim());
  if (options.contentId?.trim()) search.set("contentId", options.contentId.trim());
  if (options.chunkId?.trim()) search.set("chunkId", options.chunkId.trim());
  if (options.title?.trim()) search.set("title", options.title.trim());
  if (options.chunkLabel?.trim()) search.set("chunkLabel", options.chunkLabel.trim());
  const query = search.toString();
  return query ? `/chat?${query}` : "/chat";
}

function buildCitationDetailLink(citation: ChatCitation) {
  if (isExternalCitation(citation)) {
    return null;
  }
  const search = new URLSearchParams();
  const normalizedChunkId = citation.chunk_id?.trim();
  if (normalizedChunkId) search.set("chunkId", normalizedChunkId);
  if (typeof citation.chunk_index === "number") search.set("chunkIndex", String(citation.chunk_index));
  if (typeof citation.start_ms === "number") search.set("startMs", String(citation.start_ms));
  if (typeof citation.end_ms === "number") search.set("endMs", String(citation.end_ms));

  if (normalizedChunkId || typeof citation.start_ms === "number" || typeof citation.end_ms === "number") {
    search.set("view", "transcript");
  }

  const query = search.toString();
  return query ? `/library/${citation.content_id}?${query}` : `/library/${citation.content_id}`;
}

type QualityMeta = NonNullable<ChatResponse["quality"]>;
type RetrievalMeta = NonNullable<ChatResponse["retrieval"]>;
type RetrievalRoutes = NonNullable<RetrievalMeta["routes"]>;

type AnswerBlock =
  | { kind: "heading"; text: string }
  | { kind: "paragraph"; text: string }
  | { kind: "list"; items: string[] };

function isAnswerHeading(line: string) {
  const normalized = line.trim().replace(/^#{1,6}\s*/, "").replace(/[：:]$/, "");
  return [
    "结论",
    "当前判断",
    "优先可参考的内容",
    "优先可参考的结论",
    "当前最接近的线索",
    "目前只能参考的临时线索",
    "建议下一步",
    "为了拿到更稳的回答，建议下一步",
    "为了把它变成可检索、可回溯、可问答的笔记，建议下一步",
    "通用回答",
    "如果你想让后续回答更贴近你的资料",
  ].includes(normalized);
}

function parseAnswerBlocks(text: string): AnswerBlock[] {
  const lines = text.replace(/\r/g, "").split("\n");
  const blocks: AnswerBlock[] = [];
  let paragraphBuffer: string[] = [];
  let listBuffer: string[] = [];

  function flushParagraph() {
    if (!paragraphBuffer.length) return;
    blocks.push({ kind: "paragraph", text: paragraphBuffer.join(" ") });
    paragraphBuffer = [];
  }

  function flushList() {
    if (!listBuffer.length) return;
    blocks.push({ kind: "list", items: [...listBuffer] });
    listBuffer = [];
  }

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      flushParagraph();
      flushList();
      continue;
    }

    if (isAnswerHeading(line)) {
      flushParagraph();
      flushList();
      blocks.push({ kind: "heading", text: line.replace(/[：:]$/, "") });
      continue;
    }

    const markdownHeading = line.match(/^#{1,6}\s+(.*)$/);
    if (markdownHeading) {
      flushParagraph();
      flushList();
      blocks.push({ kind: "heading", text: markdownHeading[1].trim().replace(/[：:]$/, "") });
      continue;
    }

    const listMatch = line.match(/^(?:[-*•]|\d+[.)]|[一二三四五六七八九十]+[、.])\s+(.*)$/);
    if (listMatch) {
      flushParagraph();
      listBuffer.push(listMatch[1].trim());
      continue;
    }

    flushList();
    paragraphBuffer.push(line);
  }

  flushParagraph();
  flushList();
  return blocks;
}

function renderAnswerBody(text: string, displayText: (value: string) => string) {
  const blocks = parseAnswerBlocks(text);
  if (!blocks.length) {
    return <pre className="content-pre glass-pre qa-bubble-pre">{displayText(text)}</pre>;
  }

  return (
    <div className="qa-answer-rich">
      {blocks.map((block, index) => {
        if (block.kind === "heading") {
          return <h4 className="qa-answer-heading" key={`${block.kind}-${index}`}>{displayText(block.text)}</h4>;
        }
        if (block.kind === "list") {
          return (
            <ol className="qa-answer-list" key={`${block.kind}-${index}`}>
              {block.items.map((item) => (
                <li key={item}>{displayText(item)}</li>
              ))}
            </ol>
          );
        }
        return <p className="qa-answer-paragraph" key={`${block.kind}-${index}`}>{displayText(block.text)}</p>;
      })}
    </div>
  );
}

function getAnswerModeLabel(mode?: string) {
  if (mode === "assistant_model_info") return "系统配置回答";
  if (mode === "rag_agent_answer") return "Agent 理解回答";
  if (mode === "rag_fused_answer") return "模型融合回答";
  if (mode === "rag_fused_retrieval") return "检索整理回答";
  if (mode === "rag_agent_pending") return "待接入模型增强";
  if (mode === "rag_weak_evidence") return "弱证据谨慎回答";
  if (mode === "rag_source_blocked") return "源内容待补全";
  if (mode === "llm_weak_retrieval_answer") return "弱检索模型直答";
  if (mode === "llm_general_answer") return "通用模型补答";
  if (mode === "web_search_answer") return "联网补充回答";
  if (mode === "web_search_augmented_answer") return "本地优先 + 联网补充";
  if (mode === "retrieval_only") return "仅检索命中";
  return "";
}

function getFeedbackScopeLabel(options: {
  scopedChunkId?: string;
  scopedContentId?: string;
  scopedTitle?: string;
}) {
  if (options.scopedChunkId) return "当前片段";
  if (options.scopedContentId) return options.scopedTitle?.trim() ? "当前内容" : "单条内容";
  return "全库";
}

function getRetrievalRouteLabel(routes?: RetrievalRoutes) {
  if (!routes) return "待检索";
  if (routes.hierarchical) return "先找内容，再找片段";
  if ((routes.chunk_hits ?? 0) > 0 && (routes.content_hits ?? 0) > 0) return "内容与片段混合";
  if ((routes.chunk_hits ?? 0) > 0) return "片段直搜";
  if ((routes.content_hits ?? 0) > 0) return "内容直搜";
  return "基础检索";
}

function getRetrievalFocusLabel(focus?: RetrievalMeta["focus"]) {
  const title = focus?.title?.trim();
  if (focus?.mode === "scoped") {
    return title ? `锁定《${shortenText(title, 18)}》` : "已锁定单条内容";
  }
  if (focus?.auto_focused) {
    return title ? `聚焦《${shortenText(title, 18)}》` : "自动聚焦主内容";
  }
  return "全库融合";
}

function getRetrievalContextLabel(context?: RetrievalMeta["context"]) {
  if (!context?.follow_up) return "独立提问";
  const title = context.lead_title?.trim();
  if (title) {
    return `承接《${shortenText(title, 18)}》`;
  }
  return "承接上一轮";
}

function shortenText(value: string, limit = 22) {
  const trimmed = value.trim();
  if (!trimmed) return "";
  return trimmed.length <= limit ? trimmed : `${trimmed.slice(0, limit).trimEnd()}...`;
}


function dedupeSuggestions(values: string[], currentQuestion?: string) {
  const currentSignature = (currentQuestion || "").trim().replace(/\s+/g, "").toLowerCase();
  const deduped: string[] = [];
  const signatures = new Set<string>();

  for (const item of values) {
    const cleaned = item.trim();
    if (!cleaned) continue;
    const signature = cleaned.replace(/\s+/g, "").toLowerCase();
    if (!signature || signature === currentSignature || signatures.has(signature)) {
      continue;
    }
    signatures.add(signature);
    deduped.push(cleaned);
  }

  return deduped.slice(0, 3);
}

function getQualityBannerTone(quality: QualityMeta) {
  if (quality.level === "blocked") return "warning";
  if (quality.degraded || quality.grounded === false) return "info";
  return "success";
}

function shouldSuggestCaptureFix(quality: QualityMeta) {
  return (
    quality.source === "content_capture" ||
    /Cookie|转写|设置页|登录态|音频/.test(quality.recommended_action || "")
  );
}

function buildQualityFollowUpQuestion(quality: QualityMeta) {
  if (quality.level === "blocked") {
    return "先别外推结论，只基于当前拿到的材料告诉我最稳的线索和下一步。";
  }
  if (quality.degraded) {
    return "请只基于当前证据，给我一个更保守、更可核对的结论。";
  }
  return "请把这轮答案压缩成三条最值得记住的结论。";
}

function pickRecommendedCitations(items: ChatCitation[]) {
  const ranked = items.filter((item) => !isExternalCitation(item)).sort((left, right) => {
    const leftHasTime = typeof left.start_ms === "number" || typeof left.end_ms === "number";
    const rightHasTime = typeof right.start_ms === "number" || typeof right.end_ms === "number";
    if (leftHasTime !== rightHasTime) {
      return leftHasTime ? -1 : 1;
    }
    return right.score - left.score;
  });

  const picked: ChatCitation[] = [];
  const seen = new Set<string>();
  for (const item of ranked) {
    const signature = item.chunk_id?.trim() || `${item.content_id}:${item.chunk_index ?? "x"}:${item.start_ms ?? "na"}`;
    if (seen.has(signature)) continue;
    seen.add(signature);
    picked.push(item);
    if (picked.length >= 2) break;
  }
  return picked;
}

function buildCompactQualitySummary(quality: QualityMeta, mode?: string) {
  if (quality.level === "blocked") return "当前材料还不完整。";
  if (quality.source === "web_search" || mode === "web_search_answer" || mode === "web_search_augmented_answer") {
    return "本轮先看本地，再补了联网结果。";
  }
  if (mode === "llm_general_answer") return "本地未命中，已转为通用回答。";
  if (mode === "llm_weak_retrieval_answer") return "本地线索偏弱，这轮由模型谨慎直答。";
  if (quality.degraded) return "当前证据偏弱，结论更适合先参考。";
  if (mode === "assistant_model_info") return "这轮直接来自系统配置。";
  return "已结合当前资料完成回答。";
}

export default function ChatPage() {
  const { displayText } = useLanguage();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const feedbackSessionIdRef = useRef("");
  const prevSessionIdRef = useRef("");
  const streamEndRef = useRef<HTMLDivElement | null>(null);
  const [searchParams] = useSearchParams();
  const [question, setQuestion] = useState("");
  const [composerValue, setComposerValue] = useState("");
  const [answer, setAnswer] = useState("");
  const [citations, setCitations] = useState<ChatCitation[]>([]);
  const [followUps, setFollowUps] = useState<string[]>([]);
  const [expandedCitations, setExpandedCitations] = useState<Set<string>>(new Set());
  const [isStreaming, setIsStreaming] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  const [hasSubmitted, setHasSubmitted] = useState(false);
  const [localMessage, setLocalMessage] = useState("");
  const [savedNoteId, setSavedNoteId] = useState("");
  const [answerQuality, setAnswerQuality] = useState<QualityMeta>({});
  const [answerRetrieval, setAnswerRetrieval] = useState<RetrievalMeta | null>(null);
  const [answerMode, setAnswerMode] = useState<ChatResponse["mode"] | "">("");
  const [selectedChatModel, setSelectedChatModel] = useState(() => readStoredChatModelOverride());
  const [webSearchEnabled, setWebSearchEnabled] = useState(() => readStoredChatWebSearchEnabled());

  const scopedContentId = searchParams.get("contentId")?.trim() || "";
  const scopedChunkId = searchParams.get("chunkId")?.trim() || "";
  const scopedTitle = searchParams.get("title")?.trim() || "";
  const scopedChunkLabel = searchParams.get("chunkLabel")?.trim() || "";
  const activeSessionId = searchParams.get("sessionId")?.trim() || "";

  const sessionsQuery = useQuery({
    queryKey: ["chat-sessions"],
    queryFn: listChatSessions,
    retry: 1,
  });

  const activeSessionQuery = useQuery({
    queryKey: ["chat-session", activeSessionId],
    queryFn: () => getChatSession(activeSessionId),
    enabled: Boolean(activeSessionId),
    retry: 1,
  });
  const settingsQuery = useQuery({
    queryKey: ["settings"],
    queryFn: getSettings,
    retry: 1,
  });
  const modelCatalogQuery = useQuery({
    queryKey: [
      "chat-model-catalog",
      settingsQuery.data?.model.provider,
      settingsQuery.data?.model.llm_api_base_url,
    ],
    enabled: Boolean(settingsQuery.data?.model.llm_api_base_url?.trim()),
    retry: 1,
    staleTime: 5 * 60 * 1000,
    queryFn: () =>
      fetchModelCatalog({
        provider: settingsQuery.data?.model.provider || "openai_compatible",
        api_base_url: settingsQuery.data?.model.llm_api_base_url || "",
      }),
  });

  const saveTurnMutation = useMutation({
    mutationFn: saveChatTurn,
    onSuccess: async (result) => {
      await queryClient.invalidateQueries({ queryKey: ["chat-sessions"] });
      await queryClient.invalidateQueries({ queryKey: ["chat-session", result.session.id] });
      if (result.session.auto_switched) {
        setLocalMessage("对话记录较多，已自动新建会话继续。");
      }
    },
  });

  const saveNoteMutation = useMutation({
    mutationFn: saveChatNote,
    onSuccess: async (result) => {
      await queryClient.invalidateQueries({ queryKey: ["contents"] });
      setSavedNoteId(result.content.id);
      setLocalMessage(result.message);
    },
  });
  const deleteSessionMutation = useMutation({
    mutationFn: deleteChatSession,
    onSuccess: async (result, sessionId) => {
      await queryClient.invalidateQueries({ queryKey: ["chat-sessions"] });
      queryClient.removeQueries({ queryKey: ["chat-session", sessionId], exact: true });

      if (!result.deleted) {
        setLocalMessage("没有找到要删除的会话。");
        return;
      }

      if (sessionId === activeSessionId) {
        navigate(
          buildChatLink({
            contentId: scopedContentId || undefined,
            chunkId: scopedChunkId || undefined,
            title: scopedTitle || undefined,
            chunkLabel: scopedChunkLabel || undefined,
          }),
          { replace: true },
        );
        return;
      }

      setLocalMessage("会话已删除。");
    },
    onError: (error) => {
      setLocalMessage(error instanceof Error ? error.message : "删除会话失败，请稍后再试。");
    },
  });
  useEffect(() => {
    const query = searchParams.get("q");
    if (query?.trim()) {
      setComposerValue(query.trim());
    }
  }, [searchParams]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(CHAT_MODEL_OVERRIDE_STORAGE_KEY, selectedChatModel.trim());
  }, [selectedChatModel]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(CHAT_WEB_SEARCH_STORAGE_KEY, webSearchEnabled ? "1" : "0");
  }, [webSearchEnabled]);

  useEffect(() => {
    const leavingSessionId = prevSessionIdRef.current;
    prevSessionIdRef.current = activeSessionId;

    if (leavingSessionId && leavingSessionId !== activeSessionId) {
      const leavingSession = (sessionsQuery.data?.items ?? []).find((s) => s.id === leavingSessionId);
      if (leavingSession && leavingSession.message_count === 0) {
        deleteChatSession(leavingSessionId).then(() => {
          queryClient.invalidateQueries({ queryKey: ["chat-sessions"] });
        }).catch(() => {});
      }
    }

    setQuestion("");
    setComposerValue(searchParams.get("q")?.trim() || "");
    setAnswer("");
    setCitations([]);
    setFollowUps([]);
    setErrorMessage("");
    setLocalMessage("");
    setHasSubmitted(false);
    setSavedNoteId("");
    if (!activeSessionId || (feedbackSessionIdRef.current && activeSessionId !== feedbackSessionIdRef.current)) {
      setAnswerQuality({});
      setAnswerRetrieval(null);
      setAnswerMode("");
      if (!activeSessionId) {
        feedbackSessionIdRef.current = "";
      }
    }
  }, [activeSessionId]); // eslint-disable-line react-hooks/exhaustive-deps

  const scopeLabel = useMemo(() => {
    if (scopedChunkId) return scopedChunkLabel || "片段范围";
    if (scopedContentId) return scopedTitle || "单条内容";
    return "全库";
  }, [scopedChunkId, scopedChunkLabel, scopedContentId, scopedTitle]);
  const currentChatModel = settingsQuery.data?.model.chat_model?.trim() || "";
  const availableChatModels = useMemo(() => {
    const values = [
      currentChatModel,
      ...(modelCatalogQuery.data?.models ?? []),
      selectedChatModel,
    ];
    return Array.from(new Set(values.map((item) => item.trim()).filter(Boolean)));
  }, [currentChatModel, modelCatalogQuery.data?.models, selectedChatModel]);

  const sessionMessages = activeSessionQuery.data?.messages ?? [];
  const latestUserQuestion = useMemo(
    () =>
      [...sessionMessages]
        .reverse()
        .find((message) => message.role === "user")
        ?.message_text?.trim() || "",
    [sessionMessages],
  );
  useEffect(() => {
    if (!streamEndRef.current) return;
    streamEndRef.current.scrollIntoView({
      behavior: isStreaming ? "auto" : "smooth",
      block: "end",
    });
  }, [answer, citations.length, isStreaming, sessionMessages.length]);
  const feedbackScopeLabel = useMemo(
    () =>
      getFeedbackScopeLabel({
        scopedChunkId,
        scopedContentId,
        scopedTitle,
      }),
    [scopedChunkId, scopedContentId, scopedTitle],
  );
  const feedbackModeLabel = useMemo(() => getAnswerModeLabel(answerMode), [answerMode]);
  const feedbackRoutes = answerRetrieval?.routes;
  const feedbackPaths = answerRetrieval?.paths ?? [];
  const feedbackVariants = answerRetrieval?.query_variants ?? [];
  const feedbackFocus = answerRetrieval?.focus;
  const feedbackContext = answerRetrieval?.context;
  const feedbackSignals = useMemo(() => {
    const evidenceCount =
      answerQuality.citation_count ??
      answerQuality.matched_items ??
      feedbackRoutes?.fused_hits ??
      0;
    const rewriteCount = Math.max(0, feedbackVariants.length - 1);
    const contextCount = feedbackRoutes?.session_context_used ?? 0;
    return [
      { label: "范围", value: feedbackScopeLabel },
      { label: "证据", value: evidenceCount > 0 ? `${evidenceCount} 条` : "偏弱" },
      { label: "可信度", value: answerQuality.grounded === false ? "谨慎参考" : "已结合证据" },
      { label: "方式", value: feedbackModeLabel || "处理中" },
      { label: "承接", value: getRetrievalContextLabel(feedbackContext) },
      { label: "聚焦", value: getRetrievalFocusLabel(feedbackFocus) },
      { label: "路径", value: getRetrievalRouteLabel(feedbackRoutes) },
      { label: "补充", value: rewriteCount > 0 ? `${rewriteCount} 次` : "无" },
      { label: "会话", value: contextCount > 0 ? `${contextCount} 条` : "无" },
    ];
  }, [answerQuality, feedbackContext, feedbackFocus, feedbackModeLabel, feedbackRoutes, feedbackScopeLabel, feedbackVariants.length]);
  const isLowRecall = useMemo(() => {
    if (!hasSubmitted || isStreaming) return false;
    const topScore = typeof answerQuality.top_score === "number" ? answerQuality.top_score : null;
    const degraded = answerQuality.degraded === true;
    const noEvidence = (answerQuality.citation_count ?? answerQuality.matched_items ?? 0) === 0;
    return degraded || noEvidence || (topScore !== null && topScore < 0.35);
  }, [answerQuality, hasSubmitted, isStreaming]);

  const feedbackTags = useMemo(() => {
    const tags: string[] = [];
    if (answerQuality.degraded) tags.push("证据偏弱");
    if (feedbackContext?.follow_up) tags.push("承接上轮");
    if (feedbackFocus?.auto_focused) tags.push("自动聚焦");
    if (feedbackRoutes?.hierarchical) tags.push("层级检索");
    if ((feedbackRoutes?.content_targets ?? 0) > 0) tags.push(`候选内容 ${feedbackRoutes?.content_targets}`);
    if (answerQuality.source === "general_model") tags.push("通用模型补答");
    if (answerQuality.source === "web_search") tags.push("联网补充");
    return tags;
  }, [answerQuality.degraded, answerQuality.source, feedbackContext?.follow_up, feedbackFocus?.auto_focused, feedbackRoutes?.content_targets, feedbackRoutes?.hierarchical]);
  const feedbackVariantLabels = useMemo(() => {
    if (feedbackVariants.length <= 1) return [];
    return feedbackVariants.slice(1, 4).map((item) => shortenText(item));
  }, [feedbackVariants]);
  const compactQualitySummary = useMemo(
    () => buildCompactQualitySummary(answerQuality, answerMode),
    [answerMode, answerQuality],
  );
  const showFeedbackPanel = Boolean(
    answerMode &&
      (
        answerQuality.degraded ||
        answerQuality.level === "blocked" ||
        [
          "assistant_model_info",
          "llm_general_answer",
          "llm_weak_retrieval_answer",
          "web_search_answer",
          "web_search_augmented_answer",
          "rag_source_blocked",
        ].includes(answerMode)
      ),
  );
  const primaryFeedbackSignals = feedbackSignals.slice(0, 3);
  const secondaryFeedbackSignals = feedbackSignals.slice(3).filter((item) => item.value.trim());
  const compactFeedbackTags = feedbackTags.slice(0, 3);
  const feedbackPathItems = feedbackPaths.slice(0, 2);
  const showFeedbackDetails = Boolean(secondaryFeedbackSignals.length || feedbackVariantLabels.length);
  const firstLocalCitation = useMemo(
    () => citations.find((item) => !isExternalCitation(item)) ?? null,
    [citations],
  );
  const primaryContentId = useMemo(
    () => feedbackFocus?.content_id?.trim() || firstLocalCitation?.content_id?.trim() || scopedContentId,
    [feedbackFocus?.content_id, firstLocalCitation?.content_id, scopedContentId],
  );
  const primaryContentTitle = useMemo(
    () => feedbackFocus?.title?.trim() || firstLocalCitation?.title?.trim() || scopedTitle,
    [feedbackFocus?.title, firstLocalCitation?.title, scopedTitle],
  );
  const qualityBannerTone = useMemo(() => getQualityBannerTone(answerQuality), [answerQuality]);
  const qualityFollowUpQuestion = useMemo(() => buildQualityFollowUpQuestion(answerQuality), [answerQuality]);
  const qualityActionItems = useMemo(() => {
    const items: Array<
      | { kind: "link"; label: string; to: string; tone?: "primary" | "secondary" }
      | { kind: "button"; label: string; value: string; tone?: "primary" | "secondary" }
    > = [];

    if (shouldSuggestCaptureFix(answerQuality)) {
      items.push({ kind: "link", label: "去补全采集能力", to: "/settings", tone: "secondary" });
    }

    if (primaryContentId) {
      items.push({
        kind: "link",
        label: answerQuality.degraded || answerQuality.level === "blocked" ? "查看材料详情" : `打开${primaryContentTitle ? "主内容" : "详情页"}`,
        to: `/library/${primaryContentId}`,
        tone: "secondary",
      });
    }

    if (answer.trim()) {
      items.push({
        kind: "button",
        label: answerQuality.degraded || answerQuality.level === "blocked" ? "让回答更保守" : "压缩成三点",
        value: qualityFollowUpQuestion,
        tone: "primary",
      });
    }

    const deduped: typeof items = [];
    const signatures = new Set<string>();
    for (const item of items) {
      const signature = item.kind === "link" ? `${item.kind}:${item.to}` : `${item.kind}:${item.value}`;
      if (signatures.has(signature)) continue;
      signatures.add(signature);
      deduped.push(item);
      if (deduped.length >= 3) break;
    }
    return deduped;
  }, [answer, answerQuality, primaryContentId, primaryContentTitle, qualityFollowUpQuestion]);
  const sessionItems = sessionsQuery.data?.items ?? [];
  const visibleSessions = sessionItems.slice(0, 10);
  const sessionRetentionDays = sessionsQuery.data?.retention_days ?? 7;
  const recommendedCitations = useMemo(() => pickRecommendedCitations(citations), [citations]);

  const conversationMessages = useMemo(() => {
    const items: Array<
      ChatSessionMessage & {
        isLive?: boolean;
        quality?: QualityMeta;
        liveCitations?: ChatCitation[];
      }
    > = [...sessionMessages];

    if (hasSubmitted && question.trim()) {
      items.push({
        id: "draft-user",
        role: "user",
        message_text: question.trim(),
        citations: [],
        created_at: new Date().toISOString(),
        isLive: true,
      });
    }

    if (hasSubmitted && (isStreaming || answer.trim() || errorMessage)) {
      items.push({
        id: "draft-assistant",
        role: "assistant",
        message_text: errorMessage || answer || "正在生成回答...",
        citations: citations,
        created_at: new Date().toISOString(),
        isLive: true,
        quality: answerQuality,
        liveCitations: citations,
      });
    }

    return items;
  }, [answer, answerQuality, citations, errorMessage, hasSubmitted, isStreaming, question, sessionMessages]);

  async function submitQuestion(value: string) {
    const trimmed = value.trim();
    if (!trimmed || isStreaming) {
      return;
    }

    let fullAnswer = "";
    let finalCitations: ChatCitation[] = [];
    let finalFollowUps: string[] = [];

    setQuestion(trimmed);
    setComposerValue("");
    setAnswer("");
    setCitations([]);
    setFollowUps([]);
    setErrorMessage("");
    setLocalMessage("");
    setSavedNoteId("");
    setAnswerQuality({});
    setAnswerRetrieval(null);
    setAnswerMode("");
    setIsStreaming(true);
    setHasSubmitted(true);
    feedbackSessionIdRef.current = activeSessionId || "__live__";

    try {
      await streamChat(
        trimmed,
        {
          onChunk: (chunk) => {
            fullAnswer += chunk;
            setAnswer((current) => current + chunk);
          },
          onMeta: (meta) => {
            const quality = meta.quality as QualityMeta | undefined;
            if (quality) setAnswerQuality(quality);
            const retrieval = meta.retrieval as RetrievalMeta | undefined;
            if (retrieval) setAnswerRetrieval(retrieval);
            if (typeof meta.mode === "string") {
              setAnswerMode(meta.mode as ChatResponse["mode"]);
            }
          },
          onDone: (payload) => {
            finalCitations = payload.citations;
            finalFollowUps = dedupeSuggestions(payload.followUps, trimmed);
            setCitations(payload.citations);
            setFollowUps(finalFollowUps);
            setAnswerQuality(payload.quality ?? {});
            if (payload.retrieval) setAnswerRetrieval(payload.retrieval);
          },
        },
        {
          contentId: scopedContentId || undefined,
          chunkId: scopedChunkId || undefined,
          sessionId: activeSessionId || undefined,
          chatModel: selectedChatModel.trim() || undefined,
          webSearchEnabled,
        },
      );

      if (fullAnswer.trim()) {
        try {
          const result = await saveTurnMutation.mutateAsync({
            question: trimmed,
            answer: fullAnswer,
            citations: finalCitations,
            sessionId: activeSessionId || undefined,
          });
          feedbackSessionIdRef.current = result.session.id;
          setHasSubmitted(false);
          setAnswer("");
          setCitations([]);
          navigate(
            buildChatLink({
              sessionId: result.session.id,
              contentId: scopedContentId || undefined,
              chunkId: scopedChunkId || undefined,
              title: scopedTitle || undefined,
              chunkLabel: scopedChunkLabel || undefined,
            }),
            { replace: true },
          );
        } catch {
          setLocalMessage("回答已生成，但本轮暂未写入会话记录。");
        }
      }
      if (!finalFollowUps.length) {
        setFollowUps([]);
      }
    } catch (error) {
      if (fullAnswer.trim()) {
        // 保留已流出的部分答案，追加中断提示
        setAnswer((current) => (current || fullAnswer) + "\n\n_（回答被中断，以上为已接收内容，可重新提问）_");
        setErrorMessage("");
      } else {
        setErrorMessage(error instanceof Error ? error.message : "问答失败，请稍后再试。");
      }
    } finally {
      setIsStreaming(false);
    }
  }

  function handleComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.nativeEvent.isComposing) {
      return;
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void submitQuestion(composerValue);
    }
  }

  function handleDeleteSession(sessionId: string, title: string) {
    if (deleteSessionMutation.isPending || isStreaming) {
      return;
    }

    const normalizedTitle = title.trim() || "未命名会话";
    const confirmMessage =
      sessionId === activeSessionId
        ? `确认删除当前会话「${normalizedTitle}」吗？删除后将无法恢复。`
        : `确认删除会话「${normalizedTitle}」吗？删除后将无法恢复。`;

    if (!window.confirm(displayText(confirmMessage))) {
      return;
    }

    setLocalMessage("");
    deleteSessionMutation.mutate(sessionId);
  }

  async function handleCopyAnswer() {
    if (!answer.trim()) return;
    try {
      if (!navigator.clipboard?.writeText) throw new Error("clipboard unavailable");
      await navigator.clipboard.writeText(answer);
      setLocalMessage("回答已复制。");
    } catch {
      setLocalMessage("当前浏览环境不支持自动复制，请手动复制。");
    }
  }

  function handleSaveAnswer() {
    if (!answer.trim() || saveNoteMutation.isPending) return;
    setLocalMessage("");
    setSavedNoteId("");
    saveNoteMutation.mutate({
      question,
      answer,
      citations,
      contentId: scopedContentId || undefined,
      chunkId: scopedChunkId || undefined,
    });
  }

  return (
    <section className="page qa-chat-page">
      <div className="qa-chat-layout">
        <aside className="qa-chat-side qa-chat-side-left">
          <article className="card glass-panel qa-sidebar-card">
            <div className="panel-heading">
              <div>
                <p className="eyebrow">{displayText("范围")}</p>
                <h3>{displayText(scopeLabel)}</h3>
              </div>
              <span className="pill">{displayText(activeSessionId ? "当前会话" : "新会话")}</span>
            </div>
            <div className="qa-scope-summary">
              <span>{displayText(scopedChunkId ? "片段范围" : scopedContentId ? "单条范围" : "全库范围")}</span>
              <strong>{displayText(scopedTitle || scopedChunkLabel || scopeLabel)}</strong>
            </div>
            <div className="header-actions">
              <button
                className="primary-button"
                type="button"
                onClick={() =>
                  navigate(
                    buildChatLink({
                      contentId: scopedContentId || undefined,
                      chunkId: scopedChunkId || undefined,
                      title: scopedTitle || undefined,
                      chunkLabel: scopedChunkLabel || undefined,
                    }),
                  )
                }
              >
                {displayText("新对话")}
              </button>
              {(hasSubmitted || sessionMessages.length > 0) && !isStreaming && (
                <button
                  className="secondary-button"
                  type="button"
                  onClick={() => {
                    setAnswer("");
                    setCitations([]);
                    setFollowUps([]);
                    setErrorMessage("");
                    setHasSubmitted(false);
                    setAnswerQuality({});
                    setAnswerRetrieval(null);
                    setAnswerMode("");
                    setComposerValue("");
                  }}
                  title={displayText("清空当前输入和回答，不删除会话记录")}
                >
                  {displayText("清空")}
                </button>
              )}
              <Link className="secondary-button button-link" to="/library">
                {displayText("知识库")}
              </Link>
              {(scopedContentId || scopedChunkId) && (
                <button
                  className="secondary-button"
                  type="button"
                  onClick={() =>
                    navigate(
                      buildChatLink({
                        sessionId: activeSessionId || undefined,
                      }),
                    )
                  }
                >
                  {displayText("全库")}
                </button>
              )}
            </div>
          </article>

          <article className="card glass-panel qa-sidebar-card">
            <div className="panel-heading">
              <div>
                <p className="eyebrow">{displayText("会话")}</p>
                <h3>{displayText("历史会话")}</h3>
              </div>
              <span className="pill">{displayText(`${sessionItems.length} 条`)}</span>
            </div>
            <div className="pill-row">
              <span className="pill">{displayText(`${sessionRetentionDays} 天保留`)}</span>
            </div>
            {sessionsQuery.isLoading && <p className="muted-text">{displayText("读取中...")}</p>}
            {sessionsQuery.isError && <p className="error-text">{displayText("暂时无法读取会话历史。")}</p>}
            {!sessionsQuery.isLoading && !sessionsQuery.isError && !visibleSessions.length && (
              <p className="muted-text">{displayText("还没有会话。")}</p>
            )}
            <div className="qa-session-list">
              {visibleSessions.map((session) => {
                const isActiveSession = session.id === activeSessionId;
                const isDeletingSession =
                  deleteSessionMutation.isPending && deleteSessionMutation.variables === session.id;

                return (
                  <article
                    className={
                      isActiveSession
                        ? "citation-card qa-session-card qa-session-card-active qa-session-card-shell"
                        : "citation-card qa-session-card qa-session-card-shell"
                    }
                    key={session.id}
                  >
                    <Link
                      className="qa-session-card-link"
                      to={buildChatLink({
                        sessionId: session.id,
                        contentId: scopedContentId || undefined,
                        chunkId: scopedChunkId || undefined,
                        title: scopedTitle || undefined,
                        chunkLabel: scopedChunkLabel || undefined,
                      })}
                    >
                      <div className="pill-row">
                        <span className="pill">{displayText(`${session.message_count} 条消息`)}</span>
                        {session.updated_at && <span className="pill">{displayText(formatMessageTime(session.updated_at))}</span>}
                      </div>
                      <strong>{displayText(session.title?.trim() || "新会话")}</strong>
                      <p className="muted-text">{displayText(session.last_message || "还没有内容预览")}</p>
                    </Link>
                    <button
                      className="secondary-button qa-session-delete-button"
                      type="button"
                      onClick={() => handleDeleteSession(session.id, session.title)}
                      disabled={isDeletingSession || isStreaming}
                      aria-label={displayText(`删除会话 ${session.title}`)}
                    >
                      {displayText(isDeletingSession ? "删除中" : "删除")}
                    </button>
                  </article>
                );
              })}
            </div>
          </article>
        </aside>

        <article className="card glass-panel qa-chat-main">
          <div className="qa-chat-topbar">
            <div>
              <p className="eyebrow">{displayText("问答")}</p>
              <h2>{displayText(activeSessionQuery.data?.title || "新会话")}</h2>
            </div>
            <div className="pill-row">
              <span className="pill">{displayText(scopeLabel)}</span>
              <span className="pill">{displayText(selectedChatModel.trim() ? selectedChatModel : currentChatModel || "默认模型")}</span>
              <span className="pill">{displayText(webSearchEnabled ? "联网补充" : "本地优先")}</span>
              {feedbackModeLabel && <span className="pill">{displayText(feedbackModeLabel)}</span>}
              {answerQuality.label && <span className="pill">{displayText(answerQuality.label)}</span>}
              {!!citations.length && <span className="pill">{displayText(`${citations.length} 条引用`)}</span>}
            </div>
          </div>

          <div className="qa-message-stream">
            {!conversationMessages.length && (
              <div className="glass-callout qa-empty-stream">
                <strong>{displayText("开始提问")}</strong>
              </div>
            )}

            {showFeedbackPanel && (
              <div className={`qa-quality-banner qa-quality-banner-${qualityBannerTone}`}>
                <div>
                  <strong>{displayText(answerQuality.label || feedbackModeLabel || "本轮回答状态")}</strong>
                  <p>{displayText(compactQualitySummary)}</p>
                </div>
                {!!qualityActionItems.length && (
                  <div className="qa-quality-actions">
                    {qualityActionItems.map((item) =>
                      item.kind === "link" ? (
                        <Link
                          key={`${item.kind}-${item.to}`}
                          className={item.tone === "primary" ? "primary-button button-link" : "secondary-button button-link"}
                          to={item.to}
                        >
                          {displayText(item.label)}
                        </Link>
                      ) : (
                        <button
                          key={`${item.kind}-${item.value}`}
                          className={item.tone === "primary" ? "primary-button" : "secondary-button"}
                          type="button"
                          onClick={() => void submitQuestion(item.value)}
                          disabled={isStreaming}
                        >
                          {displayText(item.label)}
                        </button>
                      ),
                    )}
                  </div>
                )}
              </div>
            )}

            {!!recommendedCitations.length && (
              <div className="qa-evidence-recommend-strip">
                <div className="qa-evidence-recommend-head">
                  <div>
                    <strong>{displayText("优先片段")}</strong>
                  </div>
                </div>
                <div className="qa-evidence-recommend-list">
                  {recommendedCitations.map((citation) => {
                    const chunkLabel = formatChunkLabel(citation) || "重点片段";
                    const jumpUrl = buildSeekUrl(citation);
                    const detailLink = buildCitationDetailLink(citation);
                    return (
                      <article
                        className="qa-evidence-recommend-card"
                        key={citation.chunk_id ?? `${citation.content_id}-${citation.score}-${citation.chunk_index ?? 0}`}
                      >
                        <div className="pill-row">
                          <span className="pill">{displayText(citation.platform ?? "来源")}</span>
                          <span className="pill">{displayText(chunkLabel)}</span>
                        </div>
                        <strong>{displayText(citation.title)}</strong>
                        <p>{displayText(citation.snippet)}</p>
                        <div className="header-actions">
                          {detailLink && (
                            <Link className="secondary-button button-link" to={detailLink}>
                              {displayText("详情")}
                            </Link>
                          )}
                          {jumpUrl && (
                            <a className="primary-button button-link" href={jumpUrl} target="_blank" rel="noreferrer">
                              {displayText(isExternalCitation(citation) ? "打开" : "回看")}
                            </a>
                          )}
                        </div>
                      </article>
                    );
                  })}
                </div>
              </div>
            )}

            {conversationMessages.map((message) => {
              const isAssistant = message.role === "assistant";
              const messageCitations = message.isLive ? message.liveCitations ?? [] : message.citations ?? [];
              return (
                <article
                  className={isAssistant ? "qa-bubble qa-bubble-assistant" : "qa-bubble qa-bubble-user"}
                  key={message.id}
                >
                  <div className="qa-bubble-meta">
                    <span>{displayText(isAssistant ? "知库" : "你")}</span>
                    <small>{formatMessageTime(message.created_at)}</small>
                  </div>
                  {isAssistant
                    ? renderAnswerBody(message.message_text, displayText)
                    : <pre className="content-pre glass-pre qa-bubble-pre">{displayText(message.message_text)}</pre>}

                  {isAssistant && message.isLive && message.quality?.summary && (message.quality.degraded || message.quality.level === "blocked") && (
                    <div className="glass-callout">
                      <strong>{displayText(message.quality.label || "回答状态")}</strong>
                      <p className="muted-text">{displayText(compactQualitySummary)}</p>
                    </div>
                  )}

                  {isAssistant && !!messageCitations.length && (
                    <details className="qa-citation-disclosure">
                      <summary>{displayText(`查看引用来源（${messageCitations.length}）`)}</summary>
                      <div className="qa-inline-citations">
                        {(expandedCitations.has(message.id) ? messageCitations : messageCitations.slice(0, 4)).map((citation) => {
                          const chunkLabel = formatChunkLabel(citation);
                          const jumpUrl = buildSeekUrl(citation);
                          const detailLink = buildCitationDetailLink(citation);
                          return (
                            <article
                              className="citation-card qa-inline-citation-card"
                              key={citation.chunk_id ?? `${citation.content_id}-${citation.score}-${citation.chunk_index ?? 0}`}
                            >
                              <div className="pill-row">
                                <span className="pill">{displayText(citation.platform ?? "来源")}</span>
                                {chunkLabel && <span className="pill">{displayText(chunkLabel)}</span>}
                              </div>
                              <strong>{displayText(citation.title)}</strong>
                              <p className="muted-text">{displayText(citation.snippet)}</p>
                              <div className="header-actions">
                                {detailLink && (
                                  <Link className="secondary-button button-link" to={detailLink}>
                                    {displayText("详情")}
                                  </Link>
                                )}
                                {jumpUrl && (
                                  <a className="secondary-button button-link" href={jumpUrl} target="_blank" rel="noreferrer">
                                    {displayText(isExternalCitation(citation) ? "打开" : "回看")}
                                  </a>
                                )}
                              </div>
                            </article>
                          );
                        })}
                        {messageCitations.length > 4 && !expandedCitations.has(message.id) && (
                          <button
                            className="secondary-button"
                            type="button"
                            style={{ fontSize: 12, padding: "2px 10px", marginTop: 4 }}
                            onClick={() => setExpandedCitations((prev) => new Set([...prev, message.id]))}
                          >
                            {displayText(`展开全部 ${messageCitations.length} 条引用`)}
                          </button>
                        )}
                      </div>
                    </details>
                  )}
                </article>
              );
            })}
            <div ref={streamEndRef} />
          </div>

          <div className="qa-chat-composer">
            {errorMessage && <p className="error-text">{displayText(errorMessage)}</p>}
            {localMessage && <p className="success-text">{displayText(localMessage)}</p>}
            {isLowRecall && (
              <div className="low-recall-warning">
                <span>{displayText("证据偏弱，可补充资料或换个问法试试。")}</span>
                <Link className="secondary-button button-link" to="/library" style={{ fontSize: 12, padding: "2px 10px" }}>
                  {displayText("去导入")}
                </Link>
              </div>
            )}
            {savedNoteId && (
              <div className="glass-callout">
                <strong>{displayText("已保存")}</strong>
                <div className="header-actions">
                  <Link className="secondary-button button-link" to={`/library/${savedNoteId}`}>
                    {displayText("打开")}
                  </Link>
                </div>
              </div>
            )}

            {!!followUps.length && (
              <div className="qa-follow-up-row">
                {followUps.map((item) => (
                  <button
                    key={item}
                    className="secondary-button suggestion-chip qa-follow-up-chip"
                    type="button"
                    onClick={() => void submitQuestion(item)}
                    disabled={isStreaming}
                  >
                    {displayText(item)}
                  </button>
                ))}
              </div>
            )}

            <div className="qa-composer-toolbar">
              <div className="qa-composer-toolbar-group">
                <label className="qa-inline-control">
                  <span>{displayText("模型")}</span>
                  <select
                    className="search-input qa-inline-select"
                    value={selectedChatModel}
                    onChange={(event) => setSelectedChatModel(event.target.value)}
                  >
                    <option value="">{displayText(currentChatModel ? `跟随默认 · ${currentChatModel}` : "跟随默认")}</option>
                    {availableChatModels
                      .filter((item) => item !== currentChatModel)
                      .map((item) => (
                        <option key={item} value={item}>
                          {displayText(item)}
                        </option>
                      ))}
                  </select>
                </label>

                <label className={webSearchEnabled ? "qa-toggle-chip qa-toggle-chip-active" : "qa-toggle-chip"}>
                  <input
                    type="checkbox"
                    checked={webSearchEnabled}
                    onChange={(event) => setWebSearchEnabled(event.target.checked)}
                  />
                  <span>{displayText("联网补充")}</span>
                </label>

                <span className="subtle-pill">{displayText("本地优先")}</span>
                {modelCatalogQuery.isFetching && <span className="subtle-pill">{displayText("模型读取中")}</span>}
              </div>
            </div>

            <textarea
              className="text-area qa-chat-input"
              rows={4}
              placeholder={displayText("输入你的问题")}
              value={composerValue}
              onChange={(event) => setComposerValue(event.target.value)}
              onKeyDown={handleComposerKeyDown}
            />
            <div className="header-actions">
              <button
                className="primary-button"
                type="button"
                disabled={!composerValue.trim() || isStreaming}
                onClick={() => void submitQuestion(composerValue)}
              >
                {isStreaming ? displayText("生成中...") : activeSessionId ? displayText("继续追问") : displayText("发送")}
              </button>
              <button className="secondary-button" type="button" onClick={() => void handleCopyAnswer()} disabled={!answer.trim()}>
                {displayText("复制回答")}
              </button>
              <button className="secondary-button" type="button" onClick={handleSaveAnswer} disabled={!answer.trim() || saveNoteMutation.isPending}>
                {saveNoteMutation.isPending ? displayText("保存中...") : displayText("保存卡片")}
              </button>
            </div>

            {!activeSessionId && !conversationMessages.length && (
              <div className="pill-row prompt-grid">
                {(scopedContentId || scopedChunkId ? SCOPED_SUGGESTED_QUESTIONS : GLOBAL_SUGGESTED_QUESTIONS).map((item) => (
                  <button
                    key={item}
                    className="secondary-button suggestion-chip prompt-chip"
                    type="button"
                    onClick={() => void submitQuestion(item)}
                    disabled={isStreaming}
                  >
                    {displayText(item)}
                  </button>
                ))}
              </div>
            )}
          </div>
        </article>

        <aside className="qa-chat-side qa-chat-side-right">
          {showFeedbackPanel ? (
            <article className="card glass-panel qa-sidebar-card qa-feedback-card">
              <div className="panel-heading">
                <div>
                  <p className="eyebrow">{displayText("状态")}</p>
                  <h3>{displayText(answerQuality.label || "回答")}</h3>
                </div>
              </div>
              {!!compactFeedbackTags.length && (
                <div className="pill-row qa-feedback-tag-row">
                  {compactFeedbackTags.map((tag) => (
                    <span className="pill" key={tag}>{displayText(tag)}</span>
                  ))}
                </div>
              )}
              <div className="qa-feedback-metrics">
                {primaryFeedbackSignals.map((item) => (
                  <article className="qa-feedback-metric" key={item.label}>
                    <span>{displayText(item.label)}</span>
                    <strong>{displayText(item.value)}</strong>
                  </article>
                ))}
              </div>

              {!!feedbackPathItems.length && (
                <div className="qa-feedback-section">
                  <p className="eyebrow">{displayText("相关内容")}</p>
                  <div className="qa-feedback-paths">
                    {feedbackPathItems.map((item) => (
                      <Link className="qa-feedback-link" key={item.content_id} to={`/library/${item.content_id}`}>
                        <strong>{displayText(item.title)}</strong>
                        <small>{displayText(`相关 ${item.score.toFixed(1)}`)}</small>
                      </Link>
                    ))}
                  </div>
                </div>
              )}

              {showFeedbackDetails && (
                <details className="qa-feedback-details">
                  <summary>{displayText("细节")}</summary>
                  {!!secondaryFeedbackSignals.length && (
                    <div className="qa-feedback-metrics qa-feedback-metrics-secondary">
                      {secondaryFeedbackSignals.map((item) => (
                        <article className="qa-feedback-metric" key={item.label}>
                          <span>{displayText(item.label)}</span>
                          <strong>{displayText(item.value)}</strong>
                        </article>
                      ))}
                    </div>
                  )}
                  {!!feedbackVariantLabels.length && (
                    <div className="qa-feedback-section">
                      <p className="eyebrow">{displayText("改写")}</p>
                      <div className="pill-row">
                        {feedbackVariantLabels.map((item) => (
                          <span className="pill" key={item}>{displayText(item)}</span>
                        ))}
                      </div>
                    </div>
                  )}
                </details>
              )}
            </article>
          ) : (
            <article className="card glass-panel qa-sidebar-card qa-feedback-card">
              <div className="panel-heading">
                <div>
                  <p className="eyebrow">{displayText("状态")}</p>
                  <h3>{displayText("等待回答")}</h3>
                </div>
              </div>
            </article>
          )}
        </aside>
      </div>
    </section>
  );
}
