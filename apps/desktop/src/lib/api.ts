type ViteImportMeta = ImportMeta & {
  env?: {
    VITE_API_BASE_URL?: string;
  };
};

function isTauriRuntime() {
  return typeof window !== "undefined" && Boolean((window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__);
}

function resolveApiBaseUrl() {
  const configuredBaseUrl = (import.meta as ViteImportMeta).env?.VITE_API_BASE_URL?.trim();
  if (configuredBaseUrl) {
    return configuredBaseUrl.replace(/\/$/, "");
  }

  if (isTauriRuntime()) {
    return "http://127.0.0.1:38765";
  }

  return "";
}

export const API_BASE_URL = resolveApiBaseUrl();

async function buildRequestError(response: Response) {
  const fallback = `请求失败：${response.status}`;
  try {
    const payload = (await response.json()) as { detail?: string | { msg?: string }[] };
    if (typeof payload.detail === "string" && payload.detail.trim()) {
      return new Error(payload.detail.trim());
    }
    if (Array.isArray(payload.detail) && payload.detail.length) {
      const first = payload.detail[0];
      if (first && typeof first.msg === "string" && first.msg.trim()) {
        return new Error(first.msg.trim());
      }
    }
  } catch {
    try {
      const text = (await response.text()).trim();
      if (text) {
        return new Error(text);
      }
    } catch {
      return new Error(fallback);
    }
  }
  return new Error(fallback);
}

async function readJson<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${API_BASE_URL}${path}`, {
      headers: {
        "Content-Type": "application/json",
        ...(init?.headers ?? {}),
      },
      ...init,
    });
  } catch {
    throw new Error("后端服务未响应，请检查服务是否已启动");
  }

  if (!response.ok) {
    throw await buildRequestError(response);
  }

  return (await response.json()) as T;
}

export type HealthResponse = {
  status: string;
  service: string;
  version: string;
};

export type SystemStatus = {
  service_status: string;
  knowledge_base_dir: string;
  models: {
    provider?: string;
    provider_ready?: boolean;
    ollama_available: boolean;
    chat_model_ready: boolean;
    embedding_ready: boolean;
    ocr_ready: boolean;
    embedding_model?: string;
    index_embedding_model?: string | null;
    embedding_model_mismatch?: boolean;
  };
  index?: {
    faiss_exists: boolean;
    chunks_count: number;
    needs_rebuild: boolean;
  };
  asr?: {
    selected?: boolean;
    available?: boolean;
    configured?: boolean;
    provider?: string;
    model?: string;
    api_base_url?: string;
    api_key_configured?: boolean;
    config_mode?: string;
    inherited_from_model?: boolean;
    local_runtime_ready?: boolean;
    local_engine?: string;
    runtime_summary?: string;
    summary?: string;
    recommended_action?: string;
    faster_whisper_installed?: boolean;
    openai_whisper_installed?: boolean;
    ffmpeg_available?: boolean;
  };
  database: {
    initialized: boolean;
    path: string;
  };
};

export type ModelStatus = {
  provider?: string;
  provider_ready?: boolean;
  ollama_available: boolean;
  ollama_version: string | null;
  chat_model: string;
  chat_model_ready: boolean;
  embedding_model: string;
  embedding_ready: boolean;
  ocr_ready: boolean;
  installed_models: string[];
};

export type AppSettings = {
  knowledge_base_dir: string;
  export_dir: string;
  log_dir: string;
  model: {
    provider: string;
    chat_model: string;
    embedding_model: string;
    llm_api_base_url?: string;
    llm_api_key_configured?: boolean;
  };
  asr?: {
    selected?: boolean;
    available?: boolean;
    configured?: boolean;
    provider?: string;
    model?: string;
    api_base_url?: string;
    api_key_configured?: boolean;
    config_mode?: string;
    inherited_from_model?: boolean;
    local_runtime_ready?: boolean;
    local_engine?: string;
    runtime_summary?: string;
    summary?: string;
    recommended_action?: string;
    faster_whisper_installed?: boolean;
    openai_whisper_installed?: boolean;
    ffmpeg_available?: boolean;
  };
  bilibili?: {
    browser_bridge_enabled?: boolean;
    browser_bridge_active?: boolean;
    browser_bridge_available?: boolean;
    browser_bridge_source_label?: string;
    browser_bridge_summary?: string;
    browser_bridge_last_seen?: string;
    browser_bridge_expires_at?: string;
    browser_bridge_extension_dir?: string;
    browser_bridge_install_doc?: string;
    cookie_enabled?: boolean;
    cookie_active?: boolean;
    cookie_stored?: boolean;
    cookie_configured?: boolean;
    cookie_source?: string;
    cookie_file?: string;
  };
};

export type SettingsUpdatePayload = {
  model?: {
    provider?: string;
    chat_model?: string;
    embedding_model?: string;
    llm_api_base_url?: string;
    llm_api_key?: string;
  };
  asr?: {
    provider?: string;
    model?: string;
    api_base_url?: string;
    api_key?: string;
  };
  bilibili?: {
    browser_bridge_enabled?: boolean;
    cookie_enabled?: boolean;
    cookie_file?: string;
    cookie_inline?: string;
  };
};

export type BackupResponse = {
  status: string;
  knowledge_base_dir: string;
  archive_path: string;
  created_at: string;
};

export type DiagnosticsExportResponse = {
  ok: boolean;
  path: string;
};

export type OpenBilibiliBridgeHelperResponse = {
  ok: boolean;
  opened: boolean;
  browser: string;
  helper_script: string;
  extension_dir: string;
  docs_dir: string;
  message: string;
};

export type BilibiliProbeResult = {
  platform: string;
  source_url: string;
  source_url_original: string;
  title: string;
  author: string | null;
  parse_mode: string;
  metadata_fetch_errors?: string[];
  bvid: string;
  cid: number;
  page_number: number;
  duration: number | null;
  cover: string | null;
  subtitle_count: number;
  subtitle_available: boolean;
  subtitle_login_required: boolean;
  subtitle_preview_toast: string | null;
  subtitle_error: string | null;
  subtitle_fetch_strategy?: string;
  subtitle_ytdlp_fallback_used?: boolean;
  audio_available: boolean;
  audio_error: string | null;
  audio_fetch_strategy?: string;
  audio_ytdlp_fallback_used?: boolean;
  browser_bridge_enabled?: boolean;
  browser_bridge_active?: boolean;
  browser_bridge_source_label?: string;
  cookie_enabled: boolean;
  cookie_active: boolean;
  cookie_stored: boolean;
  cookie_configured: boolean;
  cookie_source: string;
  asr_configured: boolean;
  asr_selected?: boolean;
  asr_config_mode: string;
  asr_provider: string;
  asr_model: string;
  asr_local_runtime_ready?: boolean;
  asr_local_engine?: string;
  asr_runtime_summary?: string;
  timestamps_available: boolean;
  yt_dlp_available?: boolean;
  predicted_status: string;
  predicted_quality: string;
  predicted_summary: string;
  predicted_recommended_action: string;
};

export type BilibiliProbeResponse = {
  ok: boolean;
  probe: BilibiliProbeResult;
};

export type ModelProbePayload = {
  provider: string;
  chat_model: string;
  api_base_url: string;
  api_key?: string;
};

export type ModelCatalogPayload = {
  provider?: string;
  api_base_url: string;
  api_key?: string;
};

export type ModelProbeResult = {
  ok: boolean;
  provider: string;
  model: string;
  endpoint: string;
  latency_ms: number | null;
  classification: string;
  message: string;
  response_preview: string | null;
  http_status: number | null;
};

export type ModelProbeResponse = {
  ok: boolean;
  probe: ModelProbeResult;
};

export type ModelCatalogResponse = {
  ok: boolean;
  endpoint: string;
  models: string[];
  message: string;
};

export type NoteQualityDimension = {
  score?: number;
  label?: string;
  ready?: boolean;
  applicable?: boolean;
};

export type NoteQuality = {
  score?: number;
  level?: string;
  label?: string;
  summary?: string;
  recommended_action?: string;
  double_note_ready?: boolean;
  time_jump_ready?: boolean;
  retrieval_ready?: boolean;
  question_answer_ready?: boolean;
  refined_note_ready?: boolean;
  raw_evidence_ready?: boolean;
  transcript_segments?: number;
  seek_ready_segments?: number;
  timestamps_estimated?: boolean;
  semantic_score?: number;
  agent_ready?: boolean;
  llm_enhanced?: boolean;
  sort_score?: number;
  dimensions?: Record<string, NoteQualityDimension>;
  source_type?: string;
  platform?: string;
  content_type?: string;
  capture_status?: string;
};

export type ChatCitation = {
  content_id: string;
  chunk_id?: string;
  chunk_index?: number;
  heading?: string | null;
  title: string;
  snippet: string;
  score: number;
  platform?: string | null;
  source_url?: string | null;
  start_ms?: number | null;
  end_ms?: number | null;
  seek_url?: string | null;
};

export type ChatRequestOptions = {
  contentId?: string;
  chunkId?: string;
  sessionId?: string;
};

export type ChatResponse = {
  query: string;
  answer: string;
  citations: ChatCitation[];
  follow_ups?: string[];
  quality?: {
    level?: string;
    label?: string;
    summary?: string;
    recommended_action?: string;
    grounded?: boolean;
    degraded?: boolean;
    citation_count?: number;
    matched_items?: number;
    top_score?: number;
    average_score?: number;
    route_count?: number;
    source?: string;
  };
  retrieval?: {
    query_variants?: string[];
    query_intent?: string;
    routes?: {
      chunk_hits?: number;
      content_hits?: number;
      fused_hits?: number;
      scoped?: boolean;
      hierarchical?: boolean;
      content_targets?: number;
      session_context_used?: number;
    };
    paths?: {
      content_id: string;
      title: string;
      score: number;
    }[];
    focus?: {
      mode?: string;
      auto_focused?: boolean;
      content_id?: string | null;
      title?: string | null;
      matched_count?: number;
      score_share?: number;
    };
    context?: {
      follow_up?: boolean;
      lead_title?: string | null;
      recent_question?: string | null;
    };
  };
  mode: string;
};

export type ChatSessionMessage = {
  id: string;
  role: string;
  message_text: string;
  citations: ChatCitation[];
  created_at: string;
};

export type ChatSessionSummary = {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
  message_count: number;
  last_message: string;
};

export type ChatSessionDetail = {
  id: string;
  title?: string;
  created_at?: string;
  updated_at?: string;
  retention_days?: number;
  messages: ChatSessionMessage[];
};

export type ContentItem = {
  id: string;
  title: string;
  platform: string | null;
  source_type: string | null;
  source_url?: string | null;
  source_file?: string | null;
  summary: string;
  tags: string[];
  category: string;
  cover_url?: string | null;
  parse_mode?: string | null;
  note_style?: string | null;
  collection_id?: string | null;
  created_at: string;
  updated_at: string;
  status: string;
};

export type UrlImportOptions = {
  noteStyle?: string;
  summaryFocus?: string;
  asyncMode?: boolean;
};

export type ContentListResponse = {
  items: ContentItem[];
  total: number;
};

export type TrashContentItem = ContentItem & {
  deleted_at: string;
};

export type TrashListResponse = {
  items: TrashContentItem[];
  total: number;
};

export type ContentChunk = {
  id: string;
  chunk_index: number;
  heading: string | null;
  chunk_text: string;
  summary: string | null;
  metadata: Record<string, unknown>;
};

export type ContentDetail = {
  id: string;
  source_type: string | null;
  platform: string | null;
  source_url: string | null;
  source_file: string | null;
  title: string;
  author: string | null;
  content_text: string;
  summary: string;
  key_points: string[];
  quotes: string[];
  category: string;
  content_type: string | null;
  use_case: string | null;
  tags: string[];
  metadata: Record<string, unknown>;
  chunks: ContentChunk[];
  local_path: string | null;
  status: string;
  created_at: string;
  updated_at: string;
};

export type UpdateContentPayload = {
  title?: string;
  summary?: string;
  category?: string;
  tags?: string[];
  annotations?: Record<number, { highlight: string; note: string }>;
};

export type ReparseContentPayload = {
  note_style?: string;
  summary_focus?: string;
  async_mode?: boolean;
};

export type RestoreNoteVersionPayload = {
  version_id: string;
};

export type UpgradeContentsPayload = {
  platform?: string;
  limit?: number;
  force?: boolean;
  retry_incomplete?: boolean;
  dry_run?: boolean;
};

export type ImportPreview = {
  source_type: string;
  platform: string;
  source_url?: string;
  source_file?: string;
  title: string;
  author?: string | null;
  content_text: string;
  summary: string;
  key_points: string[];
  tags: string[];
  metadata?: Record<string, unknown>;
  content_id?: string;
  status: string;
};

export type ImportJob = {
  id: string;
  source_kind?: string;
  source_value?: string;
  status: string;
  progress: number;
  step: string;
  preview: ImportPreview;
  error_code?: string | null;
  error_message?: string | null;
  created_at?: string;
  updated_at?: string;
  finished_at?: string | null;
};

export type ImportResponse = {
  job: ImportJob;
  content?: {
    id: string;
    title: string;
    summary: string;
    tags: string[];
    status: string;
  } | null;
};

export type ActionContentResponse = {
  ok: boolean;
  content: ContentDetail;
  message: string;
};

export type ReparseContentResponse = {
  ok: boolean;
  content?: ContentDetail | null;
  job?: ImportJob | null;
  message: string;
};

export type ChatSessionActionResponse = {
  ok: boolean;
  session: ChatSessionDetail & { auto_switched?: boolean };
  message: string;
};

export type UpgradeContentsResponse = {
  ok: boolean;
  summary: {
    platform?: string | null;
    scanned: number;
    targeted: number;
    upgraded: number;
    repaired: number;
    reimported: number;
    fallback_repaired: number;
    skipped: number;
    failed: number;
    duplicate_groups?: number;
    duplicates_archived?: number;
    dry_run: boolean;
    limit: number;
  };
  items: {
    content_id: string;
    title: string;
    action: string;
    reasons: string[];
    message: string;
  }[];
  message: string;
};

export type EmptyTrashResponse = {
  ok: boolean;
  deleted: number;
  message: string;
};

function shortTimeout() {
  return AbortSignal.timeout(5000);
}

export function getHealth() {
  return readJson<HealthResponse>("/api/v1/health", { signal: shortTimeout() });
}

export function getSystemStatus() {
  return readJson<SystemStatus>("/api/v1/system/status", { signal: shortTimeout() });
}

export function getModelStatus() {
  return readJson<ModelStatus>("/api/v1/models/status", { signal: shortTimeout() });
}

export function getSettings() {
  return readJson<AppSettings>("/api/v1/settings", { signal: shortTimeout() });
}

export function updateSettings(payload: SettingsUpdatePayload) {
  return readJson<AppSettings>("/api/v1/settings", {
    method: "PUT",
    body: JSON.stringify(payload),
  });
}

export function getContents(query?: string, collectionId?: string | null) {
  const params = new URLSearchParams();
  if (query?.trim()) params.set("q", query.trim());
  if (collectionId) params.set("collection_id", collectionId);
  const search = params.toString() ? `?${params.toString()}` : "";
  return readJson<ContentListResponse>(`/api/v1/contents${search}`);
}

export function getTrashContents() {
  return readJson<TrashListResponse>("/api/v1/contents/trash/list");
}

export function emptyTrash() {
  return readJson<EmptyTrashResponse>("/api/v1/contents/trash/empty", {
    method: "POST",
  });
}

export function permanentDeleteContent(contentId: string) {
  return readJson<{ deleted: boolean; id: string }>(`/api/v1/contents/${contentId}/permanent`, {
    method: "DELETE",
  });
}

export function getContent(contentId: string) {
  return readJson<ContentDetail>(`/api/v1/contents/${contentId}`);
}

export function updateContent(contentId: string, payload: UpdateContentPayload) {
  return readJson<ContentDetail>(`/api/v1/contents/${contentId}`, {
    method: "PATCH",
    body: JSON.stringify(payload),
  });
}

export function reparseContent(contentId: string, payload?: ReparseContentPayload) {
  return readJson<ReparseContentResponse>(`/api/v1/contents/${contentId}/reparse`, {
    method: "POST",
    body: JSON.stringify(payload ?? {}),
  });
}

export function restoreNoteVersion(contentId: string, payload: RestoreNoteVersionPayload) {
  return readJson<ActionContentResponse>(`/api/v1/contents/${contentId}/restore-note-version`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function upgradeContents(payload?: UpgradeContentsPayload) {
  return readJson<UpgradeContentsResponse>("/api/v1/contents/maintenance/upgrade", {
    method: "POST",
    body: JSON.stringify(payload ?? {}),
  });
}

export function deleteContent(contentId: string) {
  return readJson<{ deleted: boolean; id: string }>(`/api/v1/contents/${contentId}`, {
    method: "DELETE",
  });
}

export function restoreContent(contentId: string) {
  return readJson<{ restored: boolean; id: string }>(`/api/v1/contents/${contentId}/restore`, {
    method: "POST",
  });
}

export function initSamples() {
  return readJson<{ ok: boolean; inserted: number; message: string }>("/api/v1/system/init-samples", {
    method: "POST",
  });
}

export function triggerReindex() {
  return readJson<{ ok: boolean; chunks_count: number; message: string }>("/api/v1/system/reindex", {
    method: "POST",
  });
}

export type DedupeResult = {
  ok: boolean;
  dry_run: boolean;
  duplicate_groups: number;
  duplicates_archived: number;
  items: { duplicate_id: string; duplicate_title: string; kept_id: string; kept_title: string; source_key: string }[];
};

export function dedupeContents() {
  return readJson<DedupeResult>("/api/v1/system/dedupe-contents", { method: "POST" });
}

export function dedupeContentsPreview() {
  return readJson<DedupeResult>("/api/v1/system/dedupe-contents?dry_run=true", { method: "POST" });
}

export function getBilibiliStatus() {
  return readJson<{
    browser_bridge_enabled: boolean;
    browser_bridge_active: boolean;
    browser_bridge_available: boolean;
    browser_bridge_source_label: string;
    browser_bridge_summary: string;
    browser_bridge_last_seen: string;
    browser_bridge_expires_at: string;
    cookie_configured: boolean;
    cookie_enabled: boolean;
    cookie_active: boolean;
    cookie_source: string;
  }>(
    "/api/v1/system/bilibili-status",
  );
}

export function openBilibiliBridgeHelper() {
  return readJson<OpenBilibiliBridgeHelperResponse>("/api/v1/settings/bilibili/helper/open", {
    method: "POST",
    body: JSON.stringify({ browser: "auto" }),
  });
}

export function reindexContent(contentId: string) {
  return readJson<{ ok: boolean; chunks_count: number; message: string }>(
    `/api/v1/contents/${contentId}/reindex`,
    { method: "POST" },
  );
}

export function retryImportJob(jobId: string) {
  return readJson<{ job: ImportJob; content: null }>(
    `/api/v1/imports/${jobId}/retry`,
    { method: "POST" },
  );
}

export function exportContentMarkdown(contentId: string, options?: { includeAnnotations?: boolean }) {
  const params = options?.includeAnnotations ? "?include_annotations=true" : "";
  return readJson<{ ok: boolean; content_id: string; path: string }>(
    `/api/v1/contents/${contentId}/export-markdown${params}`,
    {
      method: "POST",
    },
  );
}

export function createBackup() {
  return readJson<BackupResponse>("/api/v1/backups", {
    method: "POST",
  });
}

export function exportDiagnostics() {
  return readJson<DiagnosticsExportResponse>("/api/v1/diagnostics/export", {
    method: "POST",
  });
}

export function probeBilibiliUrl(url: string) {
  return readJson<BilibiliProbeResponse>("/api/v1/diagnostics/bilibili-probe", {
    method: "POST",
    body: JSON.stringify({ url }),
  });
}

export function probeModelConnection(payload: ModelProbePayload) {
  return readJson<ModelProbeResponse>("/api/v1/diagnostics/model-probe", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function fetchModelCatalog(payload: ModelCatalogPayload) {
  return readJson<ModelCatalogResponse>("/api/v1/models/catalog", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function chatOnce(query: string, options?: ChatRequestOptions) {
  return readJson<ChatResponse>("/api/v1/chat", {
    method: "POST",
    body: JSON.stringify({
      query,
      content_id: options?.contentId,
      chunk_id: options?.chunkId,
      session_id: options?.sessionId,
    }),
  });
}

export function saveChatNote(payload: {
  question: string;
  answer: string;
  citations: ChatCitation[];
  title?: string;
  contentId?: string;
  chunkId?: string;
}) {
  return readJson<ActionContentResponse>("/api/v1/chat/save-note", {
    method: "POST",
    body: JSON.stringify({
      question: payload.question,
      answer: payload.answer,
      citations: payload.citations,
      title: payload.title,
      content_id: payload.contentId,
      chunk_id: payload.chunkId,
    }),
  });
}

export async function streamChat(
  query: string,
  handlers: {
    onChunk?: (chunk: string) => void;
    onDone?: (payload: {
      citations: ChatCitation[];
      followUps: string[];
      quality?: ChatResponse["quality"];
      retrieval?: {
        query_variants?: string[];
        query_intent?: string;
        routes?: {
          chunk_hits?: number;
          content_hits?: number;
          fused_hits?: number;
          scoped?: boolean;
          hierarchical?: boolean;
          content_targets?: number;
          session_context_used?: number;
        };
        paths?: {
          content_id: string;
          title: string;
          score: number;
        }[];
        focus?: {
          mode?: string;
          auto_focused?: boolean;
          content_id?: string | null;
          title?: string | null;
          matched_count?: number;
          score_share?: number;
        };
        context?: {
          follow_up?: boolean;
          lead_title?: string | null;
          recent_question?: string | null;
        };
      };
    }) => void;
    onMeta?: (meta: Record<string, unknown>) => void;
  },
  options?: ChatRequestOptions,
) {
  const response = await fetch(`${API_BASE_URL}/api/v1/chat/stream`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      query,
      content_id: options?.contentId,
      chunk_id: options?.chunkId,
      session_id: options?.sessionId,
    }),
  });

  if (!response.ok) {
    throw await buildRequestError(response);
  }

  if (!response.body) {
    throw new Error("当前没有收到可用响应。");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    const events = buffer.split("\n\n");
    buffer = events.pop() ?? "";

    for (const eventBlock of events) {
      const lines = eventBlock.split("\n");
      const eventLine = lines.find((line) => line.startsWith("event:"));
      const dataLine = lines.find((line) => line.startsWith("data:"));

      if (!eventLine || !dataLine) {
        continue;
      }

      const eventType = eventLine.replace("event:", "").trim();
      const payload = JSON.parse(dataLine.replace("data:", "").trim()) as Record<string, unknown>;

      if (eventType === "meta") {
        handlers.onMeta?.(payload);
      }

      if (eventType === "message") {
        handlers.onChunk?.(String(payload.chunk ?? ""));
      }

      if (eventType === "error") {
        const errMsg = String(payload.message ?? "模型服务暂时不可用，请稍后重试。");
        throw new Error(errMsg);
      }

      if (eventType === "done") {
        handlers.onDone?.({
          citations: (payload.citations as ChatCitation[] | undefined) ?? [],
          followUps: (payload.follow_ups as string[] | undefined) ?? [],
          quality: payload.quality as ChatResponse["quality"] | undefined,
          retrieval: payload.retrieval as {
            query_variants?: string[];
            query_intent?: string;
            routes?: {
              chunk_hits?: number;
              content_hits?: number;
              fused_hits?: number;
              scoped?: boolean;
              hierarchical?: boolean;
              content_targets?: number;
              session_context_used?: number;
            };
            paths?: {
              content_id: string;
              title: string;
              score: number;
            }[];
            focus?: {
              mode?: string;
              auto_focused?: boolean;
              content_id?: string | null;
              title?: string | null;
              matched_count?: number;
              score_share?: number;
            };
            context?: {
              follow_up?: boolean;
              lead_title?: string | null;
              recent_question?: string | null;
            };
          } | undefined,
        });
      }
    }
  }
}

export function listChatSessions() {
  return readJson<{ items: ChatSessionSummary[]; total: number; retention_days?: number }>("/api/v1/chat/sessions");
}

export function getChatSession(sessionId: string) {
  return readJson<ChatSessionDetail>(`/api/v1/chat/sessions/${sessionId}`);
}

export function deleteChatSession(sessionId: string) {
  return readJson<{ deleted: boolean; id: string }>(`/api/v1/chat/sessions/${sessionId}`, {
    method: "DELETE",
  });
}

export function saveChatTurn(payload: {
  question: string;
  answer: string;
  citations: ChatCitation[];
  sessionId?: string;
}) {
  return readJson<ChatSessionActionResponse>("/api/v1/chat/sessions/turn", {
    method: "POST",
    body: JSON.stringify({
      question: payload.question,
      answer: payload.answer,
      citations: payload.citations,
      session_id: payload.sessionId,
    }),
  });
}

export function createUrlImport(url: string, options?: UrlImportOptions) {
  return readJson<ImportResponse>("/api/v1/imports/url", {
    method: "POST",
    body: JSON.stringify({
      url,
      note_style: options?.noteStyle ?? "structured",
      summary_focus: options?.summaryFocus ?? "",
      async_mode: options?.asyncMode ?? false,
    }),
  });
}

export type ImportJobListResponse = {
  items: ImportJob[];
  total: number;
  pending_count: number;
};

export function listImportJobs(status?: string) {
  const url = status ? `/api/v1/imports?status=${encodeURIComponent(status)}` : "/api/v1/imports";
  return readJson<ImportJobListResponse>(url);
}

export function getImportJob(jobId: string) {
  return readJson<ImportJob>(`/api/v1/imports/${jobId}`);
}

export function createFileImport(filePath: string, options?: { asyncMode?: boolean }) {
  return readJson<ImportResponse>("/api/v1/imports/file", {
    method: "POST",
    body: JSON.stringify({
      file_path: filePath,
      async_mode: options?.asyncMode ?? false,
    }),
  });
}

function arrayBufferToBase64(buffer: ArrayBuffer) {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = "";

  for (let index = 0; index < bytes.length; index += chunkSize) {
    const chunk = bytes.slice(index, index + chunkSize);
    binary += String.fromCharCode(...chunk);
  }

  return btoa(binary);
}

export async function uploadFileImport(file: File, options?: { asyncMode?: boolean }) {
  const contentBase64 = arrayBufferToBase64(await file.arrayBuffer());

  return readJson<ImportResponse>("/api/v1/imports/file-upload", {
    method: "POST",
    body: JSON.stringify({
      filename: file.name,
      content_base64: contentBase64,
      async_mode: options?.asyncMode ?? false,
    }),
  });
}

// ------------------------------------------------------------------ //
// Collections                                                          //
// ------------------------------------------------------------------ //

export type Collection = {
  id: string;
  name: string;
  description: string;
  color: string;
  icon: string;
  created_at: string;
  updated_at: string;
};

export type CollectionListResponse = {
  items: Collection[];
  total: number;
};

export function listCollections() {
  return readJson<CollectionListResponse>("/api/v1/collections");
}

export function createCollection(payload: { name: string; description?: string; color?: string; icon?: string }) {
  return readJson<Collection>("/api/v1/collections", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function updateCollection(collectionId: string, payload: { name?: string; description?: string; color?: string; icon?: string }) {
  return readJson<Collection>(`/api/v1/collections/${collectionId}`, {
    method: "PATCH",
    body: JSON.stringify(payload),
  });
}

export function deleteCollection(collectionId: string) {
  return readJson<{ deleted: boolean; id: string }>(`/api/v1/collections/${collectionId}`, {
    method: "DELETE",
  });
}

export function assignContentCollection(contentId: string, collectionId: string | null) {
  return readJson<{ ok: boolean; content_id: string; collection_id: string | null }>(
    `/api/v1/collections/assign/${contentId}`,
    {
      method: "POST",
      body: JSON.stringify({ collection_id: collectionId }),
    },
  );
}

// ------------------------------------------------------------------ //
// Derive (mindmap / quiz)                                              //
// ------------------------------------------------------------------ //

export type DerivedItem = {
  id: string;
  content_id: string;
  kind: "mindmap" | "quiz" | string;
  title: string;
  data: Record<string, unknown>;
  status: string;
  error_message?: string | null;
  created_at: string;
  updated_at: string;
};

export type DeriveResponse = {
  ok: boolean;
  item: DerivedItem;
  cached: boolean;
};

export function listDerivedItems(contentId: string) {
  return readJson<{ items: DerivedItem[]; total: number }>(`/api/v1/derive/${contentId}`);
}

export function generateMindmap(contentId: string) {
  return readJson<DeriveResponse>(`/api/v1/derive/${contentId}/mindmap`, { method: "POST" });
}

export function generateQuiz(contentId: string) {
  return readJson<DeriveResponse>(`/api/v1/derive/${contentId}/quiz`, { method: "POST" });
}

export function deleteDerivedItem(itemId: string) {
  return readJson<{ deleted: boolean; id: string }>(`/api/v1/derive/items/${itemId}`, {
    method: "DELETE",
  });
}

export async function exportDerivedItem(itemId: string): Promise<string> {
  const resp = await fetch(`${API_BASE_URL}/api/v1/derive/items/${itemId}/export-markdown`);
  if (!resp.ok) throw new Error(`导出失败：${resp.status}`);
  return resp.text();
}
