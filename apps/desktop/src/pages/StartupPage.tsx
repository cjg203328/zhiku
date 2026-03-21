import { useCallback, useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { getContents, getHealth, getSystemStatus, listChatSessions, listImportJobs } from "../lib/api";
import { readOnboardingStatus, shouldShowOnboarding, writeOnboardingStatus, type OnboardingStatus } from "../lib/onboarding";
import {
  ensureApiReady,
  getRuntimeInfo,
  isTauriRuntime,
  stopApiSidecar,
  type RuntimeInfo,
  type SidecarStatus,
} from "../lib/runtime";
import { useLanguage } from "../lib/language";

function getAsrCapabilityLabel(asr: {
  available?: boolean;
  configured?: boolean;
  selected?: boolean;
  config_mode?: string;
  local_engine?: string;
} | null | undefined) {
  if (!asr) {
    return "待配置";
  }
  if (asr.available || asr.configured) {
    if (asr.config_mode === "inherited") {
      return "复用主模型";
    }
    if (asr.config_mode === "local") {
      return asr.local_engine ? "本地转写" : "本地待就绪";
    }
    return "可用";
  }
  if (asr.config_mode === "local") {
    return "本地待就绪";
  }
  if (asr.selected) {
    return "待就绪";
  }
  return "待配置";
}

export default function StartupPage() {
  const { displayText } = useLanguage();
  const [startupMessage, setStartupMessage] = useState("正在准备本地服务...");
  const [startupError, setStartupError] = useState("");
  const [onboardingStatus, setOnboardingStatus] = useState<OnboardingStatus>(readOnboardingStatus);
  const [runtimeInfo, setRuntimeInfo] = useState<RuntimeInfo | null>(null);
  const [sidecarStatus, setSidecarStatus] = useState<SidecarStatus | null>(null);
  const [isBootstrapping, setIsBootstrapping] = useState(true);
  const [isStopping, setIsStopping] = useState(false);

  const healthQuery = useQuery({ queryKey: ["health"], queryFn: getHealth, retry: 1, enabled: false });
  const statusQuery = useQuery({
    queryKey: ["system-status"],
    queryFn: getSystemStatus,
    retry: 1,
    enabled: false,
  });
  const recentQuery = useQuery({
    queryKey: ["contents", "home-recent"],
    queryFn: () => getContents(),
    retry: 1,
    enabled: false,
  });
  const sessionsQuery = useQuery({
    queryKey: ["chat-sessions", "home"],
    queryFn: listChatSessions,
    retry: 1,
    enabled: false,
  });
  const pendingJobsQuery = useQuery({
    queryKey: ["import-jobs", "pending"],
    queryFn: () => listImportJobs(),
    retry: 1,
    enabled: false,
    refetchInterval: (query) => {
      const count = query.state.data?.pending_count ?? 0;
      return count > 0 ? 3000 : false;
    },
  });

  const runStartup = useCallback(async () => {
    setIsBootstrapping(true);
    setStartupError("");
    setStartupMessage("正在检查本地服务...");

    try {
      if (isTauriRuntime()) {
        const info = await getRuntimeInfo();
        setRuntimeInfo(info);
      } else {
        setRuntimeInfo(null);
      }

      const result = await ensureApiReady();
      setSidecarStatus(result.sidecar);

      if (result.mode === "tauri-sidecar") {
        setStartupMessage("内容准备就绪，现在可以开始导入。");
      } else if (result.mode === "external-api") {
        setStartupMessage("已连上本地服务，你可以继续使用。");
      } else {
        setStartupMessage("当前是纯网页模式，请先连接本地服务。");
      }

      const [healthResult, systemResult] = await Promise.all([healthQuery.refetch(), statusQuery.refetch()]);
      const isHealthy = healthResult.data?.status === "ok" && systemResult.data?.service_status === "ready";
      if (isHealthy) {
        await Promise.all([recentQuery.refetch(), sessionsQuery.refetch(), pendingJobsQuery.refetch()]);
      }
    } catch (error) {
      setStartupError(error instanceof Error ? error.message : "启动检查失败。");
      setStartupMessage("当前还没有连上本地服务，请先启动 连接状态 再回来。");
    } finally {
      setIsBootstrapping(false);
    }
  }, [healthQuery, pendingJobsQuery, recentQuery, sessionsQuery, statusQuery]);

  useEffect(() => {
    void runStartup();
  }, [runStartup]);

  async function handleStopSidecar() {
    setIsStopping(true);
    try {
      const result = await stopApiSidecar();
      setSidecarStatus(result);
      setStartupMessage("本地伴随服务已停止。");
      setStartupError("");
    } catch (error) {
      setStartupError(error instanceof Error ? error.message : "停止本地伴随服务失败。");
    } finally {
      setIsStopping(false);
    }
  }

  const runtimeLabel = useMemo(() => {
    if (!runtimeInfo) {
      return isTauriRuntime() ? "正在读取运行环境..." : "浏览器模式";
    }
    return `${runtimeInfo.app_name} ${runtimeInfo.app_version} · ${runtimeInfo.sidecar_mode}`;
  }, [runtimeInfo]);

  const isReady = healthQuery.data?.status === "ok" && statusQuery.data?.service_status === "ready";
  const recentItems = recentQuery.data?.items?.slice(0, 4) ?? [];
  const contentCount = recentQuery.data?.total ?? 0;
  const sessionCount = sessionsQuery.data?.total ?? 0;
  const pendingJobCount = pendingJobsQuery.data?.pending_count ?? 0;
  const modelReady = Boolean(statusQuery.data?.models.chat_model_ready);
  const showOnboarding = shouldShowOnboarding({
    onboardingStatus,
    contentCount,
    sessionCount,
    modelReady,
  });
  const onboardingAction = useMemo(() => {
    if (!isReady || !modelReady) {
      return {
        title: "先把服务和模型接稳",
        description: "先确认首页状态正常，再去设置页把模型连通性测通，后面的导入和问答体验才会稳定。",
        primaryLabel: "打开首次引导",
        primaryTo: "/onboarding",
        secondaryLabel: "去配置",
        secondaryTo: "/settings",
        badge: "步骤 1 / 3",
      };
    }
    if (contentCount === 0) {
      return {
        title: "先导入第一条内容",
        description: "优先用最容易成功的公开视频或稳定文件，先拿到第一条完整笔记，再判断体验是否值得继续。",
        primaryLabel: "打开首次引导",
        primaryTo: "/onboarding",
        secondaryLabel: "去知识库",
        secondaryTo: "/library",
        badge: "步骤 2 / 3",
      };
    }
    if (sessionCount === 0) {
      return {
        title: "用首轮问答做验收",
        description: "围绕整条内容和单个片段各问一轮，确认引用定位、详情回看和回答自然度都过关。",
        primaryLabel: "打开首次引导",
        primaryTo: "/onboarding",
        secondaryLabel: "去问答页",
        secondaryTo: "/chat",
        badge: "步骤 3 / 3",
      };
    }
    return {
      title: "主链路已经打通",
      description: "你已经具备继续导入、追问和沉淀内容的基础，可以按正常工作流继续使用。",
      primaryLabel: "查看首次引导",
      primaryTo: "/onboarding",
      secondaryLabel: "回到知识库",
      secondaryTo: "/library",
      badge: "已完成",
    };
  }, [contentCount, isReady, modelReady, sessionCount]);
  const capabilityItems = [
    { label: "服务", value: isReady ? "可用" : "未连接" },
    { label: "内容", value: String(contentCount) },
    { label: "问答", value: modelReady ? "可用" : "待配置" },
    {
      label: "转写",
      value: getAsrCapabilityLabel(statusQuery.data?.asr),
    },
  ];

  return (
    <section className="page home-page">
      {/* 顶部状态栏 */}
      <div className="home-status-bar">
        <div className="home-status-dot" style={{ background: isReady ? "var(--success)" : isBootstrapping ? "var(--warning)" : "var(--danger)" }} />
        <span className="home-status-text">
          {displayText(isBootstrapping ? "正在连接本地服务..." : startupMessage)}
        </span>
        <button
          className="btn btn-ghost btn-sm"
          type="button"
          onClick={() => void runStartup()}
          disabled={isBootstrapping}
          style={{ marginLeft: "auto" }}
        >
          {isBootstrapping ? displayText("检查中") : displayText("刷新状态")}
        </button>
        {isTauriRuntime() && (
          <button className="btn btn-ghost btn-sm" style={{ color: "var(--danger-text)" }} type="button" onClick={() => void handleStopSidecar()} disabled={isStopping}>
            {isStopping ? displayText("停止中") : displayText("停止服务")}
          </button>
        )}
      </div>

      {startupError && (
        <div className="home-error-bar">
          <span>{displayText(startupError)}</span>
          {isTauriRuntime() && (
            <button
              className="btn btn-ghost btn-sm"
              type="button"
              disabled={isBootstrapping || isStopping}
              onClick={async () => {
                setIsStopping(true);
                try {
                  await stopApiSidecar();
                } catch {}
                setIsStopping(false);
                await new Promise((r) => setTimeout(r, 800));
                void runStartup();
              }}
            >
              {displayText("重新启动服务")}
            </button>
          )}
        </div>
      )}

      {/* Hero 区域 */}
      <article className="home-hero">
        <div className="home-hero-text">
          <p className="eyebrow">{displayText("知库 · B站视频知识管理")}</p>
          <h1 className="home-hero-title">{displayText("把视频变成可以对话的知识")}</h1>
          <p className="home-hero-desc">{displayText("粘贴 B 站链接，自动提取字幕生成笔记，随时提问回溯。")}</p>
          <p className="muted-text">{displayText(runtimeLabel)}</p>
        </div>
        <div className="home-hero-actions">
          <Link className="btn btn-primary btn-lg" to="/library" style={{ position: "relative" }}>
            {displayText("导入视频")}
            {pendingJobCount > 0 && (
              <span className="task-badge">{pendingJobCount}</span>
            )}
          </Link>
          <Link className="btn btn-secondary btn-lg" to="/chat" style={{ opacity: isReady ? 1 : 0.5, pointerEvents: isReady ? "auto" : "none" }}>
            {displayText("开始提问")}
          </Link>
        </div>
      </article>

      {/* 能力卡片 */}
      <div className="home-capability-grid">
        {capabilityItems.map((item) => (
          <div className="home-cap-card" key={item.label}>
            <span className="home-cap-label">{displayText(item.label)}</span>
            <strong className="home-cap-value"
              style={{
                color: item.value === "可用" || item.value === "可使用" || item.value === "复用主模型" || item.value === "本地转写"
                  ? "var(--success-text)"
                  : item.value === "待配置" || item.value === "未连接"
                  ? "var(--warning-text)"
                  : "var(--text-primary)"
              }}
            >
              {displayText(item.value)}
            </strong>
          </div>
        ))}
      </div>

      {/* 最近内容 */}
      {recentItems.length > 0 && (
        <div className="home-recent">
          <div className="home-recent-header">
            <p className="eyebrow" style={{ marginBottom: "10px" }}>{displayText("最近导入")}</p>
            {contentCount > 4 && (
              <Link to="/library" className="link-inline" style={{ fontSize: "12px" }}>
                {displayText(`查看全部 ${contentCount} 条`)}
              </Link>
            )}
          </div>
          <div className="home-recent-list">
            {recentItems.map((item) => (
              <Link key={item.id} to={`/library/${item.id}`} className="home-recent-item">
                <span className="home-recent-title">{displayText(item.title)}</span>
                <span className="home-recent-source">{displayText(item.platform ?? item.source_type ?? "")}</span>
              </Link>
            ))}
          </div>
        </div>
      )}

      {/* 首次引导 */}
      {showOnboarding && (
        <div className="home-guide-card">
          <span className="home-guide-icon">◎</span>
          <div className="home-guide-copy">
            <div className="home-guide-meta">
              <strong>{displayText("现在最值得做的下一步")}</strong>
              <span className="pill">{displayText(onboardingAction.badge)}</span>
            </div>
            <strong>{displayText(onboardingAction.title)}</strong>
            <p className="muted-text">{displayText(onboardingAction.description)}</p>
          </div>
          <div className="home-guide-actions">
            <Link className="btn btn-primary btn-sm" to={onboardingAction.primaryTo}>
              {displayText(onboardingAction.primaryLabel)}
            </Link>
            <Link className="btn btn-secondary btn-sm" to={onboardingAction.secondaryTo}>
              {displayText(onboardingAction.secondaryLabel)}
            </Link>
            {onboardingStatus !== "completed" && (
              <button
                className="btn btn-ghost btn-sm"
                type="button"
                onClick={() => {
                  writeOnboardingStatus("dismissed");
                  setOnboardingStatus("dismissed");
                }}
              >
                {displayText("稍后再看")}
              </button>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
