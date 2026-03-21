import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { formatMilliseconds, formatTimeRange } from "../lib/utils";
import {
  deleteChatSession,
  getChatSession,
  listChatSessions,
  saveChatNote,
  saveChatTurn,
  streamChat,
  type ChatCitation,
  type ChatResponse,
  type ChatSessionMessage,
} from "../lib/api";
import { useLanguage } from "../lib/language";

const GLOBAL_SUGGESTED_QUESTIONS = [
  "我的知识库里有哪些关于学习方法的内容？",
  "最近收录的内容里有什么值得深入研究的？",
  "帮我找找知识库里关于效率和时间管理的片段",
  "哪条内容最值得今天重新看一遍？",
];

const SCOPED_SUGGESTED_QUESTIONS = [
  "这个视频主要讲了什么，核心结论是什么？",
  "UP主提到了哪些具体方法或步骤？",
  "这里有哪些观点我可以直接用？",
  "帮我找出最值得二刷的片段",
];

function formatChunkLabel(citation: ChatCitation) {
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
  const search = new URLSearchParams();
  const normalizedChunkId = citation.chunk_id?.trim();
  if (normalizedChunkId) search.set("chunkId", normalizedChunkId);
  if (typeof citation.chunk_index === "number") search.set("chunkIndex", String(citation.chunk_index));
  if (typeof citation.start_ms === "number") search.set("startMs", String(citation.start_ms));
  if (typeof citation.end_ms === "number") search.set("endMs", String(citation.end_ms));

  if (normalizedChunkId) {
    search.set("view", "chunks");
  } else if (typeof citation.start_ms === "number" || typeof citation.end_ms === "number") {
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
  if (mode === "rag_agent_answer") return "Agent 理解回答";
  if (mode === "rag_fused_answer") return "模型融合回答";
  if (mode === "rag_fused_retrieval") return "检索整理回答";
  if (mode === "rag_agent_pending") return "待接入模型增强";
  if (mode === "rag_weak_evidence") return "弱证据谨慎回答";
  if (mode === "rag_source_blocked") return "源内容待补全";
  if (mode === "llm_general_answer") return "通用模型补答";
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
  const ranked = [...items].sort((left, right) => {
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
  const [isStreaming, setIsStreaming] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  const [hasSubmitted, setHasSubmitted] = useState(false);
  const [localMessage, setLocalMessage] = useState("");
  const [savedNoteId, setSavedNoteId] = useState("");
  const [answerQuality, setAnswerQuality] = useState<QualityMeta>({});
  const [answerRetrieval, setAnswerRetrieval] = useState<RetrievalMeta | null>(null);
  const [answerMode, setAnswerMode] = useState<ChatResponse["mode"] | "">("");

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

  const sessionMessages = activeSessionQuery.data?.messages ?? [];
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
    const topScore = typeof answerQuality.top_score === "number" ? answerQuality.top_score.toFixed(1) : "";
    return [
      { label: "回答方式", value: feedbackModeLabel || "处理中" },
      { label: "检索范围", value: feedbackScopeLabel },
      { label: "上下文承接", value: getRetrievalContextLabel(feedbackContext) },
      { label: "当前聚焦", value: getRetrievalFocusLabel(feedbackFocus) },
      { label: "检索路径", value: getRetrievalRouteLabel(feedbackRoutes) },
      { label: "证据命中", value: evidenceCount > 0 ? `${evidenceCount} 条` : "待命中" },
      { label: "补充检索", value: rewriteCount > 0 ? `${rewriteCount} 次` : "原问题直搜" },
      { label: "最高相关", value: topScore || "待计算" },
      { label: "会话上下文", value: contextCount > 0 ? `带入 ${contextCount} 条` : "未引用上文" },
      { label: "可信度", value: answerQuality.grounded === false ? "谨慎参考" : "已结合证据" },
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
    return tags;
  }, [answerQuality.degraded, answerQuality.source, feedbackContext?.follow_up, feedbackFocus?.auto_focused, feedbackRoutes?.content_targets, feedbackRoutes?.hierarchical]);
  const feedbackVariantLabels = useMemo(() => {
    if (feedbackVariants.length <= 1) return [];
    return feedbackVariants.slice(1, 4).map((item) => shortenText(item));
  }, [feedbackVariants]);
  const showFeedbackPanel = Boolean(
    answerQuality.label ||
      answerQuality.summary ||
      feedbackModeLabel ||
      feedbackRoutes ||
      feedbackPaths.length,
  );
  const primaryFeedbackSignals = feedbackSignals.slice(0, 4);
  const secondaryFeedbackSignals = feedbackSignals.slice(4).filter((item) => item.value.trim());
  const primaryContentId = useMemo(
    () => feedbackFocus?.content_id?.trim() || citations[0]?.content_id?.trim() || scopedContentId,
    [citations, feedbackFocus?.content_id, scopedContentId],
  );
  const primaryContentTitle = useMemo(
    () => feedbackFocus?.title?.trim() || citations[0]?.title?.trim() || scopedTitle,
    [citations, feedbackFocus?.title, scopedTitle],
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
        label: answerQuality.degraded || answerQuality.level === "blocked" ? "先看材料详情" : `打开${primaryContentTitle ? "主内容" : "详情页"}`,
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
                <p className="eyebrow">{displayText("当前范围")}</p>
                <h3>{displayText(scopeLabel)}</h3>
              </div>
              <span className="pill">{displayText(activeSessionId ? "继续当前会话" : "准备新对话")}</span>
            </div>
            <div className="qa-scope-summary">
              <span>{displayText(scopedChunkId ? "当前锁定到片段" : scopedContentId ? "当前锁定到单条内容" : "当前在全库问答")}</span>
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
                {displayText("去知识库")}
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
                  {displayText("切回全库")}
                </button>
              )}
            </div>
          </article>

          <article className="card glass-panel qa-sidebar-card">
            <div className="panel-heading">
              <div>
                <p className="eyebrow">{displayText("历史会话")}</p>
                <h3>{displayText("继续之前的记录")}</h3>
              </div>
              <span className="pill">{displayText(`${sessionItems.length} 条`)}</span>
            </div>
            <p className="muted-text">
              {displayText(`历史会话默认只保留 ${sessionsQuery.data?.retention_days ?? 7} 天，过期会自动清理。`)}
            </p>
            {sessionsQuery.isLoading && <p className="muted-text">{displayText("正在读取会话...")}</p>}
            {sessionsQuery.isError && <p className="error-text">{displayText("暂时无法读取会话历史。")}</p>}
            {!sessionsQuery.isLoading && !sessionsQuery.isError && !visibleSessions.length && (
              <p className="muted-text">{displayText("还没有历史会话，直接开始第一轮提问就可以。")}</p>
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
              <p className="eyebrow">{displayText("智能问答")}</p>
              <h2>{displayText(activeSessionQuery.data?.title || "新会话")}</h2>
            </div>
            <div className="pill-row">
              <span className="pill">{displayText(scopeLabel)}</span>
              {feedbackModeLabel && <span className="pill">{displayText(feedbackModeLabel)}</span>}
              {answerQuality.label && <span className="pill">{displayText(answerQuality.label)}</span>}
              {!!citations.length && <span className="pill">{displayText(`${citations.length} 条引用`)}</span>}
            </div>
          </div>

          <div className="qa-message-stream">
            {!conversationMessages.length && (
              <div className="glass-callout qa-empty-stream">
                <strong>{displayText("开始第一轮提问")}</strong>
                <p className="muted-text">{displayText("输入一个具体问题，回答会以连续会话的形式展示在这里。")}</p>
              </div>
            )}

            {showFeedbackPanel && (
              <div className={`qa-quality-banner qa-quality-banner-${qualityBannerTone}`}>
                <div>
                  <strong>{displayText(answerQuality.label || feedbackModeLabel || "本轮回答状态")}</strong>
                  <p>{displayText(answerQuality.summary || "系统已经拿到本轮检索和证据信息，你可以继续追问或先回看主内容。")}</p>
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
                    <strong>{displayText("建议先回看这几个证据片段")}</strong>
                    <p>{displayText("如果你想快速判断这轮回答靠不靠谱，先看这两个命中片段通常最有效。")}</p>
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
                          <Link className="secondary-button button-link" to={detailLink}>
                            {displayText("打开定位")}
                          </Link>
                          {jumpUrl && (
                            <a className="primary-button button-link" href={jumpUrl} target="_blank" rel="noreferrer">
                              {displayText("直接回看")}
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

                  {isAssistant && message.isLive && message.quality?.summary && (
                    <div className="glass-callout">
                      <strong>{displayText(message.quality.label || "回答状态")}</strong>
                      <p className="muted-text">{displayText(message.quality.summary)}</p>
                    </div>
                  )}

                  {isAssistant && !!messageCitations.length && (
                    <details className="qa-citation-disclosure">
                      <summary>{displayText(`查看引用来源（${messageCitations.length}）`)}</summary>
                      <div className="qa-inline-citations">
                        {messageCitations.slice(0, 4).map((citation) => {
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
                                <Link className="secondary-button button-link" to={detailLink}>
                                  {displayText("打开定位")}
                                </Link>
                                {jumpUrl && (
                                  <a className="secondary-button button-link" href={jumpUrl} target="_blank" rel="noreferrer">
                                    {displayText("回到时间点")}
                                  </a>
                                )}
                              </div>
                            </article>
                          );
                        })}
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
                <span>⚠ 当前回答依据较弱，建议补充更多相关内容或换一种问法。</span>
              </div>
            )}
            {savedNoteId && (
              <div className="glass-callout">
                <strong>{displayText("已保存为知识卡片")}</strong>
                <div className="header-actions">
                  <Link className="secondary-button button-link" to={`/library/${savedNoteId}`}>
                    {displayText("打开卡片")}
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

            <textarea
              className="text-area qa-chat-input"
              rows={4}
              placeholder={displayText("输入你的问题")}
              value={composerValue}
              onChange={(event) => setComposerValue(event.target.value)}
              onKeyDown={handleComposerKeyDown}
            />
            <p className="muted-text">{displayText("Enter 发送，Shift + Enter 换行")}</p>
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
                {displayText("复制当前回答")}
              </button>
              <button className="secondary-button" type="button" onClick={handleSaveAnswer} disabled={!answer.trim() || saveNoteMutation.isPending}>
                {saveNoteMutation.isPending ? displayText("保存中...") : displayText("保存知识卡片")}
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
                  <p className="eyebrow">{displayText("本轮思考反馈")}</p>
                  <h3>{displayText(feedbackModeLabel || answerQuality.label || "回答分析")}</h3>
                </div>
              </div>
              <div className="pill-row">
                {answerQuality.label && <span className="pill">{displayText(answerQuality.label)}</span>}
                {feedbackTags.map((tag) => (
                  <span className="pill" key={tag}>{displayText(tag)}</span>
                ))}
              </div>
              {answerQuality.summary && (
                <div className="glass-callout">
                  <strong>{displayText("这轮是怎么得到答案的")}</strong>
                  <p className="muted-text">{displayText(answerQuality.summary)}</p>
                  {answerQuality.recommended_action && <p className="muted-text">{displayText(answerQuality.recommended_action)}</p>}
                </div>
              )}

              {!!qualityActionItems.length && (
                <div className="qa-feedback-section">
                  <p className="eyebrow">{displayText("建议下一步")}</p>
                  <div className="header-actions">
                    {qualityActionItems.map((item) =>
                      item.kind === "link" ? (
                        <Link
                          key={`side-${item.kind}-${item.to}`}
                          className={item.tone === "primary" ? "primary-button button-link" : "secondary-button button-link"}
                          to={item.to}
                        >
                          {displayText(item.label)}
                        </Link>
                      ) : (
                        <button
                          key={`side-${item.kind}-${item.value}`}
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

              {!!secondaryFeedbackSignals.length && (
                <details className="qa-feedback-details">
                  <summary>{displayText("查看细节")}</summary>
                  <div className="qa-feedback-metrics qa-feedback-metrics-secondary">
                    {secondaryFeedbackSignals.map((item) => (
                      <article className="qa-feedback-metric" key={item.label}>
                        <span>{displayText(item.label)}</span>
                        <strong>{displayText(item.value)}</strong>
                      </article>
                    ))}
                  </div>
                </details>
              )}

              {!!feedbackVariantLabels.length && (
                <div className="qa-feedback-section">
                  <p className="eyebrow">{displayText("问题改写")}</p>
                  <div className="pill-row">
                    {feedbackVariantLabels.map((item) => (
                      <span className="pill" key={item}>{displayText(item)}</span>
                    ))}
                  </div>
                </div>
              )}

              {!!feedbackPaths.length && (
                <div className="qa-feedback-section">
                  <p className="eyebrow">{displayText("优先命中的内容")}</p>
                  <div className="qa-feedback-paths">
                    {feedbackPaths.slice(0, 2).map((item) => (
                      <Link className="qa-feedback-link" key={item.content_id} to={`/library/${item.content_id}`}>
                        <strong>{displayText(item.title)}</strong>
                        <small>{displayText(`相关度 ${item.score.toFixed(1)}`)}</small>
                      </Link>
                    ))}
                  </div>
                </div>
              )}

              {(answerQuality.source === "content_capture" || /Cookie|转写|设置页/.test(answerQuality.recommended_action || "")) && (
                <div className="header-actions">
                  <Link className="secondary-button button-link" to="/settings">
                    {displayText("去补全采集能力")}
                  </Link>
                </div>
              )}
            </article>
          ) : (
            <article className="card glass-panel qa-sidebar-card qa-feedback-card">
              <div className="panel-heading">
                <div>
                  <p className="eyebrow">{displayText("本轮思考反馈")}</p>
                  <h3>{displayText("等待第一轮回答")}</h3>
                </div>
              </div>
              <p className="muted-text">
                {displayText("回答生成后，这里会显示检索路径、证据命中、问题改写和优先参考的内容。")}
              </p>
            </article>
          )}
        </aside>
      </div>
    </section>
  );
}
