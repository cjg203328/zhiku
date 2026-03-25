import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import {
  createBackup,
  dedupeContents,
  dedupeContentsPreview,
  type DedupeResult,
  exportDiagnostics,
  fetchModelCatalog,
  getBilibiliStatus,
  getModelStatus,
  getSettings,
  getSystemStatus,
  openBilibiliBridgeHelper,
  probeModelConnection,
  triggerReindex,
  updateSettings,
  type ModelProbeResult,
  type ModelStatus,
} from "../lib/api";
import { useLanguage } from "../lib/language";

const OPENAI_COMPAT_PROVIDER = "openai_compatible";
const DEFAULT_EMBEDDING_MODEL = "bge-m3";
const DEFAULT_REMOTE_ASR_MODEL = "whisper-1";
const DEFAULT_LOCAL_ASR_MODEL = "small";
const MODEL_PROFILE_STORAGE_KEY = "zhiku:model-profiles:v1";
const MODEL_PROFILE_EXPORT_TYPE = "zhiku_model_profile";
const DEFAULT_OPENAI_COMPAT_API_PATH = "/v1";

const PROVIDER_PRESETS = [
  {
    id: "ollama",
    label: "Ollama",
    description: "本机模型",
    hint: "本地已安装 Ollama 后即可读取模型。",
    chatModel: "qwen2.5:7b",
    chatOptions: ["qwen2.5:7b", "qwen2.5:14b", "llama3.2:3b", "deepseek-r1:7b"],
    embeddingModel: "bge-m3",
    baseUrl: "http://localhost:11434/v1",
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    description: "远端 API",
    hint: "本地只负责发起请求；填写 Key 后可读取模型列表。",
    chatModel: "deepseek-chat",
    chatOptions: ["deepseek-chat", "deepseek-reasoner"],
    embeddingModel: DEFAULT_EMBEDDING_MODEL,
    baseUrl: "https://api.deepseek.com/v1",
  },
  {
    id: "moonshot",
    label: "Moonshot",
    description: "远端 API",
    hint: "本地只负责发起请求；填写 Key 后可读取模型列表。",
    chatModel: "kimi-latest",
    chatOptions: ["kimi-latest"],
    embeddingModel: DEFAULT_EMBEDDING_MODEL,
    baseUrl: "https://api.moonshot.cn/v1",
  },
  {
    id: "zhipu",
    label: "智谱",
    description: "远端 API",
    hint: "支持按厂商接入；本地只作为客户端调用远端模型。",
    chatModel: "glm-4-flash-250414",
    chatOptions: ["glm-4-flash-250414"],
    embeddingModel: DEFAULT_EMBEDDING_MODEL,
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
  },
  {
    id: "custom",
    label: "自定义",
    description: "OpenAI 兼容",
    hint: "适合填写你自己的 GPT-5.4 网关、主机地址或 OpenAI 兼容平台。",
    chatModel: "",
    chatOptions: [],
    embeddingModel: DEFAULT_EMBEDDING_MODEL,
    baseUrl: "",
  },
] as const;

const MODEL_PARTICIPATION_OPTIONS = [
  {
    id: "budget",
    label: "省 token",
    summary: "检索优先",
    description: "复杂问题再让模型接手。",
  },
  {
    id: "balanced",
    label: "平衡",
    summary: "默认推荐",
    description: "简单问题负责整理，复杂问题负责最终答案。",
  },
  {
    id: "intensive",
    label: "高智能",
    summary: "模型更主动",
    description: "更积极参与整理、判断和补答。",
  },
] as const;

type ModelParticipationMode = (typeof MODEL_PARTICIPATION_OPTIONS)[number]["id"];

function normalizeParticipationMode(value?: string): ModelParticipationMode {
  if (value === "budget" || value === "balanced" || value === "intensive") return value;
  return "balanced";
}

function getParticipationModeLabel(value?: string) {
  return MODEL_PARTICIPATION_OPTIONS.find((item) => item.id === normalizeParticipationMode(value))?.label || "平衡";
}

type ProviderPreset = (typeof PROVIDER_PRESETS)[number];
type ProviderId = ProviderPreset["id"];
type AsrModeChoice = "shared" | "dedicated" | "local";
type ModelConfigProfile = {
  id: string;
  name: string;
  providerId: ProviderId;
  apiHost: string;
  apiPath: string;
  apiKey: string;
  chatModel: string;
  embeddingModel: string;
  createdAt: string;
  updatedAt: string;
};

function mapAsrModeChoice(configMode?: string): AsrModeChoice {
  if (configMode === "local") return "local";
  if (configMode === "explicit" || configMode === "hybrid") return "dedicated";
  return "shared";
}

function getAsrModeLabel(configMode?: string) {
  if (configMode === "local") return "本地转写";
  if (configMode === "inherited") return "复用主模型";
  if (configMode === "hybrid") return "混合模式";
  if (configMode === "explicit") return "独立接口";
  return "未启用";
}

function getAsrChoiceLabel(mode: AsrModeChoice) {
  if (mode === "local") return "本地转写";
  if (mode === "dedicated") return "独立接口";
  return "复用主模型";
}

function uniqueValues(values: Array<string | null | undefined>) {
  return Array.from(
    new Set(
      values
        .map((item) => item?.trim())
        .filter((item): item is string => Boolean(item)),
    ),
  );
}

function normalizeOpenAiCompatibleBaseUrl(baseUrl: string) {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  if (!trimmed) return "";
  return trimmed.replace(
    /\/(?:chat\/completions|responses|models|embeddings|audio\/transcriptions)$/i,
    "",
  );
}

function createModelProfileId() {
  return `profile_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function isProviderId(value: string): value is ProviderId {
  return PROVIDER_PRESETS.some((preset) => preset.id === value);
}

function sanitizeModelProfile(value: unknown): ModelConfigProfile | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const providerValue = typeof record.providerId === "string" && isProviderId(record.providerId) ? record.providerId : "custom";
  const name = typeof record.name === "string" ? record.name.trim() : "";
  if (!name) return null;
  return {
    id: typeof record.id === "string" && record.id.trim() ? record.id.trim() : createModelProfileId(),
    name,
    providerId: providerValue,
    apiHost: typeof record.apiHost === "string" ? record.apiHost.trim() : "",
    apiPath: typeof record.apiPath === "string" ? normalizeApiPath(record.apiPath) : "",
    apiKey: typeof record.apiKey === "string" ? record.apiKey.trim() : "",
    chatModel: typeof record.chatModel === "string" ? record.chatModel.trim() : "",
    embeddingModel:
      typeof record.embeddingModel === "string" && record.embeddingModel.trim()
        ? record.embeddingModel.trim()
        : DEFAULT_EMBEDDING_MODEL,
    createdAt: typeof record.createdAt === "string" && record.createdAt.trim() ? record.createdAt.trim() : new Date().toISOString(),
    updatedAt: typeof record.updatedAt === "string" && record.updatedAt.trim() ? record.updatedAt.trim() : new Date().toISOString(),
  };
}

function readStoredModelProfiles() {
  if (typeof window === "undefined") return [] as ModelConfigProfile[];
  try {
    const raw = window.localStorage.getItem(MODEL_PROFILE_STORAGE_KEY);
    if (!raw) return [] as ModelConfigProfile[];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [] as ModelConfigProfile[];
    return parsed
      .map((item) => sanitizeModelProfile(item))
      .filter((item): item is ModelConfigProfile => Boolean(item))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  } catch {
    return [] as ModelConfigProfile[];
  }
}

function writeStoredModelProfiles(profiles: ModelConfigProfile[]) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(MODEL_PROFILE_STORAGE_KEY, JSON.stringify(profiles));
}

function splitOpenAiCompatibleBaseUrl(baseUrl: string) {
  const normalized = normalizeOpenAiCompatibleBaseUrl(baseUrl);
  if (!normalized) {
    return {
      apiHost: "",
      apiPath: "",
    };
  }

  try {
    const url = new URL(normalized);
    return {
      apiHost: `${url.protocol}//${url.host}`,
      apiPath: url.pathname === "/" ? "" : url.pathname.replace(/\/+$/, ""),
    };
  } catch {
    return {
      apiHost: normalized,
      apiPath: "",
    };
  }
}

function normalizeApiPath(apiPath: string) {
  const trimmed = apiPath.trim();
  if (!trimmed) return "";
  const normalized = trimmed.replace(/\/+$/, "");
  return normalized.startsWith("/") ? normalized : `/${normalized.replace(/^\/+/, "")}`;
}

function joinOpenAiCompatibleBaseUrl(apiHost: string, apiPath: string) {
  const trimmedHost = apiHost.trim();
  if (!trimmedHost) return "";

  if (/^https?:\/\//i.test(trimmedHost) && !apiPath.trim()) {
    return normalizeOpenAiCompatibleBaseUrl(trimmedHost);
  }

  const normalizedHost = trimmedHost.replace(/\/+$/, "");
  const normalizedPath = normalizeApiPath(apiPath);
  return `${normalizedHost}${normalizedPath}`;
}

