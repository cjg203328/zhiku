import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { getContents, getSettings, getSystemStatus, initSamples, listChatSessions } from "../lib/api";
import { useLanguage } from "../lib/language";

const overviewSections = [
  {
    key: "system",
    label: "服务与模型",
    title: "服务状态",
  },
  {
    key: "content",
    label: "知识内容",
    title: "内容入库",
  },
  {
    key: "session",
    label: "问答记录",
    title: "会话状态",
  },
] as const;

type SectionKey = (typeof overviewSections)[number]["key"];

type StatusCard = {
  title: string;
  value: string;
  detail: string;
  tone: "success" | "info" | "warning";
};

function getSectionStatusLabel(options: { ready: boolean; partial?: boolean }) {
  if (options.ready) return "已就绪";
  if (options.partial) return "可继续";
  return "待处理";
}

export default function OnboardingPage() {
  const { displayText } = useLanguage();
  const queryClient = useQueryClient();
  const [activeSection, setActiveSection] = useState<SectionKey>("system");
  const [sampleMessage, setSampleMessage] = useState("");

  const initSamplesMutation = useMutation({
    mutationFn: initSamples,
    onSuccess: async (result) => {
      await queryClient.invalidateQueries({ queryKey: ["contents"] });
      setSampleMessage(result.message);
    },
  });

  const settingsQuery = useQuery({ queryKey: ["settings"], queryFn: getSettings, retry: 1 });
  const statusQuery = useQuery({ queryKey: ["system-status"], queryFn: getSystemStatus, retry: 1 });
  const contentsQuery = useQuery({ queryKey: ["contents", "overview"], queryFn: () => getContents(), retry: 1 });
  const sessionsQuery = useQuery({ queryKey: ["chat-sessions", "overview"], queryFn: listChatSessions, retry: 1 });

  const serviceReady = statusQuery.data?.service_status === "ready";
  const chatModelReady = Boolean(statusQuery.data?.models.chat_model_ready);
  const modelConfigured = Boolean(settingsQuery.data?.model.llm_api_key_configured);
  const contentCount = contentsQuery.data?.total ?? 0;
  const sessionCount = sessionsQuery.data?.total ?? 0;
  const importReady = contentCount > 0;
  const sessionReady = sessionCount > 0;

  const suggestedSection = useMemo<SectionKey>(() => {
    if (!serviceReady || (!chatModelReady && !modelConfigured)) return "system";
    if (!importReady) return "content";
    if (!sessionReady) return "session";
    return "system";
  }, [chatModelReady, importReady, modelConfigured, serviceReady, sessionReady]);

  useEffect(() => {
    setActiveSection(suggestedSection);
  }, [suggestedSection]);

  const primaryAction = useMemo(() => {
    if (!serviceReady || (!chatModelReady && !modelConfigured)) {
      return {
        label: "打开设置",
        to: "/settings",
        summary: "服务或模型尚未完成连接。",
      };
    }
    if (!importReady) {
      return {
        label: "导入内容",
        to: "/library",
        summary: "知识库当前还没有内容。",
      };
    }
    if (!sessionReady) {
      return {
        label: "进入问答",
        to: "/chat",
        summary: "已有可用内容，但还没有会话记录。",
      };
    }
    return {
      label: "返回首页",
      to: "/",
      summary: "当前系统已进入可用状态。",
    };
  }, [chatModelReady, importReady, modelConfigured, serviceReady, sessionReady]);

  const overviewCards = useMemo(
    () => [
      {
        label: "服务",
        value: serviceReady ? "已连接" : "待连接",
      },
      {
        label: "模型",
        value: chatModelReady ? "已就绪" : modelConfigured ? "已保存" : "待配置",
      },
      {
        label: "内容",
        value: contentCount > 0 ? `${contentCount} 条` : "空",
      },
      {
        label: "会话",
        value: sessionReady ? `${sessionCount} 条` : "空",
      },
    ],
    [chatModelReady, contentCount, modelConfigured, serviceReady, sessionCount, sessionReady],
  );

  const systemCards = useMemo<StatusCard[]>(
    () => [
      {
        title: "服务",
        value: serviceReady ? "已连接" : "待连接",
        detail: serviceReady ? "本地服务可访问，导入与问答链路已开放。" : "当前未读到服务状态，导入与问答会受限。",
        tone: serviceReady ? "success" : "warning",
      },
      {
        title: "聊天模型",
        value: chatModelReady ? "已就绪" : modelConfigured ? "已保存" : "待配置",
        detail: chatModelReady ? "问答与整理能力已可用。" : modelConfigured ? "模型配置已保存，可做一次连接测试。" : "当前没有可用的聊天模型配置。",
        tone: chatModelReady ? "success" : modelConfigured ? "info" : "warning",
      },
      {
        title: "转写",
        value: statusQuery.data?.asr?.available || statusQuery.data?.asr?.configured ? "可用" : "待补齐",
        detail:
          statusQuery.data?.asr?.available || statusQuery.data?.asr?.configured
            ? "无字幕内容可以继续走转写链路。"
            : "没有转写能力时，无字幕内容会更容易停留在基础材料。",
        tone: statusQuery.data?.asr?.available || statusQuery.data?.asr?.configured ? "info" : "warning",
      },
    ],
    [chatModelReady, modelConfigured, serviceReady, statusQuery.data?.asr?.available, statusQuery.data?.asr?.configured],
  );

  const contentCards = useMemo<StatusCard[]>(
    () => [
      {
        title: "知识库",
        value: contentCount > 0 ? `${contentCount} 条内容` : "空",
        detail: contentCount > 0 ? "当前已有可浏览的知识内容和详情页。" : "当前还没有已入库内容。",
        tone: contentCount > 0 ? "success" : "warning",
      },
      {
        title: "最近导入",
        value: importReady ? "已形成结果" : "暂无结果",
        detail: importReady ? "导入后会在知识库与详情页显示阶段摘要、片段和关键画面。" : "导入完成后，这里会开始出现可阅读的笔记结果。",
        tone: importReady ? "info" : "warning",
      },
      {
        title: "样例数据",
        value: importReady ? "可选" : "可写入",
        detail: importReady ? "如需快速对照当前布局，仍可继续插入样例内容。" : "可以写入一条样例内容，用来查看工作台和问答链路。",
        tone: "info",
      },
    ],
    [contentCount, importReady],
  );

  const sessionCards = useMemo<StatusCard[]>(
    () => [
      {
        title: "会话记录",
        value: sessionReady ? `${sessionCount} 条` : "空",
        detail: sessionReady ? "当前已经有检索和回答记录可回看。" : "还没有问答会话记录。",
        tone: sessionReady ? "success" : "warning",
      },
      {
        title: "回答反馈",
        value: chatModelReady ? "可分析" : "待模型",
        detail: chatModelReady ? "回答会附带检索路径、证据命中和会话反馈。" : "模型未就绪时，回答会更偏向基础检索结果。",
        tone: chatModelReady ? "info" : "warning",
      },
      {
        title: "追问入口",
        value: importReady ? "可使用" : "待内容",
        detail: importReady ? "可以围绕单条内容、片段或全库继续追问。" : "至少需要一条内容入库后，问答体验才会完整。",
        tone: importReady ? "info" : "warning",
      },
    ],
    [chatModelReady, importReady, sessionCount, sessionReady],
  );

  const currentSection = useMemo(
    () => overviewSections.find((item) => item.key === activeSection) ?? overviewSections[0],
    [activeSection],
  );

  const currentCards = useMemo(() => {
    if (activeSection === "content") return contentCards;
    if (activeSection === "session") return sessionCards;
    return systemCards;
  }, [activeSection, contentCards, sessionCards, systemCards]);

  const currentSectionStatus = useMemo(() => {
    if (activeSection === "content") {
      return getSectionStatusLabel({ ready: importReady });
    }
    if (activeSection === "session") {
      return getSectionStatusLabel({ ready: sessionReady, partial: importReady });
    }
    return getSectionStatusLabel({ ready: serviceReady && (chatModelReady || modelConfigured), partial: serviceReady });
  }, [activeSection, chatModelReady, importReady, modelConfigured, serviceReady, sessionReady]);

  const quickLinks = [
    { label: "设置", to: "/settings" },
    { label: "知识库", to: "/library" },
    { label: "问答", to: "/chat" },
  ];

  return (
    <section className="page">
      <article className="card library-hero glass-hero onboarding-hero-card">
        <div className="library-hero-shell">
          <div className="library-hero-content">
            <div>
              <p className="eyebrow">{displayText("系统概览")}</p>
              <h2>{displayText("服务、内容、问答")}</h2>
            </div>

            <div className="product-overview-grid">
              {overviewCards.map((item) => (
                <article className="product-overview-card" key={item.label}>
                  <span>{displayText(item.label)}</span>
                  <strong>{displayText(item.value)}</strong>
                </article>
              ))}
            </div>

            <div className="header-actions">
              <Link className="primary-button button-link" to={primaryAction.to}>
                {displayText(primaryAction.label)}
              </Link>
              <Link className="secondary-button button-link" to="/library">
                {displayText("打开知识库")}
              </Link>
            </div>
          </div>
        </div>
      </article>

      <article className="card segment-card glass-panel sticky-segment-card">
        <div className="segment-rail">
          {overviewSections.map((item) => (
            <button
              key={item.key}
              type="button"
              className={activeSection === item.key ? "segment-pill segment-pill-active" : "segment-pill"}
              onClick={() => setActiveSection(item.key)}
            >
              {displayText(item.label)}
            </button>
          ))}
        </div>
      </article>

      <div className="card-grid onboarding-grid">
        <article className="card detail-section-card glass-panel onboarding-main-card">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">{displayText(currentSection.label)}</p>
              <h3>{displayText(currentSection.title)}</h3>
            </div>
            <span className="pill">{displayText(currentSectionStatus)}</span>
          </div>

          <div className="advice-grid">
            {currentCards.map((item) => (
              <article className="advice-card" key={`${activeSection}-${item.title}`}>
                <span className={`result-badge result-badge-${item.tone}`}>{displayText(item.title)}</span>
                <strong>{displayText(item.value)}</strong>
                <p>{displayText(item.detail)}</p>
              </article>
            ))}
          </div>

          {activeSection === "content" && !importReady && serviceReady && (
            <article className="glass-callout" style={{ marginTop: "var(--space-4)" }}>
              <strong>{displayText("样例内容")}</strong>
              <div className="header-actions" style={{ flexWrap: "wrap" }}>
                <Link className="primary-button button-link" to="/library">
                  {displayText("进入知识库")}
                </Link>
                <button
                  className="secondary-button"
                  type="button"
                  onClick={() => {
                    setSampleMessage("");
                    initSamplesMutation.mutate();
                  }}
                  disabled={initSamplesMutation.isPending}
                >
                  {initSamplesMutation.isPending ? displayText("写入中...") : displayText("写入样例")}
                </button>
              </div>
              {sampleMessage && <p className="muted-text" style={{ marginTop: "var(--space-2)" }}>{displayText(sampleMessage)}</p>}
            </article>
          )}
          <div className="header-actions onboarding-quick-actions">
            {quickLinks.map((item) => (
              <Link key={item.to} className="secondary-button button-link" to={item.to}>
                {displayText(item.label)}
              </Link>
            ))}
            <Link className="primary-button button-link" to={primaryAction.to}>
              {displayText(primaryAction.label)}
            </Link>
          </div>
        </article>
      </div>
    </section>
  );
}
