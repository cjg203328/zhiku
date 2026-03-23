import { useCallback, useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { getContents, getHealth, getSystemStatus, listImportJobs } from "../lib/api";
import {
  ensureApiReady,
  getRuntimeInfo,
  isTauriRuntime,
  stopApiSidecar,
  type RuntimeInfo,
} from "../lib/runtime";
import { useLanguage } from "../lib/language";

type HomeStatusTone = "success" | "warning" | "default";

function getAsrCapabilityMeta(asr: {
  available?: boolean;
  configured?: boolean;
  selected?: boolean;
  config_mode?: string;
  local_engine?: string;
} | null | undefined): { value: string; tone: HomeStatusTone } {
  if (!asr) {
    return { value: "待配置", tone: "warning" };
  }
  if (asr.available || asr.configured) {
    if (asr.config_mode === "inherited") {
      return { value: "复用主模型", tone: "success" };
    }
    if (asr.config_mode === "local") {
      return { value: asr.local_engine ? "本地转写" : "本地待就绪", tone: "success" };
    }
    return { value: "可用", tone: "success" };
  }
  if (asr.config_mode === "local") {
    return { value: "本地待就绪", tone: "warning" };
  }
  if (asr.selected) {
    return { value: "待就绪", tone: "warning" };
  }
  return { value: "待配置", tone: "warning" };
}

function getToneColor(tone: HomeStatusTone) {
  if (tone === "success") {
    return "var(--success-text)";
  }
  if (tone === "warning") {
    return "var(--warning-text)";
  }
  return "var(--text-primary)";
}

export default function StartupPage() {
  const { displayText } = useLanguage();
  const [startupMessage, setStartupMessage] = useState("正在准备本地服务...");
  const [startupError, setStartupError] = useState("");
  const [runtimeInfo, setRuntimeInfo] = useState<RuntimeInfo | null>(null);
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

      if (result.mode === "tauri-sidecar") {
        setStartupMessage("本地服务已就绪。");
      } else if (result.mode === "external-api") {
        setStartupMessage("已连接到本地服务。");
      } else {
        setStartupMessage("当前为网页模式，需要连接本地服务。");
      }

      const [healthResult, systemResult] = await Promise.all([healthQuery.refetch(), statusQuery.refetch()]);
      const isHealthy = healthResult.data?.status === "ok" && systemResult.data?.service_status === "ready";

      if (isHealthy) {
        await Promise.all([recentQuery.refetch(), pendingJobsQuery.refetch()]);
      }
    } catch (error) {
      setStartupError(error instanceof Error ? error.message : "启动检查失败。");
      setStartupMessage("当前尚未连接到本地服务。");
    } finally {
      setIsBootstrapping(false);
    }
  }, [healthQuery, pendingJobsQuery, recentQuery, statusQuery]);

  useEffect(() => {
    void runStartup();
  }, [runStartup]);

  async function handleStopSidecar() {
    setIsStopping(true);
    try {
      await stopApiSidecar();
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
  const latestItem = recentItems[0] ?? null;
  const contentCount = recentQuery.data?.total ?? 0;
  const pendingJobCount = pendingJobsQuery.data?.pending_count ?? 0;
  const modelReady = Boolean(statusQuery.data?.models.chat_model_ready);
  const asrCapability = getAsrCapabilityMeta(statusQuery.data?.asr);

  const capabilityItems = [
    { label: "服务", value: isReady ? "可用" : "未连接", tone: isReady ? "success" : "warning" as HomeStatusTone },
    { label: "内容", value: `${contentCount} 条`, tone: "default" as HomeStatusTone },
    { label: "问答", value: modelReady ? "可用" : "待配置", tone: modelReady ? "success" : "warning" as HomeStatusTone },
    { label: "转写", value: asrCapability.value, tone: asrCapability.tone },
  ];

  const shortcutItems = [
    {
      title: "内容库",
      description: "导入 / 查看",
      to: "/library",
      cta: "进入",
      badge: pendingJobCount > 0 ? String(pendingJobCount) : "",
    },
    {
      title: "问答",
      description: isReady ? "继续" : "待连接",
      to: isReady ? "/chat" : "/settings",
      cta: isReady ? "进入" : "去设置",
      muted: !isReady,
    },
    {
      title: "设置",
      description: "模型 / 桥接",
      to: "/settings",
      cta: "打开",
    },
    latestItem
      ? {
          title: "继续查看",
          description: latestItem.title,
          to: `/library/${latestItem.id}`,
          cta: "打开",
        }
      : {
          title: "回收站",
          description: "恢复或清理",
          to: "/trash",
          cta: "查看",
        },
  ];

  return (
    <section className="page home-page">
      <div className="home-status-bar">
        <div
          className="home-status-dot"
          style={{ background: isReady ? "var(--success)" : isBootstrapping ? "var(--warning)" : "var(--danger)" }}
        />
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
          <button
            className="btn btn-ghost btn-sm"
            style={{ color: "var(--danger-text)" }}
            type="button"
            onClick={() => void handleStopSidecar()}
            disabled={isStopping}
          >
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
                await new Promise((resolve) => setTimeout(resolve, 800));
                void runStartup();
              }}
            >
              {displayText("重新启动服务")}
            </button>
          )}
        </div>
      )}

      <article className="card card-static home-launchpad">
        <div className="home-launchpad-head">
          <div className="home-launchpad-copy">
            <h1 className="home-launchpad-title">{displayText("知库")}</h1>
            <p className="muted-text home-runtime-text">{displayText(runtimeLabel)}</p>
          </div>

          <div className="home-metric-grid">
            {capabilityItems.map((item) => (
              <div className="home-metric-card" key={item.label}>
                <span className="home-metric-label">{displayText(item.label)}</span>
                <strong className="home-metric-value" style={{ color: getToneColor(item.tone) }}>
                  {displayText(item.value)}
                </strong>
              </div>
            ))}
          </div>
        </div>

        <div className="home-shortcut-grid">
          {shortcutItems.map((item) => (
            <Link
              key={`${item.title}-${item.to}`}
              to={item.to}
              className={item.muted ? "home-shortcut-card home-shortcut-card-muted" : "home-shortcut-card"}
            >
              <div className="home-shortcut-head">
                <strong className="home-shortcut-title">{displayText(item.title)}</strong>
                {item.badge ? <span className="home-shortcut-badge">{item.badge}</span> : null}
              </div>
              <p className="home-shortcut-desc">{displayText(item.description)}</p>
              <span className="home-shortcut-cta">{displayText(item.cta)}</span>
            </Link>
          ))}
        </div>
      </article>
    </section>
  );
}