function extractOpenAiCompatiblePathFromHost(apiHost: string) {
  const trimmedHost = apiHost.trim();
  if (!trimmedHost || !/^https?:\/\//i.test(trimmedHost)) return "";
  try {
    const normalized = new URL(normalizeOpenAiCompatibleBaseUrl(trimmedHost));
    const normalizedPath = normalized.pathname.replace(/\/+$/, "");
    return normalizedPath && normalizedPath !== "/" ? normalizedPath : "";
  } catch {
    return "";
  }
}

function resolveProviderApiDraft(providerId: ProviderId, apiHost: string, apiPath: string) {
  const normalizedPath = normalizeApiPath(apiPath);
  const embeddedPath = extractOpenAiCompatiblePathFromHost(apiHost);
  const autoAppliedPath =
    providerId === "custom" &&
    isRemoteApiProvider(providerId) &&
    Boolean(apiHost.trim()) &&
    !normalizedPath &&
    !embeddedPath;
  const effectivePath = normalizedPath || (autoAppliedPath ? DEFAULT_OPENAI_COMPAT_API_PATH : "");
  return {
    effectivePath,
    baseUrl: joinOpenAiCompatibleBaseUrl(apiHost, effectivePath),
    autoAppliedPath,
  };
}

function pickImportedString(record: Record<string, unknown>, ...keys: string[]) {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function parseImportedModelProfile(text: string) {
  const parsed = JSON.parse(text) as unknown;
  const source =
    parsed && typeof parsed === "object" && "profile" in parsed && parsed.profile && typeof parsed.profile === "object"
      ? (parsed.profile as Record<string, unknown>)
      : parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : null;

  if (!source) {
    throw new Error("配置 JSON 无法识别，请检查格式。");
  }

  const providerValue = pickImportedString(source, "providerId", "provider");
  const providerId = isProviderId(providerValue) ? providerValue : "custom";
  const apiHost = pickImportedString(source, "apiHost", "api_host", "host");
  const apiPath = pickImportedString(source, "apiPath", "api_path", "path");
  const chatModel = pickImportedString(source, "chatModel", "chat_model", "model");
  const embeddingModel =
    pickImportedString(source, "embeddingModel", "embedding_model") || DEFAULT_EMBEDDING_MODEL;
  const apiKey = pickImportedString(source, "apiKey", "api_key");
  const name = pickImportedString(source, "name", "profileName", "profile_name");

  if (!apiHost && !chatModel) {
    throw new Error("导入的配置至少需要包含 API Host 或聊天模型名。");
  }

  return {
    name,
    providerId,
    apiHost,
    apiPath: normalizeApiPath(apiPath),
    apiKey,
    chatModel,
    embeddingModel,
  };
}

function resolveOpenAiCompatibleEndpoint(baseUrl: string, target: "chat" | "models") {
  const normalized = normalizeOpenAiCompatibleBaseUrl(baseUrl);
  if (!normalized) return "";
  return `${normalized}/${target === "chat" ? "chat/completions" : "models"}`;
}

function findMatchingPreset(baseUrl: string, chatModel: string): ProviderPreset | null {
  const normalizedBaseUrl = baseUrl.trim().replace(/\/$/, "").toLowerCase();
  const normalizedChatModel = chatModel.trim().toLowerCase();
  return (
    PROVIDER_PRESETS.find((preset) => {
      if (preset.id === "custom") return false;
      const presetBaseUrl = preset.baseUrl.replace(/\/$/, "").toLowerCase();
      return presetBaseUrl === normalizedBaseUrl || preset.chatModel.toLowerCase() === normalizedChatModel;
    }) ?? null
  );
}

function isKnownPreset(providerId: ProviderId) {
  return providerId !== "custom";
}

function isRemoteApiProvider(providerId: ProviderId) {
  return providerId !== "ollama";
}

export default function SettingsPage() {
  const { displayText } = useLanguage();
  const queryClient = useQueryClient();
  const [searchParams] = useSearchParams();
  const modelSectionRef = useRef<HTMLElement | null>(null);
  const asrSectionRef = useRef<HTMLElement | null>(null);
  const bilibiliSectionRef = useRef<HTMLElement | null>(null);
  const pageTopRef = useRef<HTMLDivElement | null>(null);

  const settingsQuery = useQuery({
    queryKey: ["settings"],
    queryFn: getSettings,
    retry: 1,
  });

  const statusQuery = useQuery({ queryKey: ["system-status"], queryFn: getSystemStatus, retry: 1 });
  const bilibiliStatusQuery = useQuery({ queryKey: ["bilibili-status"], queryFn: getBilibiliStatus, retry: 1 });

  const backupMutation = useMutation({ mutationFn: createBackup });
  const diagnosticsMutation = useMutation({ mutationFn: exportDiagnostics });
  const modelCatalogMutation = useMutation({ mutationFn: fetchModelCatalog });
  const modelProbeMutation = useMutation({ mutationFn: probeModelConnection });
  const openBilibiliHelperMutation = useMutation({
    mutationFn: openBilibiliBridgeHelper,
    onSuccess: (result) => {
      setLocalMessage(result.message || "已为你打开浏览器扩展页和小助手目录。");
    },
  });
  const reindexMutation = useMutation({
    mutationFn: triggerReindex,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["system-status"] });
      setLocalMessage("索引重建已触发，后台执行中，稍后刷新状态即可。");
    },
  });
  const dedupePreviewMutation = useMutation({
    mutationFn: dedupeContentsPreview,
    onSuccess: (result) => setDedupePreview(result),
  });
  const dedupeMutation = useMutation({
    mutationFn: dedupeContents,
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: ["contents"] });
      void queryClient.invalidateQueries({ queryKey: ["trash"] });
      setDedupePreview(null);
      const msg = result.duplicates_archived > 0
        ? `已将 ${result.duplicates_archived} 条重复内容移至回收站（${result.duplicate_groups} 组）。`
        : "没有发现重复内容。";
      setLocalMessage(msg);
    },
  });
  const saveMutation = useMutation({
    mutationFn: updateSettings,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["settings"] });
      await queryClient.invalidateQueries({ queryKey: ["system-status"] });
      await queryClient.invalidateQueries({ queryKey: ["bilibili-status"] });
      setLocalMessage("配置已保存。");
      pageTopRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    },
  });

  const [localMessage, setLocalMessage] = useState("");
  const [providerId, setProviderId] = useState<ProviderId>("custom");
  const [chatModel, setChatModel] = useState("");
  const [embeddingModel, setEmbeddingModel] = useState(DEFAULT_EMBEDDING_MODEL);
  const [modelParticipationMode, setModelParticipationMode] = useState<ModelParticipationMode>("balanced");
  const [apiHost, setApiHost] = useState("");
  const [apiPath, setApiPath] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [savedModelProfiles, setSavedModelProfiles] = useState<ModelConfigProfile[]>([]);
  const [profileDraftName, setProfileDraftName] = useState("");
  const [profileJsonDraft, setProfileJsonDraft] = useState("");
  const [asrModeChoice, setAsrModeChoice] = useState<AsrModeChoice>("shared");
  const [asrModel, setAsrModel] = useState(DEFAULT_LOCAL_ASR_MODEL);
  const [asrBaseUrl, setAsrBaseUrl] = useState("");
  const [asrApiKey, setAsrApiKey] = useState("");
  const [browserBridgeEnabled, setBrowserBridgeEnabled] = useState(true);
  const [cookieEnabled, setCookieEnabled] = useState(false);
  const [cookieFile, setCookieFile] = useState("");
  const [cookieInline, setCookieInline] = useState("");
  const [dedupePreview, setDedupePreview] = useState<DedupeResult | null>(null);
  useEffect(() => {
    if (!settingsQuery.data) return;
    const matchedPreset = findMatchingPreset(
      settingsQuery.data.model.llm_api_base_url || "",
      settingsQuery.data.model.chat_model || "",
    );
    setProviderId(matchedPreset?.id ?? "custom");
    setChatModel(settingsQuery.data.model.chat_model || "");
    setEmbeddingModel(settingsQuery.data.model.embedding_model || DEFAULT_EMBEDDING_MODEL);
    setModelParticipationMode(normalizeParticipationMode(settingsQuery.data.model.participation_mode));
    const nextBaseUrl = settingsQuery.data.model.llm_api_base_url || "";
    const { apiHost: nextApiHost, apiPath: nextApiPath } = splitOpenAiCompatibleBaseUrl(nextBaseUrl);
    setApiHost(nextApiHost);
    setApiPath(nextApiPath);
    setApiKey("");
    setAsrModeChoice(mapAsrModeChoice(settingsQuery.data.asr?.config_mode));
    setAsrModel(settingsQuery.data.asr?.model || DEFAULT_LOCAL_ASR_MODEL);
    setAsrBaseUrl(settingsQuery.data.asr?.api_base_url || nextBaseUrl);
    setAsrApiKey("");
    setBrowserBridgeEnabled(Boolean(settingsQuery.data.bilibili?.browser_bridge_enabled ?? true));
    setCookieEnabled(Boolean(settingsQuery.data.bilibili?.cookie_enabled));
    setCookieFile(settingsQuery.data.bilibili?.cookie_file || "");
    setCookieInline("");
  }, [settingsQuery.data]);

  useEffect(() => {
    setSavedModelProfiles(readStoredModelProfiles());
  }, []);

  const resolvedApiDraft = useMemo(
    () => resolveProviderApiDraft(providerId, apiHost, apiPath),
    [apiHost, apiPath, providerId],
  );
  const effectiveBaseUrl = resolvedApiDraft.baseUrl;
  const effectiveApiPath = resolvedApiDraft.effectivePath;
  const customProviderAutoPathActive = resolvedApiDraft.autoAppliedPath;

  useEffect(() => {
    modelCatalogMutation.reset();
    modelProbeMutation.reset();
  }, [apiKey, effectiveBaseUrl]);

  const activePreset = useMemo(
    () => PROVIDER_PRESETS.find((item) => item.id === providerId) ?? PROVIDER_PRESETS[PROVIDER_PRESETS.length - 1],
    [providerId],
  );
  const detectedPreset = useMemo(() => findMatchingPreset(effectiveBaseUrl, chatModel), [effectiveBaseUrl, chatModel]);
  const modelKeyConfigured = Boolean(settingsQuery.data?.model.llm_api_key_configured);
  const modelCatalog = modelCatalogMutation.data?.models ?? [];
  const modelCatalogUsesSavedKey = !apiKey.trim() && modelKeyConfigured;
  const modelProbeResult: ModelProbeResult | null = modelProbeMutation.data?.probe ?? null;
  const modelProbeUsesSavedKey = !apiKey.trim() && modelKeyConfigured;
  const resolvedChatEndpoint = resolveOpenAiCompatibleEndpoint(effectiveBaseUrl, "chat");
  const resolvedModelsEndpoint = resolveOpenAiCompatibleEndpoint(effectiveBaseUrl, "models");
  const remoteApiMode = isRemoteApiProvider(providerId);
  const modelAuthReady = !remoteApiMode || Boolean(apiKey.trim() || modelKeyConfigured);
  const providerAccessModeLabel = remoteApiMode ? "远端 API" : "本机运行";
  const providerTransportLabel = remoteApiMode ? "OpenAI 兼容" : "Ollama 本地";
  const providerConnectionStateDisplay = !effectiveBaseUrl.trim()
    ? "待补全地址"
    : remoteApiMode && !modelAuthReady
      ? "待填密钥"
      : !chatModel.trim()
        ? "待选择模型"
        : modelProbeMutation.isPending
          ? "检测中"
          : modelProbeMutation.isError || (modelProbeResult ? !modelProbeResult.ok : false)
            ? "检测失败"
            : modelProbeResult?.ok
              ? "连接成功"
              : "待检测";
  const modelCatalogStatusDisplay = modelCatalogMutation.isPending
    ? "读取中..."
    : modelCatalogMutation.isError
      ? "读取失败"
      : modelCatalog.length > 0
        ? `${modelCatalog.length} 个模型`
        : effectiveBaseUrl.trim() && modelAuthReady
          ? "待读取"
          : remoteApiMode && !modelAuthReady
            ? "待填密钥"
            : "待补全";
  const modelProbeStatusDisplay = modelProbeMutation.isPending
    ? "检测中..."
    : modelProbeMutation.isError
      ? "检测失败"
      : modelProbeResult
        ? modelProbeResult.ok
          ? "连接成功"
          : modelProbeResult.http_status
            ? `HTTP ${modelProbeResult.http_status}`
            : "检测失败"
        : effectiveBaseUrl.trim() && chatModel.trim()
          ? "待检测"
          : "待补全";
  const customProviderPathHintVisible =
    providerId === "custom" && remoteApiMode && Boolean(apiHost.trim()) && !apiPath.trim();
  const suggestedProfileName = useMemo(() => {
    const providerLabel = detectedPreset?.label || activePreset.label;
    const modelLabel = chatModel.trim() || (remoteApiMode ? "远端模型" : "本地模型");
    return `${providerLabel} · ${modelLabel}`;
  }, [activePreset.label, chatModel, detectedPreset?.label, remoteApiMode]);
  const currentProviderProfiles = useMemo(
    () => savedModelProfiles.filter((item) => item.providerId === providerId),
    [providerId, savedModelProfiles],
  );
  const otherProviderProfilesCount = savedModelProfiles.length - currentProviderProfiles.length;

  const asrSettings = settingsQuery.data?.asr;
  const asrAvailable = Boolean(asrSettings?.available ?? asrSettings?.configured);
  const asrSelected = Boolean(asrSettings?.selected);
  const currentAsrModeLabel = getAsrModeLabel(asrSettings?.config_mode);
  const currentAsrHasDedicatedKey = Boolean(
    (asrSettings?.config_mode === "explicit" || asrSettings?.config_mode === "hybrid") && asrSettings?.api_key_configured,
  );
  const bilibiliSettings = settingsQuery.data?.bilibili;
  const browserBridgeActive = Boolean(
    bilibiliStatusQuery.data?.browser_bridge_active ?? bilibiliSettings?.browser_bridge_active,
  );
  const browserBridgeSourceLabel =
    bilibiliStatusQuery.data?.browser_bridge_source_label ||
    bilibiliSettings?.browser_bridge_source_label ||
    "";
  const browserBridgeLastSeen =
    bilibiliStatusQuery.data?.browser_bridge_last_seen ||
    bilibiliSettings?.browser_bridge_last_seen ||
    "";
  const browserBridgeExtensionDir = bilibiliSettings?.browser_bridge_extension_dir || "";
  const browserBridgeInstallDoc = bilibiliSettings?.browser_bridge_install_doc || "";
  const bilibiliCookieStored = Boolean(bilibiliSettings?.cookie_stored ?? bilibiliSettings?.cookie_configured);
  const bilibiliCookieActive = Boolean(bilibiliSettings?.cookie_active);
  const pendingCookieProvided = Boolean(cookieFile.trim() || cookieInline.trim());
  const cookieReady = bilibiliCookieStored || pendingCookieProvided;
  const bilibiliFlowLabel = browserBridgeActive
    ? "浏览器自动补全已连通"
    : browserBridgeEnabled
    ? "等待浏览器小助手"
    : bilibiliCookieActive
    ? "手动登录态增强"
    : bilibiliCookieStored
    ? "已保存手动方式"
    : "公开链路";
  const bilibiliModeTitle = browserBridgeEnabled
    ? browserBridgeActive
      ? "已连上浏览器登录状态"
      : "自动连接已打开"
    : cookieEnabled
    ? cookieReady
      ? "手动登录状态已启用"
      : "已启用手动方式，待补完整内容"
    : bilibiliCookieStored
    ? "已保存手动登录状态"
    : "当前只读取公开内容";
  const bilibiliCookieSource = bilibiliSettings?.cookie_source ?? "none";
  const chatModelSuggestions = useMemo(
    () => uniqueValues([...(activePreset.chatOptions ?? []), ...modelCatalog, chatModel]),
    [activePreset.chatOptions, chatModel, modelCatalog],
  );
  const embeddingSuggestions = useMemo(() => uniqueValues([DEFAULT_EMBEDDING_MODEL, embeddingModel]), [embeddingModel]);

  const overviewItems = useMemo(
    () => [
      {
        label: "当前模型",
        value: settingsQuery.data?.model.chat_model || chatModel || "未接入",
      },
      {
        label: "回答方式",
        value: getParticipationModeLabel(modelParticipationMode),
      },
      {
        label: "B 站流程",
        value: bilibiliFlowLabel,
      },
    ],
    [
      bilibiliFlowLabel,
      chatModel,
      modelParticipationMode,
      settingsQuery.data?.model.chat_model,
    ],
  );

  const asrStatusPills = useMemo(
    () =>
      [
        asrSettings?.local_runtime_ready ? "本地运行时可用" : null,
        asrSettings?.ffmpeg_available ? "FFmpeg 已就绪" : null,
        asrSettings?.faster_whisper_installed ? "faster-whisper 已安装" : null,
      ].filter((item): item is string => Boolean(item)),
    [
      asrSettings?.ffmpeg_available,
      asrSettings?.faster_whisper_installed,
      asrSettings?.local_runtime_ready,
    ],
  );
  function applyProviderPreset(nextPreset: ProviderPreset) {
    setProviderId(nextPreset.id);
    modelCatalogMutation.reset();
    modelProbeMutation.reset();

    if (nextPreset.id === "custom") {
      setLocalMessage("已切换为自定义接口，可手动填写地址并读取模型列表。");
      return;
    }

    const { apiHost: nextApiHost, apiPath: nextApiPath } = splitOpenAiCompatibleBaseUrl(nextPreset.baseUrl);
    setApiHost(nextApiHost);
    setApiPath(nextApiPath);
    setEmbeddingModel(nextPreset.embeddingModel);
    if (!chatModel.trim() || detectedPreset?.id === providerId || !isKnownPreset(providerId)) {
      setChatModel(nextPreset.chatModel);
    }
    if (asrModeChoice === "dedicated") {
      setAsrBaseUrl(nextPreset.baseUrl);
      if (!asrModel.trim() || asrModel === DEFAULT_LOCAL_ASR_MODEL) {
        setAsrModel(DEFAULT_REMOTE_ASR_MODEL);
      }
    }
    setLocalMessage(`已切换到 ${nextPreset.label}。`);
  }

  function persistModelProfiles(nextProfiles: ModelConfigProfile[]) {
    const normalized = [...nextProfiles].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    setSavedModelProfiles(normalized);
    writeStoredModelProfiles(normalized);
  }

  function buildCurrentModelProfile(nameOverride?: string, existingProfile?: ModelConfigProfile | null): ModelConfigProfile {
    const now = new Date().toISOString();
    return {
      id: existingProfile?.id || createModelProfileId(),
      name: (nameOverride?.trim() || existingProfile?.name || suggestedProfileName).trim(),
      providerId,
      apiHost: apiHost.trim(),
      apiPath: effectiveApiPath,
      apiKey: apiKey.trim() || existingProfile?.apiKey || "",
      chatModel: chatModel.trim(),
      embeddingModel: embeddingModel.trim() || DEFAULT_EMBEDDING_MODEL,
      createdAt: existingProfile?.createdAt || now,
      updatedAt: now,
    };
  }

  function applyModelProfile(profile: ModelConfigProfile, successMessage?: string) {
    setProviderId(profile.providerId);
    setApiHost(profile.apiHost);
    setApiPath(profile.apiPath);
    setApiKey(profile.apiKey || "");
    setChatModel(profile.chatModel);
    setEmbeddingModel(profile.embeddingModel || DEFAULT_EMBEDDING_MODEL);
    modelCatalogMutation.reset();
    modelProbeMutation.reset();
    if (asrModeChoice === "dedicated" && !asrBaseUrl.trim()) {
      setAsrBaseUrl(joinOpenAiCompatibleBaseUrl(profile.apiHost, profile.apiPath));
    }
    setProfileDraftName(profile.name);
    if (successMessage) setLocalMessage(successMessage);
  }

  function handleSaveCurrentProfile() {
    const name = profileDraftName.trim() || suggestedProfileName;
    const existingProfile =
      savedModelProfiles.find((item) => item.name.trim().toLowerCase() === name.trim().toLowerCase()) || null;
    const nextProfile = buildCurrentModelProfile(name, existingProfile);
    const nextProfiles = existingProfile
      ? savedModelProfiles.map((item) => (item.id === existingProfile.id ? nextProfile : item))
      : [nextProfile, ...savedModelProfiles];
    persistModelProfiles(nextProfiles);
    setProfileDraftName(nextProfile.name);
    setLocalMessage(existingProfile ? `已更新本地档案：${nextProfile.name}` : `已保存本地档案：${nextProfile.name}`);
  }

  function handleDeleteModelProfile(profile: ModelConfigProfile) {
    if (!window.confirm(`确定删除本地档案“${profile.name}”吗？`)) return;
    persistModelProfiles(savedModelProfiles.filter((item) => item.id !== profile.id));
    setLocalMessage(`已删除本地档案：${profile.name}`);
  }

  function buildModelProfileExportText(profile: ModelConfigProfile, includeApiKey = false) {
    return JSON.stringify(
      {
        type: MODEL_PROFILE_EXPORT_TYPE,
        version: 1,
        profile: {
          name: profile.name,
          providerId: profile.providerId,
          apiHost: profile.apiHost,
          apiPath: profile.apiPath,
          ...(includeApiKey && profile.apiKey ? { apiKey: profile.apiKey } : {}),
          chatModel: profile.chatModel,
          embeddingModel: profile.embeddingModel,
        },
      },
      null,
      2,
    );
  }

  async function handleExportCurrentProfile() {
    const currentProfile = buildCurrentModelProfile(profileDraftName.trim() || suggestedProfileName);
    const exportText = buildModelProfileExportText(currentProfile);
    setProfileJsonDraft(exportText);
    await handleCopy(exportText, `${currentProfile.name} 配置 JSON`);
  }

  async function handleExportSavedProfile(profile: ModelConfigProfile) {
    const exportText = buildModelProfileExportText(profile);
    setProfileJsonDraft(exportText);
    await handleCopy(exportText, `${profile.name} 配置 JSON`);
  }

  function applySuggestedApiPath() {
    if (!customProviderAutoPathActive) return;
    setApiPath(effectiveApiPath);
  }

  function handleImportProfileJson() {
    try {
      const imported = parseImportedModelProfile(profileJsonDraft);
      const fallbackName =
        imported.name || `${PROVIDER_PRESETS.find((item) => item.id === imported.providerId)?.label || "自定义"} · ${imported.chatModel || "导入配置"}`;
      const existingProfile =
        savedModelProfiles.find((item) => item.name.trim().toLowerCase() === fallbackName.trim().toLowerCase()) || null;
      const now = new Date().toISOString();
      const nextProfile: ModelConfigProfile = {
        id: existingProfile?.id || createModelProfileId(),
        name: fallbackName,
        providerId: imported.providerId,
        apiHost: imported.apiHost,
        apiPath: imported.apiPath,
        apiKey: imported.apiKey,
        chatModel: imported.chatModel,
        embeddingModel: imported.embeddingModel,
        createdAt: existingProfile?.createdAt || now,
        updatedAt: now,
      };
      const nextProfiles = existingProfile
        ? savedModelProfiles.map((item) => (item.id === existingProfile.id ? nextProfile : item))
        : [nextProfile, ...savedModelProfiles];
      persistModelProfiles(nextProfiles);
      applyModelProfile(nextProfile, `已导入并套用档案：${nextProfile.name}`);
    } catch (error) {
      setLocalMessage(error instanceof Error ? error.message : "导入配置失败，请检查 JSON。");
    }
  }

  function handleLoadModelCatalog() {
    setLocalMessage("");
    applySuggestedApiPath();
    modelCatalogMutation.mutate(
      {
        provider: OPENAI_COMPAT_PROVIDER,
        api_base_url: effectiveBaseUrl.trim(),
        ...(apiKey.trim() ? { api_key: apiKey.trim() } : {}),
      },
      {
        onSuccess: (result) => {
          if (result.models.length && (!chatModel.trim() || !result.models.includes(chatModel.trim()))) {
            setChatModel(result.models[0]);
          }
          setLocalMessage(result.message);
        },
      },
    );
  }

  function handleSelectAsrMode(mode: AsrModeChoice) {
    setAsrModeChoice(mode);
    if (mode === "local" && (!asrModel.trim() || asrModel === DEFAULT_REMOTE_ASR_MODEL)) {
      setAsrModel(DEFAULT_LOCAL_ASR_MODEL);
    }
    if (mode === "dedicated") {
      if (!asrBaseUrl.trim()) setAsrBaseUrl(effectiveBaseUrl.trim());
      if (!asrModel.trim() || asrModel === DEFAULT_LOCAL_ASR_MODEL) {
        setAsrModel(DEFAULT_REMOTE_ASR_MODEL);
      }
    }
  }

  async function handleCopy(value: string, label: string) {
    try {
      if (!navigator.clipboard?.writeText) throw new Error("clipboard unavailable");
      await navigator.clipboard.writeText(value);
      setLocalMessage(`${label}已复制。`);
    } catch {
      setLocalMessage(`当前环境不支持自动复制，请手动复制${label}。`);
    }
  }

  function handleSaveModelConfig() {
    setLocalMessage("");
    applySuggestedApiPath();
    saveMutation.mutate({
      model: {
        provider: OPENAI_COMPAT_PROVIDER,
        chat_model: chatModel.trim(),
        embedding_model: embeddingModel.trim(),
        llm_api_base_url: effectiveBaseUrl.trim(),
        participation_mode: modelParticipationMode,
        ...(apiKey.trim() ? { llm_api_key: apiKey.trim() } : modelKeyConfigured ? {} : { llm_api_key: "" }),
      },
    });
  }

  function handleProbeModelConfig() {
    setLocalMessage("");
    applySuggestedApiPath();
    modelProbeMutation.mutate({
      provider: OPENAI_COMPAT_PROVIDER,
      chat_model: chatModel.trim(),
      api_base_url: effectiveBaseUrl.trim(),
      ...(apiKey.trim() ? { api_key: apiKey.trim() } : {}),
    });
  }

  function handleSaveAsrConfig() {
    setLocalMessage("");
    if (asrModeChoice === "shared") {
      saveMutation.mutate({ asr: { provider: "", model: "", api_base_url: "", api_key: "" } });
      return;
    }
    if (asrModeChoice === "local") {
      saveMutation.mutate({
        asr: {
          provider: "local_whisper",
          model: asrModel.trim() || DEFAULT_LOCAL_ASR_MODEL,
          api_base_url: "",
          api_key: "",
        },
      });
      return;
    }
    saveMutation.mutate({
      asr: {
        provider: OPENAI_COMPAT_PROVIDER,
        model: asrModel.trim() || DEFAULT_REMOTE_ASR_MODEL,
        api_base_url: asrBaseUrl.trim(),
        ...(asrApiKey.trim() ? { api_key: asrApiKey.trim() } : currentAsrHasDedicatedKey ? {} : { api_key: "" }),
      },
    });
  }

  function handleSaveBilibiliConfig() {
    setLocalMessage("");
    const nextCookieFile = cookieFile.trim();
    const nextCookieInline = cookieInline.trim();
    saveMutation.mutate({
      bilibili: {
        browser_bridge_enabled: browserBridgeEnabled,
        cookie_enabled: cookieEnabled,
        cookie_file: nextCookieFile,
        ...(nextCookieInline
          ? { cookie_inline: nextCookieInline }
          : bilibiliCookieSource === "env" && !nextCookieFile
          ? {}
          : { cookie_inline: "" }),
      },
    });
  }

  const canSaveModel = Boolean(effectiveBaseUrl.trim() && chatModel.trim() && modelAuthReady);
  const canProbeModel = Boolean(effectiveBaseUrl.trim() && chatModel.trim());
  const canLoadCatalog = Boolean(effectiveBaseUrl.trim() && modelAuthReady);
  const canSaveCurrentProfile = Boolean(apiHost.trim() && chatModel.trim());
  const canExportCurrentProfile = Boolean(apiHost.trim() || chatModel.trim());

  function handleApiHostChange(value: string) {
    const { apiHost: nextApiHost, apiPath: nextApiPath } = splitOpenAiCompatibleBaseUrl(value);
    if (nextApiPath) {
      setApiHost(nextApiHost);
      setApiPath(nextApiPath);
      return;
    }
    setApiHost(value);
  }

  function handleDirectBaseUrlChange(value: string) {
    const { apiHost: nextApiHost, apiPath: nextApiPath } = splitOpenAiCompatibleBaseUrl(value);
    setApiHost(nextApiHost);
    setApiPath(nextApiPath);
  }
  const canSaveAsr =
    asrModeChoice === "shared"
      ? true
      : asrModeChoice === "local"
      ? Boolean(asrModel.trim())
      : Boolean(asrBaseUrl.trim() && asrModel.trim() && (asrApiKey.trim() || currentAsrHasDedicatedKey));
  const requestedFocus = (searchParams.get("focus")?.trim() || "") as "" | "model" | "asr" | "bilibili";

  useEffect(() => {
    const target =
      requestedFocus === "asr"
        ? asrSectionRef.current
        : requestedFocus === "bilibili"
          ? bilibiliSectionRef.current
          : requestedFocus === "model"
            ? modelSectionRef.current
            : null;
    if (!target) return;
    const timer = window.setTimeout(() => {
      target.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 80);
    return () => window.clearTimeout(timer);
  }, [requestedFocus, settingsQuery.data]);

  function jumpToBilibiliSection() {
    bilibiliSectionRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  return (
    <section className="page">
      <div ref={pageTopRef} />
      <article className="card detail-section-card glass-panel settings-connect-card settings-overview-card">
        <div className="page-header">
          <div>
            <p className="eyebrow">{displayText("设置")}</p>
            <h2>{displayText("连接与采集")}</h2>
          </div>
        </div>

        <div className="simple-health-grid">
          {overviewItems.map((item) => (
            <article className="metric-card" key={item.label}>
              <span className="metric-label">{displayText(item.label)}</span>
              <strong>{displayText(item.value)}</strong>
            </article>
          ))}
        </div>

        <div className="header-actions settings-top-actions">
          <button
            className="secondary-button"
            type="button"
            onClick={() => openBilibiliHelperMutation.mutate()}
            disabled={openBilibiliHelperMutation.isPending}
          >
            {openBilibiliHelperMutation.isPending ? displayText("打开中...") : displayText("桥接")}
          </button>
          <button
            className="secondary-button"
            type="button"
            onClick={jumpToBilibiliSection}
          >
            {displayText("B站")}
          </button>
          <button
            className="secondary-button"
            type="button"
            onClick={() => void bilibiliStatusQuery.refetch()}
            disabled={bilibiliStatusQuery.isFetching}
          >
            {bilibiliStatusQuery.isFetching ? displayText("刷新中...") : displayText("刷新状态")}
          </button>
        </div>

        {settingsQuery.isLoading && <p className="muted-text">{displayText("读取中...")}</p>}
        {settingsQuery.isError && <p className="error-text">{displayText("暂时读不到设置，请确认本地服务已启动。")}</p>}
        {localMessage && <p className="success-text">{displayText(localMessage)}</p>}
        {saveMutation.isError && <p className="error-text">{displayText("保存失败，请确认本地服务仍在运行。")}</p>}
        {diagnosticsMutation.isSuccess && <p className="success-text">{displayText(`排查信息已导出：${diagnosticsMutation.data.path}`)}</p>}
        {diagnosticsMutation.isError && <p className="error-text">{displayText("排查信息导出失败，请稍后再试。")}</p>}
      </article>

      <div className="settings-stack-grid">
        <article
          ref={modelSectionRef}
          className={
            requestedFocus === "model"
              ? "card detail-section-card glass-panel settings-connect-card settings-main-card settings-focus-target settings-focus-target-active"
              : "card detail-section-card glass-panel settings-connect-card settings-main-card settings-focus-target"
          }
        >
          <div className="panel-heading">
            <div>
              <p className="eyebrow">{displayText("Provider Console")}</p>
              <h3>{displayText("模型接入")}</h3>
              <p className="muted-text">{displayText("集中管理 provider、接口和本地档案。")}</p>
            </div>
          </div>

          <div className="settings-provider-console-shell">
            <div className="settings-provider-console">
              <aside className="settings-provider-console-sidebar">
                <div className="settings-provider-console-sidebar-head">
                  <p className="eyebrow">{displayText("Providers")}</p>
                  <h4>{displayText("模型入口")}</h4>
                  <p className="muted-text">{displayText("左侧切换，右侧完成连接与模型。")}</p>
                </div>

                <div className="settings-provider-nav-stack">
                  {PROVIDER_PRESETS.map((preset) => {
                    const active = preset.id === providerId;
                    const presetProfileCount = savedModelProfiles.filter((item) => item.providerId === preset.id).length;
                    const presetRemoteApiMode = isRemoteApiProvider(preset.id);
                    return (
                      <button
                        key={preset.id}
                        className={active ? "settings-provider-nav-item settings-provider-nav-item-active" : "settings-provider-nav-item"}
                        type="button"
                        onClick={() => applyProviderPreset(preset)}
                      >
                        <div className="settings-provider-nav-top">
                          <div className="settings-provider-nav-main">
                            <strong>{displayText(preset.label)}</strong>
                            <span>{displayText(preset.description)}</span>
                          </div>
                          <span className={active ? "settings-provider-status-dot settings-provider-status-dot-active" : "settings-provider-status-dot"} />
                        </div>

                        <div className="settings-provider-nav-meta">
                          <span className="subtle-pill">{displayText(presetRemoteApiMode ? "远端 API" : "本机运行")}</span>
                          <span className="subtle-pill">{displayText(presetProfileCount ? `${presetProfileCount} 组档案` : "暂无档案")}</span>
                        </div>
                      </button>
                    );
                  })}
                </div>

                <div className="settings-provider-console-sidebar-foot">
                  <span className="subtle-pill">{displayText("当前选中")}</span>
                  <strong>{displayText(activePreset.label)}</strong>
                  <p className="field-hint">{displayText("预置会带默认地址；自定义适合第三方 OpenAI 兼容网关。")}</p>
                </div>
              </aside>

              <div className="settings-provider-workspace">
                <section className="settings-provider-workspace-hero">
                  <div className="settings-provider-hero-main">
                    <span className="settings-provider-hero-mark">{activePreset.label.slice(0, 1)}</span>
                    <div>
                      <p className="eyebrow">{displayText("Current Provider")}</p>
                      <h4>{displayText(activePreset.label)}</h4>
                      <p className="muted-text">{displayText(`${activePreset.description} · ${getParticipationModeLabel(modelParticipationMode)}`)}</p>
                    </div>
                  </div>

                  <div className="settings-provider-hero-badges">
                    <span className="subtle-pill">{displayText(providerAccessModeLabel)}</span>
                    <span className="subtle-pill">{displayText(providerTransportLabel)}</span>
                    <span className="subtle-pill">
                      {displayText(remoteApiMode ? (modelAuthReady ? "密钥已就绪" : "待填密钥") : "本机无需密钥")}
                    </span>
                  </div>
                </section>

                <div className="settings-provider-summary-strip">
                  <article className="settings-provider-summary-metric">
                    <span>{displayText("运行方式")}</span>
                    <strong>{displayText(providerAccessModeLabel)}</strong>
                  </article>
                  <article className="settings-provider-summary-metric">
                    <span>{displayText("接口协议")}</span>
                    <strong>{displayText(providerTransportLabel)}</strong>
                  </article>
                  <article className="settings-provider-summary-metric">
                    <span>{displayText("当前模型")}</span>
                    <strong>{displayText(chatModel.trim() || "未填写")}</strong>
                  </article>
                  <article className="settings-provider-summary-metric">
                    <span>{displayText("工作状态")}</span>
                    <strong>{displayText(providerConnectionStateDisplay)}</strong>
                  </article>
                </div>

                <div className="settings-provider-workspace-grid">

                  <section className="settings-provider-sheet settings-provider-sheet-main">
                    <div className="settings-provider-sheet-head">
                      <div>
                        <p className="eyebrow">{displayText("Connection")}</p>
                        <h4>{displayText("连接配置")}</h4>
                      </div>
                      <div className="header-actions settings-provider-inline-actions">
                        <button
                          className="secondary-button"
                          type="button"
                          onClick={handleLoadModelCatalog}
                          disabled={modelCatalogMutation.isPending || !canLoadCatalog}
                        >
                          {modelCatalogMutation.isPending ? displayText("读取中...") : displayText("获取模型")}
                        </button>
                        <button
                          className="secondary-button"
                          type="button"
                          onClick={handleProbeModelConfig}
                          disabled={modelProbeMutation.isPending || !canProbeModel}
                        >
                          {modelProbeMutation.isPending ? displayText("检查中...") : displayText("检查连接")}
                        </button>
                        <button
                          className="primary-button"
                          type="button"
                          onClick={handleSaveModelConfig}
                          disabled={saveMutation.isPending || !canSaveModel}
                        >
                          {saveMutation.isPending ? displayText("保存中...") : displayText("保存当前配置")}
                        </button>
                      </div>
                    </div>

                    <label className="form-block form-block-full">
                      <span className="field-label">{displayText("API Key")}</span>
                      <input
                        className="search-input"
                        type="password"
                        placeholder={displayText(
                          remoteApiMode
                            ? modelKeyConfigured
                              ? "留空则保留当前 Key"
                              : "粘贴厂商提供的 API Key"
                            : "本机模式通常不需要填写",
                        )}
                        value={apiKey}
                        onChange={(event) => setApiKey(event.target.value)}
                      />
                    </label>

                    <div className="form-grid">
                      <label className="form-block">
                        <span className="field-label">{displayText("API Host")}</span>
                        <input
                          className="search-input"
                          placeholder={remoteApiMode ? "https://your-host.example.com" : "http://localhost:11434"}
                          value={apiHost}
                          onChange={(event) => handleApiHostChange(event.target.value)}
                        />
                      </label>
                      <label className="form-block">
                        <span className="field-label">{displayText("API Path（可选）")}</span>
                        <input
                          className="search-input"
                          placeholder={remoteApiMode ? "留空时默认按 /v1 识别" : "/v1"}
                          value={apiPath}
                          onChange={(event) => setApiPath(event.target.value)}
                        />
                      </label>
                    </div>

                    {customProviderPathHintVisible && (
                      <div className="field-hint field-hint-warning" style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
                        <span style={{ flex: 1 }}>
                          {displayText(
                            customProviderAutoPathActive
                              ? `当前只填了域名根地址，系统会先按 ${effectiveApiPath} 识别并生成接口地址。若你的平台文档写的是别的路径，再手动改 API Path 即可。`
                              : "如果平台文档给的是完整 OpenAI 兼容地址，也可以直接粘贴到 API Host，系统会自动拆分出路径。",
                          )}
                        </span>
                        {customProviderAutoPathActive && (
                          <button className="secondary-button" type="button" onClick={applySuggestedApiPath}>
                            {displayText("写入 /v1")}
                          </button>
                        )}
                      </div>
                    )}

                    <label className="form-block form-block-full">
                      <span className="field-label">{displayText("聊天模型")}</span>
                      <input
                        className="search-input"
                        list="chat-model-options"
                        placeholder={displayText(activePreset.chatModel || "可手动输入模型名")}
                        value={chatModel}
                        onChange={(event) => setChatModel(event.target.value)}
                      />
                      <datalist id="chat-model-options">
                        {chatModelSuggestions.map((item) => (
                          <option key={item} value={item} />
                        ))}
                      </datalist>
                    </label>

                    {!!modelCatalog.length && (
                      <div className="pill-row settings-model-chip-row">
                        {modelCatalog.slice(0, 12).map((item) => (
                          <button
                            key={item}
                            className={chatModel === item ? "primary-button" : "secondary-button"}
                            type="button"
                            onClick={() => setChatModel(item)}
                          >
                            {displayText(item)}
                          </button>
                        ))}
                      </div>
                    )}

                    <section className="settings-model-policy-panel">
                      <div className="settings-provider-sheet-head">
                        <div>
                          <p className="eyebrow">{displayText("Policy")}</p>
                          <h4>{displayText("模型参与策略")}</h4>
                        </div>
                        <span className="subtle-pill">{displayText(getParticipationModeLabel(modelParticipationMode))}</span>
                      </div>

                      <div className="settings-model-policy-grid">
                        {MODEL_PARTICIPATION_OPTIONS.map((item) => (
                          <button
                            key={item.id}
                            type="button"
                            className={
                              modelParticipationMode === item.id
                                ? "settings-model-policy-card settings-model-policy-card-active"
                                : "settings-model-policy-card"
                            }
                            onClick={() => setModelParticipationMode(item.id)}
                          >
                            <div>
                              <strong>{displayText(item.label)}</strong>
                              <span>{displayText(item.summary)}</span>
                            </div>
                            <p>{displayText(item.description)}</p>
                          </button>
                        ))}
                      </div>
                    </section>

                    <p className="field-hint">
                      {displayText(
                        remoteApiMode
                          ? providerId === "custom"
                            ? "常见 OpenAI 兼容网关可直接填 Host + Key；留空 Path 时默认按 /v1 识别。"
                            : "支持填写 Host + /v1，也支持直接贴完整 OpenAI 兼容地址。"
                          : "本机模式通常只需要 localhost:11434 与 /v1。",
                      )}
                    </p>

                    <details className="metadata-details advanced-details">
                      <summary>{displayText("高级")}</summary>
                      <div className="form-grid">
                        <label className="form-block">
                          <span className="field-label">{displayText("直接编辑 Base URL")}</span>
                          <input
                            className="search-input"
                            value={effectiveBaseUrl}
                            onChange={(event) => handleDirectBaseUrlChange(event.target.value)}
                          />
                        </label>
                        <label className="form-block">
                          <span className="field-label">{displayText("向量模型")}</span>
                          <input
                            className="search-input"
                            list="embedding-model-options"
                            value={embeddingModel}
                            onChange={(event) => setEmbeddingModel(event.target.value)}
                          />
                          <datalist id="embedding-model-options">
                            {embeddingSuggestions.map((item) => (
                              <option key={item} value={item} />
                            ))}
                          </datalist>
                          {statusQuery.data?.models.embedding_model_mismatch && (
                            <div className="field-hint field-hint-warning" style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
                              <span style={{ flex: 1 }}>
                                ⚠ 当前向量模型（{embeddingModel}）与建索引时的模型（{statusQuery.data.models.index_embedding_model}）不一致，检索可能偏移。
                              </span>
                              <button
                                type="button"
                                className="btn btn-sm btn-secondary"
                                onClick={() => reindexMutation.mutate()}
                                disabled={reindexMutation.isPending}
                                style={{ flexShrink: 0 }}
                              >
                                {reindexMutation.isPending ? "重建中…" : "重建索引"}
                              </button>
                            </div>
                          )}
                        </label>
                      </div>
                    </details>
                  </section>

                  <div className="settings-provider-side-stack">
                    <section className="settings-provider-sheet">
                      <div className="settings-provider-sheet-head">
                        <div>
                          <p className="eyebrow">{displayText("Endpoint")}</p>
                          <h4>{displayText("端点与状态")}</h4>
                        </div>
                      </div>

                      <div className="settings-provider-endpoint-list">
                        <article className="settings-provider-endpoint-item">
                          <span>{displayText("聊天请求")}</span>
                          <strong>{displayText(resolvedChatEndpoint || "等待填写 Host / Path")}</strong>
                        </article>
                        <article className="settings-provider-endpoint-item">
                          <span>{displayText("模型目录")}</span>
                          <strong>{displayText(resolvedModelsEndpoint || "等待填写 Host / Path")}</strong>
                        </article>
                      </div>

                      <div className="simple-health-grid">
                        <article className="metric-card">
                          <span className="metric-label">{displayText("模型目录")}</span>
                          <strong>{displayText(modelCatalogStatusDisplay)}</strong>
                        </article>
                        <article className="metric-card">
                          <span className="metric-label">{displayText("连接检测")}</span>
                          <strong>{displayText(modelProbeStatusDisplay)}</strong>
                        </article>
                        <article className="metric-card">
                          <span className="metric-label">{displayText("延迟")}</span>
                          <strong>{displayText(modelProbeResult?.latency_ms !== null && modelProbeResult?.latency_ms !== undefined ? `${modelProbeResult.latency_ms} ms` : "—")}</strong>
                        </article>
                        <article className="metric-card">
                          <span className="metric-label">{displayText("实际模型")}</span>
                          <strong>{displayText(modelProbeResult?.model || chatModel.trim() || "—")}</strong>
                        </article>
                      </div>

                      {modelCatalogMutation.isError && <p className="error-text">{displayText((modelCatalogMutation.error as Error).message)}</p>}
                      {modelProbeMutation.isError && <p className="error-text">{displayText((modelProbeMutation.error as Error).message)}</p>}
                      {modelCatalog.length > 0 && (
                        <p className="field-hint">
                          {displayText(
                            modelCatalogUsesSavedKey ? `已读取 ${modelCatalog.length} 个模型，使用已保存 Key。` : `已读取 ${modelCatalog.length} 个模型。`,
                          )}
                        </p>
                      )}
                      {modelProbeResult && modelProbeUsesSavedKey && <p className="field-hint">{displayText("本次检测使用已保存 Key。")}</p>}
                    </section>

                    <section className="settings-provider-sheet settings-provider-profile-panel">
                      <div className="settings-provider-sheet-head">
                        <div>
                          <p className="eyebrow">{displayText("Profiles")}</p>
                          <h4>{displayText("本地档案")}</h4>
                        </div>
                        <span className="subtle-pill">
                          {displayText(currentProviderProfiles.length ? `当前 provider ${currentProviderProfiles.length} 组` : "当前 provider 暂无档案")}
                        </span>
                      </div>

                      <div className="settings-provider-profile-toolbar">
                        <label className="form-block">
                          <span className="field-label">{displayText("档案名称")}</span>
                          <input
                            className="search-input"
                            placeholder={suggestedProfileName}
                            value={profileDraftName}
                            onChange={(event) => setProfileDraftName(event.target.value)}
                          />
                        </label>

                        <div className="header-actions settings-provider-inline-actions">
                          <button
                            className="secondary-button"
                            type="button"
                            onClick={handleSaveCurrentProfile}
                            disabled={!canSaveCurrentProfile}
                          >
                            {displayText("保存当前为档案")}
                          </button>
                          <button
                            className="secondary-button"
                            type="button"
                            onClick={() => void handleExportCurrentProfile()}
                            disabled={!canExportCurrentProfile}
                          >
                            {displayText("导出当前 JSON")}
                          </button>
                        </div>
                      </div>

                      {currentProviderProfiles.length > 0 ? (
                        <div className="settings-profile-list">
                          {currentProviderProfiles.map((profile) => {
                            const profileBaseUrl = joinOpenAiCompatibleBaseUrl(profile.apiHost, profile.apiPath);
                            const profileProvider = PROVIDER_PRESETS.find((item) => item.id === profile.providerId);
                            return (
                              <article className="settings-profile-card" key={profile.id}>
                                <div className="settings-profile-meta">
                                  <strong>{displayText(profile.name)}</strong>
                                  <p className="muted-text">
                                    {displayText(
                                      `${profileProvider?.label || "自定义"} · ${profile.chatModel || "未填写模型"} · ${profileBaseUrl || "未填写地址"}`,
                                    )}
                                  </p>
                                </div>
                                <div className="header-actions">
                                  <button
                                    className="secondary-button"
                                    type="button"
                                    onClick={() => applyModelProfile(profile, `已套用档案：${profile.name}`)}
                                  >
                                    {displayText("套用")}
                                  </button>
                                  <button
                                    className="secondary-button"
                                    type="button"
                                    onClick={() => void handleExportSavedProfile(profile)}
                                  >
                                    {displayText("导出 JSON")}
                                  </button>
                                  <button
                                    className="secondary-button"
                                    type="button"
                                    onClick={() => handleDeleteModelProfile(profile)}
                                  >
                                    {displayText("删除")}
                                  </button>
                                </div>
                              </article>
                            );
                          })}
                        </div>
                      ) : (
                        <article className="settings-provider-empty">
                          <strong>{displayText("还没有本地档案")}</strong>
                          <p className="muted-text">{displayText("保存当前配置后，这里就能快速切换。")}</p>
                        </article>
                      )}

                      {otherProviderProfilesCount > 0 && (
                        <p className="field-hint">{displayText(`另外还有 ${otherProviderProfilesCount} 组其他 provider 档案。`)}</p>
                      )}

                      <details className="metadata-details advanced-details">
                        <summary>{displayText("导入 / 导出 JSON")}</summary>
                        <textarea
                          className="text-area"
                          rows={8}
                          placeholder={displayText("粘贴配置 JSON")}
                          value={profileJsonDraft}
                          onChange={(event) => setProfileJsonDraft(event.target.value)}
                        />
                        <div className="header-actions settings-provider-inline-actions" style={{ marginTop: 8 }}>
                          <button className="secondary-button" type="button" onClick={handleImportProfileJson} disabled={!profileJsonDraft.trim()}>
                            {displayText("导入并套用")}
                          </button>
                          <button className="secondary-button" type="button" onClick={() => setProfileJsonDraft("")} disabled={!profileJsonDraft.trim()}>
                            {displayText("清空 JSON")}
                          </button>
                        </div>
                      </details>
                    </section>
                  </div>
                  </div>
                </div>
              </div>
            </div>
          </article>
      </div>

      <div className="settings-secondary-grid">
        <article
          ref={asrSectionRef}
          className={
            requestedFocus === "asr"
              ? "card detail-section-card glass-panel settings-connect-card settings-focus-target settings-focus-target-active"
              : "card detail-section-card glass-panel settings-connect-card settings-focus-target"
          }
        >
          <div className="panel-heading">
            <div>
              <p className="eyebrow">{displayText("转写")}</p>
              <h3>{displayText("转写")}</h3>
            </div>
          </div>

          <div className="settings-provider-card">
            <div>
              <strong>
                {displayText(
                  asrAvailable
                    ? `${currentAsrModeLabel}已可用`
                    : asrSelected
                    ? `${currentAsrModeLabel}待就绪`
                    : "当前未启用转写",
                )}
              </strong>
              <p className="muted-text">{displayText(asrSettings?.summary?.trim() || "没有字幕时再补正文。")}</p>
            </div>
            <span className="subtle-pill">{displayText(getAsrChoiceLabel(asrModeChoice))}</span>
          </div>

          <div className="segment-rail">
            {[
              { value: "shared", label: "复用主模型" },
              { value: "dedicated", label: "独立接口" },
              { value: "local", label: "本地转写" },
            ].map((item) => (
              <button
                key={item.value}
                className={asrModeChoice === item.value ? "segment-pill segment-pill-active" : "segment-pill"}
                type="button"
                onClick={() => handleSelectAsrMode(item.value as AsrModeChoice)}
              >
                {displayText(item.label)}
              </button>
            ))}
          </div>

          {asrModeChoice === "dedicated" && (
            <div className="form-grid">
              <label className="form-block">
                <span className="field-label">{displayText("转写接口地址")}</span>
                <input className="search-input" value={asrBaseUrl} onChange={(event) => setAsrBaseUrl(event.target.value)} />
              </label>
              <label className="form-block">
                <span className="field-label">{displayText("转写模型")}</span>
                <input className="search-input" value={asrModel} onChange={(event) => setAsrModel(event.target.value)} />
              </label>
              <label className="form-block form-block-full">
                <span className="field-label">{displayText("转写 API Key")}</span>
                <input
                  className="search-input"
                  type="password"
                  placeholder={displayText(currentAsrHasDedicatedKey ? "留空则保留当前 Key" : "填入转写接口 Key")}
                  value={asrApiKey}
                  onChange={(event) => setAsrApiKey(event.target.value)}
                />
              </label>
            </div>
          )}

          {asrModeChoice === "local" && (
            <div className="form-grid">
              <label className="form-block form-block-full">
                <span className="field-label">{displayText("本地模型")}</span>
                <input
                  className="search-input"
                  value={asrModel}
                  placeholder={DEFAULT_LOCAL_ASR_MODEL}
                  onChange={(event) => setAsrModel(event.target.value)}
                />
              </label>
            </div>
          )}

          {!!asrStatusPills.length && (
            <div className="pill-row">
              {asrStatusPills.map((item) => (
                <span className="pill" key={item}>{displayText(item)}</span>
              ))}
            </div>
          )}

          <div className="header-actions">
            <button
              className="primary-button"
              type="button"
              onClick={handleSaveAsrConfig}
              disabled={saveMutation.isPending || !canSaveAsr}
            >
              {saveMutation.isPending ? displayText("保存中...") : displayText("保存转写")}
            </button>
          </div>
        </article>

        <article
          ref={bilibiliSectionRef}
          className={
            requestedFocus === "bilibili"
              ? "card detail-section-card glass-panel settings-connect-card settings-focus-target settings-focus-target-active"
              : "card detail-section-card glass-panel settings-connect-card settings-focus-target"
          }
        >
          <div className="panel-heading">
            <div>
              <p className="eyebrow">{displayText("B 站登录状态")}</p>
              <h3>{displayText("B站")}</h3>
            </div>
          </div>

          <div className="settings-provider-card">
            <div>
              <strong>{displayText(bilibiliModeTitle)}</strong>
            </div>
            <span className="subtle-pill">{displayText(browserBridgeEnabled ? "浏览器桥接" : "公开内容")}</span>
          </div>

          {(() => {
            const liveStatus = bilibiliStatusQuery.data;
            if (!liveStatus) return null;
            const {
              browser_bridge_active,
              browser_bridge_enabled,
              browser_bridge_source_label,
              cookie_configured,
              cookie_active,
            } = liveStatus;
            if (browser_bridge_active) {
              return (
                <span className="pill pill-success" style={{ alignSelf: "flex-start" }}>
                  {displayText(`已连上 ${browser_bridge_source_label || "浏览器小助手"}`)}
                </span>
              );
            }
            if (browser_bridge_enabled) {
              return <span className="pill pill-warning" style={{ alignSelf: "flex-start" }}>{displayText("等待浏览器同步")}</span>;
            }
            if (cookie_configured) {
              return <span className="pill pill-warning" style={{ alignSelf: "flex-start" }}>{displayText(cookie_active ? "手动登录状态已启用" : "已保存手动方式")}</span>;
            }
            return <span className="pill" style={{ alignSelf: "flex-start" }}>{displayText("当前只用公开内容")}</span>;
          })()}

          <div className="segment-rail">
            {[
              { value: true, label: "浏览器桥接" },
              { value: false, label: "仅公开内容" },
            ].map((item) => (
              <button
                key={item.label}
                className={browserBridgeEnabled === item.value ? "segment-pill segment-pill-active" : "segment-pill"}
                type="button"
                onClick={() => setBrowserBridgeEnabled(item.value)}
              >
                {displayText(item.label)}
              </button>
            ))}
          </div>

          {browserBridgeEnabled && (
            <>
              <div className="result-callout" style={{ borderColor: browserBridgeActive ? "var(--success, #22c55e)" : "var(--border)" }}>
                <strong>
                  {displayText(
                    browserBridgeActive
                      ? `来源 ${browserBridgeSourceLabel || "浏览器小助手"}`
                      : "等待浏览器同步",
                  )}
                </strong>
                {!!browserBridgeLastSeen && (
                  <p className="muted-text">
                    {displayText(`最近同步：${new Date(browserBridgeLastSeen).toLocaleString()}`)}
                  </p>
                )}
              </div>
            </>
          )}

          <details className="metadata-details advanced-details">
            <summary>{displayText("手动来源")}</summary>

            <div className="segment-rail">
              {[
                { value: false, label: "关闭手动" },
                { value: true, label: "启用手动" },
              ].map((item) => (
                <button
                  key={item.label}
                  className={cookieEnabled === item.value ? "segment-pill segment-pill-active" : "segment-pill"}
                  type="button"
                  onClick={() => setCookieEnabled(item.value)}
                >
                  {displayText(item.label)}
                </button>
              ))}
            </div>

            <div className="form-grid">
              <label className="form-block">
                <span className="field-label">{displayText("登录状态文件路径")}</span>
                <input
                  className="search-input"
                  placeholder={displayText("例如：D:\\cookie\\bilibili.txt")}
                  value={cookieFile}
                  onChange={(event) => setCookieFile(event.target.value)}
                />
              </label>
              <label className="form-block form-block-full">
                <span className="field-label">{displayText("或粘贴完整内容")}</span>
                <textarea
                  className="text-area"
                  rows={4}
                  placeholder={displayText("仅限本地自用。")}
                  value={cookieInline}
                  onChange={(event) => setCookieInline(event.target.value)}
                />
              </label>
            </div>

            {!cookieReady && cookieEnabled && (
              <p className="muted-text settings-inline-note">
                {displayText("桥接不可用时再填手动来源。")}
              </p>
            )}
            {bilibiliCookieStored && !cookieEnabled && (
              <p className="muted-text settings-inline-note">
                {displayText("已保存手动来源，当前未启用。")}
              </p>
            )}
          </details>

          <div className="header-actions">
            <button className="primary-button" type="button" onClick={handleSaveBilibiliConfig} disabled={saveMutation.isPending}>
              {saveMutation.isPending ? displayText("保存中...") : displayText("保存连接")}
            </button>
            <button
              className="secondary-button"
              type="button"
              onClick={() => openBilibiliHelperMutation.mutate()}
              disabled={openBilibiliHelperMutation.isPending}
            >
              {openBilibiliHelperMutation.isPending ? displayText("打开中...") : displayText("桥接")}
            </button>
            <button
              className="secondary-button"
              type="button"
              onClick={() => void bilibiliStatusQuery.refetch()}
              disabled={bilibiliStatusQuery.isFetching}
            >
              {bilibiliStatusQuery.isFetching ? displayText("刷新中...") : displayText("刷新状态")}
            </button>
            {!!browserBridgeExtensionDir && (
              <button
                className="secondary-button"
                type="button"
                onClick={() => void handleCopy(browserBridgeExtensionDir, "浏览器小助手目录")}
              >
                {displayText("复制扩展目录")}
              </button>
            )}
            {!!browserBridgeInstallDoc && (
              <button
                className="secondary-button"
                type="button"
                onClick={() => void handleCopy(browserBridgeInstallDoc, "安装说明路径")}
              >
                {displayText("复制安装文档")}
              </button>
            )}
          </div>
        </article>
      </div>

      <details className="card detail-section-card glass-panel maintenance-details">
        <summary>{displayText("维护")}</summary>

        <article className="backup-status-card">
          <div className="backup-status-info">
            <strong>{displayText("备份")}</strong>
            {backupMutation.isSuccess ? (
              <p className="muted-text">
                {displayText("上次备份")}：{new Date(backupMutation.data.created_at).toLocaleString()}<br />
                <span className="backup-path">{backupMutation.data.archive_path}</span>
              </p>
            ) : (
              <p className="muted-text">{displayText("还没有备份。")}</p>
            )}
            {backupMutation.isError && <p className="error-text">{displayText("备份失败，请稍后再试。")}</p>}
          </div>
          <button className="secondary-button" type="button" onClick={() => backupMutation.mutate()} disabled={backupMutation.isPending}>
            {backupMutation.isPending ? displayText("备份中...") : displayText("备份")}
          </button>
        </article>

        <article className="backup-status-card">
          <div className="backup-status-info">
            <strong>{displayText("重复内容整理")}</strong>
            {dedupeMutation.isSuccess ? (
              <p className="muted-text">{displayText(
                dedupeMutation.data.duplicates_archived > 0
                  ? `已归档 ${dedupeMutation.data.duplicates_archived} 条重复内容（${dedupeMutation.data.duplicate_groups} 组）。`
                  : "没有发现重复内容。"
              )}</p>
            ) : (
              <p className="muted-text">{displayText("将同源重复内容归并到回收站，保留最新版本。")}</p>
            )}
            {dedupePreviewMutation.isError && <p className="error-text">{displayText("预检失败，请稍后再试。")}</p>}
            {dedupeMutation.isError && <p className="error-text">{displayText("整理失败，请稍后再试。")}</p>}
          </div>
          <button
            className="secondary-button"
            type="button"
            onClick={() => { setDedupePreview(null); dedupePreviewMutation.mutate(); }}
            disabled={dedupePreviewMutation.isPending || dedupeMutation.isPending}
          >
            {dedupePreviewMutation.isPending ? displayText("检查中...") : displayText("检查重复")}
          </button>
        </article>

        {dedupePreview && (
          <article className="dedupe-preview-card card">
            <div className="backup-status-info">
              <strong>{displayText(
                dedupePreview.duplicate_groups > 0
                  ? `发现 ${dedupePreview.duplicate_groups} 组重复内容（${dedupePreview.duplicates_archived} 条将被归档）`
                  : "没有发现重复内容"
              )}</strong>
              {dedupePreview.duplicate_groups > 0 && (
                <div className="dedupe-preview-list">
                  {dedupePreview.items.slice(0, 8).map((item) => (
                    <div key={item.duplicate_id} className="dedupe-preview-row">
                      <span className="pill pill-sm">{displayText("重复")}</span>
                      <span className="dedupe-preview-title muted-text">{displayText(item.duplicate_title)}</span>
                      <span className="dedupe-preview-arrow">→</span>
                      <span className="dedupe-preview-title">{displayText(item.kept_title)}</span>
                    </div>
                  ))}
                  {dedupePreview.items.length > 8 && (
                    <p className="muted-text" style={{ fontSize: 12, marginTop: 4 }}>
                      {displayText(`还有 ${dedupePreview.items.length - 8} 条…`)}
                    </p>
                  )}
                </div>
              )}
            </div>
            <div className="header-actions">
              <button
                className="secondary-button"
                type="button"
                onClick={() => setDedupePreview(null)}
                disabled={dedupeMutation.isPending}
              >
                {displayText("取消")}
              </button>
              {dedupePreview.duplicate_groups > 0 && (
                <button
                  className="primary-button"
                  type="button"
                  onClick={() => dedupeMutation.mutate()}
                  disabled={dedupeMutation.isPending}
                >
                  {dedupeMutation.isPending ? displayText("整理中...") : displayText("确认整理")}
                </button>
              )}
            </div>
          </article>
        )}

        {statusQuery.data?.index?.needs_rebuild && (
          <div className="field-hint field-hint-warning" style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
            <span style={{ flex: 1 }}>
              ⚠ 已有 {statusQuery.data.index.chunks_count} 个片段，但向量索引缺失，语义检索暂不可用。
            </span>
            <button
              type="button"
              className="btn btn-sm btn-secondary"
              onClick={() => reindexMutation.mutate()}
              disabled={reindexMutation.isPending}
              style={{ flexShrink: 0 }}
            >
              {reindexMutation.isPending ? "重建中…" : "重建索引"}
            </button>
          </div>
        )}

        <div className="header-actions">
          <button
            className="secondary-button"
            type="button"
            onClick={() => diagnosticsMutation.mutate()}
            disabled={diagnosticsMutation.isPending}
          >
            {diagnosticsMutation.isPending ? displayText("导出中...") : displayText("导出诊断")}
          </button>
          {settingsQuery.data && (
            <>
              <button
                className="secondary-button"
                type="button"
                onClick={() => void handleCopy(settingsQuery.data.knowledge_base_dir, "知识库目录")}
              >
                {displayText("复制库目录")}
              </button>
              <button
                className="secondary-button"
                type="button"
                onClick={() => void handleCopy(settingsQuery.data.export_dir, "导出目录")}
              >
                {displayText("复制导出")}
              </button>
            </>
          )}
        </div>
      </details>
    </section>
  );
}
