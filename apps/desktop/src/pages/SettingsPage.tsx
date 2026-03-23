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

const PROVIDER_PRESETS = [
  {
    id: "ollama",
    label: "Ollama",
    description: "本地运行，数据不出机器，适合隐私优先场景。",
    hint: "本地已安装 Ollama 后即可读取模型。",
    chatModel: "qwen2.5:7b",
    chatOptions: ["qwen2.5:7b", "qwen2.5:14b", "llama3.2:3b", "deepseek-r1:7b"],
    embeddingModel: "bge-m3",
    baseUrl: "http://localhost:11434/v1",
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    description: "性价比高，适合长文档理解和中文问答。",
    hint: "填写 Key 后可读取模型列表。",
    chatModel: "deepseek-chat",
    chatOptions: ["deepseek-chat", "deepseek-reasoner"],
    embeddingModel: DEFAULT_EMBEDDING_MODEL,
    baseUrl: "https://api.deepseek.com/v1",
  },
  {
    id: "moonshot",
    label: "Moonshot",
    description: "适合把视频和网页整理成更自然的中文回答。",
    hint: "填写 Key 后可读取模型列表。",
    chatModel: "kimi-latest",
    chatOptions: ["kimi-latest"],
    embeddingModel: DEFAULT_EMBEDDING_MODEL,
    baseUrl: "https://api.moonshot.cn/v1",
  },
  {
    id: "zhipu",
    label: "智谱",
    description: "适合快速接通在线理解和问答链路。",
    hint: "支持按厂商接入，也可手动更换模型。",
    chatModel: "glm-4-flash-250414",
    chatOptions: ["glm-4-flash-250414"],
    embeddingModel: DEFAULT_EMBEDDING_MODEL,
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
  },
  {
    id: "custom",
    label: "自定义",
    description: "适配任意 OpenAI 兼容接口。",
    hint: "适合之后接入更多线上模型平台。",
    chatModel: "",
    chatOptions: [],
    embeddingModel: DEFAULT_EMBEDDING_MODEL,
    baseUrl: "",
  },
] as const;

