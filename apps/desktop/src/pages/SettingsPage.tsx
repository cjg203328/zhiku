import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import {
  createBackup,
  exportDiagnostics,
  fetchModelCatalog,
  getBilibiliStatus,
  getModelStatus,
  getSettings,
  openBilibiliBridgeHelper,
  getSystemStatus,
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
    hint: "需先本地安装 Ollama 并拉取模型。",
    chatModel: "qwen2.5:7b",
    chatOptions: ["qwen2.5:7b", "qwen2.5:14b", "llama3.2:3b", "deepseek-r1:7b"],
    embeddingModel: "bge-m3",
    baseUrl: "http://localhost:11434/v1",
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    description: "性价比高，适合长文档理解和中文问答。",
    hint: "先填 Key，再读取可用模型。",
    chatModel: "deepseek-chat",
    chatOptions: ["deepseek-chat", "deepseek-reasoner"],
    embeddingModel: DEFAULT_EMBEDDING_MODEL,
    baseUrl: "https://api.deepseek.com/v1",
  },
  {
    id: "moonshot",
    label: "Moonshot",
    description: "适合把视频和网页整理成更自然的中文回答。",
    hint: "先填 Key，再读取可用模型。",
    chatModel: "kimi-latest",
    chatOptions: ["kimi-latest"],
    embeddingModel: DEFAULT_EMBEDDING_MODEL,
    baseUrl: "https://api.moonshot.cn/v1",
  },
  {
    id: "zhipu",
    label: "智谱",
    description: "适合先快速接通在线理解和问答链路。",
    hint: "支持先按厂商接入，再自由换模型。",
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
  const saveMutation = useMutation({
    mutationFn: updateSettings,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["settings"] });
      await queryClient.invalidateQueries({ queryKey: ["bilibili-status"] });
      setLocalMessage("配置已保存。");
      pageTopRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    },
  });

  const [localMessage, setLocalMessage] = useState("");
  const [settingsGuided, setSettingsGuided] = useState(() => {
    try { return localStorage.getItem("zhiku_settings_guided") === "true"; } catch { return false; }
  });
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
  const browserBridgeSummary =
    bilibiliStatusQuery.data?.browser_bridge_summary ||
    bilibiliSettings?.browser_bridge_summary ||
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
    : "先走公开链路";
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
  const bilibiliModeDescription = browserBridgeEnabled
    ? browserBridgeActive
      ? browserBridgeSummary || "知库会在导入时自动补全需要登录才能看到的字幕和正文。"
      : "安装一次浏览器小助手后，知库会自动接收当前浏览器的临时登录状态，不需要你长期保存 Cookie。"
    : cookieEnabled
    ? cookieReady
      ? "当前会在公开链路不够时，继续使用你手动提供的登录状态。"
      : "你已经打开手动方式，但还没有填入可用内容；保存后仍会退回公开链路。"
    : bilibiliCookieStored
    ? "当前已保存手动登录状态，但默认不会参与抓取。"
    : "默认先走公开可见内容，不会主动读取你的登录状态。";
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

  const sideSummaryItems = useMemo(
    () => [
      {
        label: "厂商",
        value: detectedPreset?.label || (isKnownPreset(providerId) ? activePreset.label : "自定义接口"),
      },
      {
        label: "聊天模型",
        value: chatModel.trim() || "保存后可继续调整",
      },
      {
        label: "向量模型",
        value: embeddingModel.trim() || DEFAULT_EMBEDDING_MODEL,
      },
      {
        label: "转写模式",
        value: getAsrChoiceLabel(asrModeChoice),
      },
    ],
    [activePreset.label, asrModeChoice, chatModel, detectedPreset?.label, embeddingModel, providerId],
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
      setLocalMessage("已切换为自定义接口，你可以自己填写地址，再读取模型列表。");
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
    setLocalMessage(`已切到 ${nextPreset.label}，现在只需要补 API Key。`);
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

  const modelStepHint = modelCatalog.length
    ? "已读取到模型列表，直接点选或手动改模型名即可。"
    : activePreset.chatModel
    ? `暂时不确定模型名时，可以先用系统预填的 ${activePreset.chatModel}。`
    : "如果你还不知道模型名，先保存 Key，再点“读取模型列表”。";
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
            <h2>{displayText("模型与采集")}</h2>
            <p className="muted-text">
              {displayText("先接主模型，再决定是否补转写和 B 站登录状态。")}
            </p>
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

        <div className="result-callout settings-top-helper-callout">
          <strong>
            {displayText(
              browserBridgeActive
                ? `B 站小助手已连上 ${browserBridgeSourceLabel || "当前浏览器"}`
                : "B 站小助手入口在这里",
            )}
          </strong>
          <p>
            {displayText(
              browserBridgeActive
                ? "现在已经拿到浏览器登录状态了。后面导入需要登录的视频时，知库会优先自动补全。"
                : "不用往下翻。点下面这个按钮，就会直接打开浏览器扩展页和小助手目录。",
            )}
          </p>
          <div className="header-actions settings-top-helper-actions">
            <button
              className="primary-button"
              type="button"
              onClick={() => openBilibiliHelperMutation.mutate()}
              disabled={openBilibiliHelperMutation.isPending}
            >
              {openBilibiliHelperMutation.isPending ? displayText("打开中...") : displayText("一键打开小助手")}
            </button>
            <button
              className="secondary-button"
              type="button"
              onClick={jumpToBilibiliSection}
            >
              {displayText("定位到 B 站设置")}
            </button>
            <button
              className="secondary-button"
              type="button"
              onClick={() => void bilibiliStatusQuery.refetch()}
              disabled={bilibiliStatusQuery.isFetching}
            >
              {bilibiliStatusQuery.isFetching ? displayText("刷新中...") : displayText("刷新连接状态")}
            </button>
          </div>
        </div>

        {!settingsGuided && (
          <div style={{
            display: "flex", alignItems: "center", gap: "var(--space-2)",
            marginBottom: "var(--space-4)", padding: "12px 16px",
            background: "var(--bg-elevated)", borderRadius: "var(--radius-md)",
            border: "1px solid var(--border)",
          }}>
            {([
              { label: "选择模型", done: providerId !== "custom" || Boolean(baseUrl.trim()) },
              { label: "填写 Key", done: Boolean(apiKey.trim()) || modelKeyConfigured },
              { label: "测试连通", done: modelProbeResult?.ok === true },
            ] as { label: string; done: boolean }[]).map((step, i) => (
              <div key={step.label} style={{ display: "flex", alignItems: "center", gap: "var(--space-2)", flex: 1 }}>
                <span style={{
                  width: 22, height: 22, borderRadius: "50%", display: "flex",
                  alignItems: "center", justifyContent: "center", fontSize: "0.75rem",
                  background: step.done ? "var(--accent)" : "var(--bg-base)",
                  color: step.done ? "#fff" : "var(--text-muted)",
                  border: step.done ? "none" : "1px solid var(--border)",
                  flexShrink: 0,
                }}>{step.done ? "✓" : i + 1}</span>
                <span style={{ fontSize: "0.8rem", color: step.done ? "var(--text-primary)" : "var(--text-muted)" }}>
                  {step.label}
                </span>
                {i < 2 && <div style={{ flex: 1, height: 1, background: "var(--border)" }} />}
              </div>
            ))}
            {modelProbeResult?.ok === true && (
              <button
                type="button"
                style={{ marginLeft: "auto", fontSize: "0.75rem", color: "var(--text-muted)", background: "none", border: "none", cursor: "pointer", whiteSpace: "nowrap" }}
                onClick={() => {
                  try { localStorage.setItem("zhiku_settings_guided", "true"); } catch {}
                  setSettingsGuided(true);
                }}
              >不再显示</button>
            )}
          </div>
        )}

        {settingsQuery.isLoading && <p className="muted-text">{displayText("正在读取设置...")}</p>}
        {settingsQuery.isError && <p className="error-text">{displayText("当前还没读到设置，请先确认本地服务已启动。")}</p>}
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
              <h3>{displayText("先接主模型")}</h3>
            </div>
          </div>

          <div className="settings-step-list">
            <section className="settings-step-card">
              <div className="settings-step-head">
                <div>
                  <p className="eyebrow">{displayText("步骤 1")}</p>
                  <h4>{displayText("选择厂商")}</h4>
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
                  <p className="eyebrow">{displayText("步骤 2")}</p>
                  <h4>{displayText("填入 API Key")}</h4>
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
                  <p className="eyebrow">{displayText("步骤 3")}</p>
                  <h4>{displayText("选择模型")}</h4>
                </div>
                <span className="subtle-pill">{displayText(modelCatalog.length ? `已读取 ${modelCatalog.length} 个` : "可后置处理")}</span>
              </div>

              <p className="muted-text">{displayText(modelStepHint)}</p>

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
            <summary>{displayText("高级设置")}</summary>
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
                      ⚠ 当前向量模型（{embeddingModel}）与建立索引时的模型（{statusQuery.data.models.index_embedding_model}）不一致，检索质量可能受影响。
                    </span>
                    <button
                      type="button"
                      className="btn btn-sm btn-secondary"
                      onClick={() => reindexMutation.mutate()}
                      disabled={reindexMutation.isPending}
                      style={{ flexShrink: 0 }}
                    >
                      {reindexMutation.isPending ? "重建中…" : "立即重建"}
                    </button>
                  </div>
                )}
              </label>
            </div>
          </details>

          {(modelCatalogMutation.isPending || modelCatalogMutation.isError || modelCatalog.length > 0) && (
            <article className="advanced-sheet settings-advanced-sheet">
              {modelCatalogMutation.isPending && <p className="muted-text">{displayText("正在读取厂商可用模型，请稍候。")}</p>}
              {modelCatalogMutation.isError && <p className="error-text">{displayText((modelCatalogMutation.error as Error).message)}</p>}
              {modelCatalog.length > 0 && (
                <p className="muted-text">
                  {displayText(
                    modelCatalogUsesSavedKey ? "本次读取使用的是已保存 Key。" : "本次读取使用的是你刚刚填写的 Key。",
                  )}
                </p>
              )}
            </article>
          )}

          {(modelProbeMutation.isPending || modelProbeMutation.isError || modelProbeResult) && (
            <article className="advanced-sheet settings-advanced-sheet">
              {modelProbeMutation.isPending && <p className="muted-text">{displayText("正在发起真实请求，请稍候。")}</p>}
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
                  {modelProbeUsesSavedKey && (
                    <p className="muted-text settings-inline-note">{displayText("这次连通性测试使用的是已保存 Key。")}</p>
                  )}
                </div>
              )}
            </article>
          )}
        </article>

        <aside className="card detail-section-card glass-panel settings-side-card">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">{displayText("当前模式")}</p>
              <h3>{displayText("你现在的配置")}</h3>
            </div>
          </div>

          <div className="settings-side-list">
            {sideSummaryItems.map((item) => (
              <article className="settings-side-item" key={item.label}>
                <span>{displayText(item.label)}</span>
                <strong>{displayText(item.value)}</strong>
              </article>
            ))}
          </div>

          <div className="glass-callout">
            <strong>{displayText("推荐用法")}</strong>
            <p>{displayText("视频和网页先交给模型做理解，再用检索负责证据和回看。")}</p>
            <p className="muted-text">{displayText(activePreset.hint)}</p>
          </div>
        </aside>
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
              <h3>{displayText("补正文方式")}</h3>
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
              <p className="muted-text">{displayText(asrSettings?.summary?.trim() || "没有字幕时，系统会在这里决定如何恢复正文。")}</p>
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

          {asrModeChoice === "shared" && (
            <div className="result-callout">
              <strong>{displayText("最省事")}</strong>
              <p>{displayText("直接复用主模型，适合先把链路跑通。")}</p>
            </div>
          )}

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
              <h3>{displayText("自动连接更省事")}</h3>
            </div>
          </div>

          <div className="result-callout">
            <strong>{displayText("推荐做法：安装一次浏览器小助手")}</strong>
            <p>{displayText("装好后，知库会自动接收当前浏览器的临时登录状态。平时不用手动找 Cookie。")}</p>
          </div>

          <div className="settings-provider-card">
            <div>
              <strong>{displayText(bilibiliModeTitle)}</strong>
              <p className="muted-text">{displayText(bilibiliModeDescription)}</p>
            </div>
            <span className="subtle-pill">{displayText(browserBridgeEnabled ? "自动连接" : "公开优先")}</span>
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
              { value: true, label: "自动连接浏览器（推荐）" },
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
                      ? `当前来源：${browserBridgeSourceLabel || "浏览器小助手"}`
                      : "还没有收到浏览器登录状态",
                  )}
                </strong>
                <p>
                  {displayText(
                    browserBridgeActive
                      ? "知库会优先使用这份临时登录状态补全需要登录的视频，不会长期保存在本地。"
                      : "先把本地浏览器小助手装好并保持启用。之后你只要打开过一次 B 站页面，知库通常就会自动连上。",
                  )}
                </p>
                {!!browserBridgeLastSeen && (
                  <p className="muted-text">
                    {displayText(`最近同步：${new Date(browserBridgeLastSeen).toLocaleString()}`)}
                  </p>
                )}
              </div>

              {!browserBridgeActive && (
                <div className="result-callout" style={{ borderColor: "var(--warning, #f59e0b)" }}>
                  <strong>{displayText("第一次这样做就行")}</strong>
                  <ol className="muted-text" style={{ paddingLeft: "1.2em", margin: "6px 0 0", lineHeight: 1.8 }}>
                    <li>{displayText("打开浏览器扩展管理页，加载本地小助手目录")}</li>
                    <li>{displayText("保持小助手开启，然后打开一次 bilibili.com")}</li>
                    <li>{displayText("回到这里点“刷新连接状态”，看到已连上就可以了")}</li>
                  </ol>
                </div>
              )}

              <div className="glass-callout">
                <strong>{displayText("本地小助手目录")}</strong>
                <p className="muted-text">{displayText(browserBridgeExtensionDir || "当前环境还没有提供目录信息。")}</p>
                {!!browserBridgeInstallDoc && (
                  <p className="muted-text">{displayText(`安装说明：${browserBridgeInstallDoc}`)}</p>
                )}
              </div>
            </>
          )}

          <details className="metadata-details advanced-details">
            <summary>{displayText("手动方式（高级）")}</summary>
            <p className="muted-text settings-inline-note">
              {displayText("只有在自动连接不方便时，再手动补登录状态。")}
            </p>

            <div className="segment-rail">
              {[
                { value: false, label: "手动方式关闭" },
                { value: true, label: "启用手动登录状态" },
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
                <span className="field-label">{displayText("或直接粘贴完整内容")}</span>
                <textarea
                  className="text-area"
                  rows={4}
                  placeholder={displayText("仅供你自己的本地验证使用。")}
                  value={cookieInline}
                  onChange={(event) => setCookieInline(event.target.value)}
                />
              </label>
            </div>

            {!cookieReady && cookieEnabled && (
              <div className="result-callout" style={{ borderColor: "var(--warning, #f59e0b)" }}>
                <strong>{displayText("如何手动获取")}</strong>
                <ol className="muted-text" style={{ paddingLeft: "1.2em", margin: "6px 0 0", lineHeight: 1.8 }}>
                  <li>{displayText("浏览器访问 bilibili.com 并登录")}</li>
                  <li>{displayText("按 F12 打开开发者工具 → Network 标签")}</li>
                  <li>{displayText("刷新页面，点任意请求 → Headers → Request Headers")}</li>
                  <li>{displayText("找到 \"cookie\" 字段，复制整行内容粘贴到上面")}</li>
                </ol>
              </div>
            )}
            {bilibiliCookieStored && !cookieEnabled && (
              <p className="muted-text settings-inline-note">
                {displayText("当前已保存手动登录状态，但默认不会参与采集。")}
              </p>
            )}
          </details>

          <div className="header-actions">
            <button className="primary-button" type="button" onClick={handleSaveBilibiliConfig} disabled={saveMutation.isPending}>
              {saveMutation.isPending ? displayText("保存中...") : displayText("保存 B 站连接")}
            </button>
            <button
              className="secondary-button"
              type="button"
              onClick={() => openBilibiliHelperMutation.mutate()}
              disabled={openBilibiliHelperMutation.isPending}
            >
              {openBilibiliHelperMutation.isPending ? displayText("打开中...") : displayText("一键打开小助手")}
            </button>
            <button
              className="secondary-button"
              type="button"
              onClick={() => void bilibiliStatusQuery.refetch()}
              disabled={bilibiliStatusQuery.isFetching}
            >
              {bilibiliStatusQuery.isFetching ? displayText("刷新中...") : displayText("刷新连接状态")}
            </button>
            {!!browserBridgeExtensionDir && (
              <button
                className="secondary-button"
                type="button"
                onClick={() => void handleCopy(browserBridgeExtensionDir, "浏览器小助手目录")}
              >
                {displayText("复制小助手目录")}
              </button>
            )}
            {!!browserBridgeInstallDoc && (
              <button
                className="secondary-button"
                type="button"
                onClick={() => void handleCopy(browserBridgeInstallDoc, "安装说明路径")}
              >
                {displayText("复制安装说明")}
              </button>
            )}
          </div>
        </article>
      </div>

      <details className="card detail-section-card glass-panel maintenance-details">
        <summary>{displayText("维护")}</summary>

        <article className="backup-status-card">
          <div className="backup-status-info">
            <strong>{displayText("知识库备份")}</strong>
            {backupMutation.isSuccess ? (
              <p className="muted-text">
                {displayText("上次备份")}：{new Date(backupMutation.data.created_at).toLocaleString()}<br />
                <span className="backup-path">{backupMutation.data.archive_path}</span>
              </p>
            ) : (
              <p className="muted-text">{displayText("尚未备份 — 点击右侧按钮手动生成备份文件。")}</p>
            )}
            {backupMutation.isError && <p className="error-text">{displayText("备份失败，请稍后再试。")}</p>}
          </div>
          <button className="secondary-button" type="button" onClick={() => backupMutation.mutate()} disabled={backupMutation.isPending}>
            {backupMutation.isPending ? displayText("备份中...") : displayText("立即备份")}
          </button>
        </article>

        {statusQuery.data?.index?.needs_rebuild && (
          <div className="field-hint field-hint-warning" style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
            <span style={{ flex: 1 }}>
              ⚠ 检测到 {statusQuery.data.index.chunks_count} 个内容片段但向量索引文件不存在，语义检索暂时不可用。
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
            {diagnosticsMutation.isPending ? displayText("导出中...") : displayText("导出排查信息")}
          </button>
          {settingsQuery.data && (
            <>
              <button
                className="secondary-button"
                type="button"
                onClick={() => void handleCopy(settingsQuery.data.knowledge_base_dir, "知识库目录")}
              >
                {displayText("复制知识库目录")}
              </button>
              <button
                className="secondary-button"
                type="button"
                onClick={() => void handleCopy(settingsQuery.data.export_dir, "导出目录")}
              >
                {displayText("复制导出目录")}
              </button>
            </>
          )}
        </div>
      </details>
    </section>
  );
}