type ProviderPreset = (typeof PROVIDER_PRESETS)[number];
type ProviderId = ProviderPreset["id"];
type AsrModeChoice = "shared" | "dedicated" | "local";

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
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
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
    setBaseUrl(settingsQuery.data.model.llm_api_base_url || "");
    setApiKey("");
    setAsrModeChoice(mapAsrModeChoice(settingsQuery.data.asr?.config_mode));
    setAsrModel(settingsQuery.data.asr?.model || DEFAULT_LOCAL_ASR_MODEL);
    setAsrBaseUrl(settingsQuery.data.asr?.api_base_url || settingsQuery.data.model.llm_api_base_url || "");
    setAsrApiKey("");
    setBrowserBridgeEnabled(Boolean(settingsQuery.data.bilibili?.browser_bridge_enabled ?? true));
    setCookieEnabled(Boolean(settingsQuery.data.bilibili?.cookie_enabled));
    setCookieFile(settingsQuery.data.bilibili?.cookie_file || "");
    setCookieInline("");
  }, [settingsQuery.data]);

  useEffect(() => {
    modelCatalogMutation.reset();
    modelProbeMutation.reset();
  }, [apiKey, baseUrl]);

  const activePreset = useMemo(
    () => PROVIDER_PRESETS.find((item) => item.id === providerId) ?? PROVIDER_PRESETS[PROVIDER_PRESETS.length - 1],
    [providerId],
  );
  const detectedPreset = useMemo(() => findMatchingPreset(baseUrl, chatModel), [baseUrl, chatModel]);
  const modelKeyConfigured = Boolean(settingsQuery.data?.model.llm_api_key_configured);
  const modelCatalog = modelCatalogMutation.data?.models ?? [];
  const modelCatalogUsesSavedKey = !apiKey.trim() && modelKeyConfigured;
  const modelProbeResult: ModelProbeResult | null = modelProbeMutation.data?.probe ?? null;
  const modelProbeUsesSavedKey = !apiKey.trim() && modelKeyConfigured;

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
        value: modelKeyConfigured ? "模型理解 + 检索证据" : "检索优先，模型可补强",
      },
      {
        label: "B 站流程",
        value: bilibiliFlowLabel,
      },
    ],
    [
      bilibiliFlowLabel,
      chatModel,
      modelKeyConfigured,
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

    setBaseUrl(nextPreset.baseUrl);
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

  function handleLoadModelCatalog() {
    setLocalMessage("");
    modelCatalogMutation.mutate(
      {
        provider: OPENAI_COMPAT_PROVIDER,
        api_base_url: baseUrl.trim(),
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
      if (!asrBaseUrl.trim()) setAsrBaseUrl(baseUrl.trim());
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
    saveMutation.mutate({
      model: {
        provider: OPENAI_COMPAT_PROVIDER,
        chat_model: chatModel.trim(),
        embedding_model: embeddingModel.trim(),
        llm_api_base_url: baseUrl.trim(),
        ...(apiKey.trim() ? { llm_api_key: apiKey.trim() } : modelKeyConfigured ? {} : { llm_api_key: "" }),
      },
    });
  }

  function handleProbeModelConfig() {
    setLocalMessage("");
    modelProbeMutation.mutate({
      provider: OPENAI_COMPAT_PROVIDER,
      chat_model: chatModel.trim(),
      api_base_url: baseUrl.trim(),
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

  const canSaveModel = Boolean(baseUrl.trim() && chatModel.trim() && (apiKey.trim() || modelKeyConfigured));
  const canProbeModel = Boolean(baseUrl.trim() && chatModel.trim());
  const canLoadCatalog = Boolean(baseUrl.trim() && (apiKey.trim() || modelKeyConfigured));
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
              <p className="eyebrow">{displayText("主模型")}</p>
              <h3>{displayText("主模型")}</h3>
            </div>
          </div>

          <div className="settings-step-list">
            <section className="settings-step-card">
              <div className="settings-step-head">
                <div>
                  <p className="eyebrow">{displayText("连接方式")}</p>
                  <h4>{displayText("厂商")}</h4>
                </div>
                <span className="subtle-pill">{displayText(detectedPreset?.label || activePreset.label)}</span>
              </div>

              <div className="settings-provider-list">
                {PROVIDER_PRESETS.map((preset) => {
                  const active = preset.id === providerId;
                  return (
                    <button
                      key={preset.id}
                      className={active ? "settings-provider-option settings-provider-option-active" : "settings-provider-option"}
                      type="button"
                      onClick={() => applyProviderPreset(preset)}
                    >
                      <strong>{displayText(preset.label)}</strong>
                      <span>{displayText(preset.description)}</span>
                    </button>
                  );
                })}
              </div>
            </section>

            <section className="settings-step-card">
              <div className="settings-step-head">
                <div>
                  <p className="eyebrow">{displayText("凭证")}</p>
                  <h4>{displayText("API Key")}</h4>
                </div>
                <span className="subtle-pill">{displayText(modelKeyConfigured ? "已保存旧 Key" : "等待 Key")}</span>
              </div>

              <label className="form-block form-block-full">
                <span className="field-label">{displayText("API Key")}</span>
                <input
                  className="search-input"
                  type="password"
                  placeholder={displayText(modelKeyConfigured ? "留空则保留当前 Key" : "粘贴厂商提供的 API Key")}
                  value={apiKey}
                  onChange={(event) => setApiKey(event.target.value)}
                />
              </label>

              <div className="header-actions">
                <button
                  className="secondary-button"
                  type="button"
                  onClick={handleLoadModelCatalog}
                  disabled={modelCatalogMutation.isPending || !canLoadCatalog}
                >
                  {modelCatalogMutation.isPending ? displayText("读取中...") : displayText("读取模型列表")}
                </button>
                <button
                  className="secondary-button"
                  type="button"
                  onClick={handleProbeModelConfig}
                  disabled={modelProbeMutation.isPending || !canProbeModel}
                >
                  {modelProbeMutation.isPending ? displayText("测试中...") : displayText("测试连接")}
                </button>
              </div>
            </section>

            <section className="settings-step-card">
              <div className="settings-step-head">
                <div>
                  <p className="eyebrow">{displayText("模型")}</p>
                  <h4>{displayText("聊天模型")}</h4>
                </div>
                <span className="subtle-pill">{displayText(modelCatalog.length ? `已读取 ${modelCatalog.length} 个` : "可后置处理")}</span>
              </div>

              {!!modelCatalog.length && (
                <div className="pill-row settings-model-chip-row">
                  {modelCatalog.slice(0, 10).map((item) => (
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
            </section>
          </div>

          <div className="header-actions">
            <button
              className="primary-button"
              type="button"
              onClick={handleSaveModelConfig}
              disabled={saveMutation.isPending || !canSaveModel}
            >
              {saveMutation.isPending ? displayText("保存中...") : displayText("保存模型")}
            </button>
          </div>

          <details className="metadata-details advanced-details">
            <summary>{displayText("高级")}</summary>
            <div className="form-grid">
              <label className="form-block">
                <span className="field-label">{displayText("接口地址")}</span>
                <input className="search-input" value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} />
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

          {(modelCatalogMutation.isPending || modelCatalogMutation.isError || modelCatalog.length > 0) && (
            <article className="advanced-sheet settings-advanced-sheet">
              {modelCatalogMutation.isPending && <p className="muted-text">{displayText("读取模型中...")}</p>}
              {modelCatalogMutation.isError && <p className="error-text">{displayText((modelCatalogMutation.error as Error).message)}</p>}
              {modelCatalog.length > 0 && (
                <p className="muted-text">
                  {displayText(
                    modelCatalogUsesSavedKey ? "使用已保存 Key。" : "使用刚填写的 Key。",
                  )}
                </p>
              )}
            </article>
          )}

          {(modelProbeMutation.isPending || modelProbeMutation.isError || modelProbeResult) && (
            <article className="advanced-sheet settings-advanced-sheet">
              {modelProbeMutation.isPending && <p className="muted-text">{displayText("测试中...")}</p>}
              {modelProbeMutation.isError && <p className="error-text">{displayText((modelProbeMutation.error as Error).message)}</p>}
              {modelProbeResult && (
                <div className="simple-health-grid">
                  <article className="metric-card">
                    <span className="metric-label">{displayText("状态")}</span>
                    <strong>{displayText(modelProbeResult.http_status ? `HTTP ${modelProbeResult.http_status}` : "已返回")}</strong>
                  </article>
                  <article className="metric-card">
                    <span className="metric-label">{displayText("延迟")}</span>
                    <strong>{displayText(modelProbeResult.latency_ms !== null ? `${modelProbeResult.latency_ms} ms` : "未返回")}</strong>
                  </article>
                  <article className="metric-card">
                    <span className="metric-label">{displayText("实际模型")}</span>
                    <strong>{displayText(modelProbeResult.model || "未返回")}</strong>
                  </article>
                  {modelProbeUsesSavedKey && <p className="muted-text settings-inline-note">{displayText("使用已保存 Key。")}</p>}
                </div>
              )}
            </article>
          )}
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
