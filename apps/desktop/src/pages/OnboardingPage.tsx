import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { getContents, getSettings, getSystemStatus, initSamples, listChatSessions } from "../lib/api";
import { readOnboardingStatus, writeOnboardingStatus, type OnboardingStatus } from "../lib/onboarding";
import { useLanguage } from "../lib/language";

const onboardingSteps = [
  {
    key: "ready",
    label: "确认环境",
    title: "先把本地服务和问答能力接稳",
    description: "只有服务稳定、模型路径清楚，后面的导入和问答体验才不会断。",
  },
  {
    key: "import",
    label: "导入内容",
    title: "先导入一条最容易成功的内容",
    description: "优先公开、表达清晰、结构明显的 B 站视频或稳定文件，先打通首条链路。",
  },
  {
    key: "verify",
    label: "验证价值",
    title: "确认笔记、引用和追问真的能用",
    description: "不是看页面有没有结果，而是判断内容是否值得留下、是否能继续追问。",
  },
] as const;

type StepKey = (typeof onboardingSteps)[number]["key"];

function getStatusLabel(options: { done: boolean; blocked?: boolean; waiting?: boolean }) {
  if (options.done) return "已完成";
  if (options.blocked) return "待处理";
  if (options.waiting) return "可继续";
  return "进行中";
}

export default function OnboardingPage() {
  const { displayText } = useLanguage();
  const queryClient = useQueryClient();
  const [activeStep, setActiveStep] = useState<StepKey>("ready");
  const [onboardingStatus, setOnboardingStatus] = useState<OnboardingStatus>(readOnboardingStatus);
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
  const contentsQuery = useQuery({ queryKey: ["contents", "onboarding"], queryFn: () => getContents(), retry: 1 });
  const sessionsQuery = useQuery({ queryKey: ["chat-sessions", "onboarding"], queryFn: listChatSessions, retry: 1 });

  const serviceReady = statusQuery.data?.service_status === "ready";
  const chatModelReady = Boolean(statusQuery.data?.models.chat_model_ready);
  const modelConfigured = Boolean(settingsQuery.data?.model.llm_api_key_configured);
  const contentCount = contentsQuery.data?.total ?? 0;
  const sessionCount = sessionsQuery.data?.total ?? 0;
  const importReady = contentCount > 0;
  const verifyReady = sessionCount > 0;

  const currentStep = useMemo(
    () => onboardingSteps.find((item) => item.key === activeStep) ?? onboardingSteps[0],
    [activeStep],
  );

  const currentAction = useMemo(() => {
    if (!serviceReady || (!chatModelReady && !modelConfigured)) {
      return {
        label: "去设置页补齐能力",
        to: "/settings",
        hint: "先把服务和主模型接好，再开始导入。",
        step: "ready" as StepKey,
      };
    }
    if (!importReady) {
      return {
        label: "去导入第一条内容",
        to: "/library",
        hint: "优先导入公开视频或稳定文件，先拿到第一条完整笔记。",
        step: "import" as StepKey,
      };
    }
    if (!verifyReady) {
      return {
        label: "去问答页验证效果",
        to: "/chat",
        hint: "围绕整条内容和单个片段各问一轮，确认引用和回看是否自然。",
        step: "verify" as StepKey,
      };
    }
    return {
      label: "回到首页继续使用",
      to: "/",
      hint: "主链路已经打通，现在可以按正常工作流继续用了。",
      step: "verify" as StepKey,
    };
  }, [chatModelReady, importReady, modelConfigured, serviceReady, verifyReady]);

  useEffect(() => {
    setActiveStep(currentAction.step);
  }, [currentAction.step]);

  useEffect(() => {
    if (serviceReady && importReady && verifyReady && onboardingStatus !== "completed") {
      writeOnboardingStatus("completed");
      setOnboardingStatus("completed");
    }
  }, [importReady, onboardingStatus, serviceReady, verifyReady]);

  const capabilitySummary = useMemo(
    () => [
      {
        label: "服务状态",
        value: serviceReady ? "已连接" : "待连接",
        hint: serviceReady ? "本地 sidecar 已可用" : "先回首页检查启动状态",
      },
      {
        label: "问答能力",
        value: chatModelReady ? "模型已就绪" : modelConfigured ? "已保存待验证" : "待配置",
        hint: chatModelReady ? "可直接做理解型问答" : modelConfigured ? "建议再做一次连接测试" : "先去设置页补 Key 或模型",
      },
      {
        label: "知识库",
        value: contentCount > 0 ? `${contentCount} 条内容` : "还没有内容",
        hint: contentCount > 0 ? "可以继续看详情和提问" : "先导入第一条内容",
      },
      {
        label: "验证进度",
        value: verifyReady ? `${sessionCount} 条会话` : "还没开始问答",
        hint: verifyReady ? "说明你已经做过首轮验证" : "建议围绕首条内容试一轮问答",
      },
    ],
    [chatModelReady, contentCount, modelConfigured, serviceReady, sessionCount, verifyReady],
  );

  const checklist = useMemo(
    () => [
      {
        key: "ready",
        title: "环境与模型",
        done: serviceReady && (chatModelReady || modelConfigured),
        summary: serviceReady
          ? chatModelReady
            ? "服务和问答模型都已经就绪。"
            : modelConfigured
            ? "服务正常，模型配置已保存，建议再做一次连通性测试。"
            : "服务正常，但问答能力还没接好。"
          : "本地服务还没有稳定连上。",
      },
      {
        key: "import",
        title: "首条内容",
        done: importReady,
        summary: importReady
          ? "你已经拿到了第一条知识内容。"
          : "还没有第一条内容，建议先导入一条最容易成功的样本。",
      },
      {
        key: "verify",
        title: "首轮问答",
        done: verifyReady,
        summary: verifyReady
          ? "你已经做过首轮问答验证。"
          : "还没有会话记录，建议围绕首条内容试一次问答。",
      },
    ],
    [chatModelReady, importReady, modelConfigured, serviceReady, verifyReady],
  );

  function handleDismiss() {
    writeOnboardingStatus("dismissed");
    setOnboardingStatus("dismissed");
  }

  function handleComplete() {
    writeOnboardingStatus("completed");
    setOnboardingStatus("completed");
  }

  return (
    <section className="page">
      <article className="card library-hero glass-hero onboarding-hero-card">
        <div className="library-hero-shell">
          <div className="library-hero-content">
            <div>
              <p className="eyebrow">{displayText("首次引导")}</p>
              <h2>{displayText("把第一次使用，收束成一条清晰路径")}</h2>
              <p className="muted-text">
                {displayText("你现在最重要的不是研究所有配置项，而是确认：环境接稳了没有、第一条内容能不能导入、问答值不值得继续用。")}
              </p>
            </div>

            <div className="product-overview-grid">
              {capabilitySummary.map((item) => (
                <article className="product-overview-card" key={item.label}>
                  <span>{displayText(item.label)}</span>
                  <strong>{displayText(item.value)}</strong>
                  <small>{displayText(item.hint)}</small>
                </article>
              ))}
            </div>

            <div className="header-actions">
              <Link className="primary-button button-link" to={currentAction.to}>
                {displayText(currentAction.label)}
              </Link>
              <Link className="secondary-button button-link" to="/">
                {displayText("返回首页")}
              </Link>
              {onboardingStatus !== "completed" && (
                <button className="secondary-button" type="button" onClick={handleDismiss}>
                  {displayText("暂时收起引导")}
                </button>
              )}
            </div>
          </div>

          <aside className="library-hero-side">
            <div className="signal-card">
              <p className="eyebrow">{displayText("当前建议")}</p>
              <div className="signal-list">
                <div className="signal-item">
                  <strong>{displayText(currentAction.label)}</strong>
                  <span className="muted-text">{displayText(currentAction.hint)}</span>
                </div>
              </div>
            </div>
          </aside>
        </div>
      </article>

      <article className="card segment-card glass-panel sticky-segment-card">
        <div className="segment-rail">
          {onboardingSteps.map((item) => (
            <button
              key={item.key}
              type="button"
              className={activeStep === item.key ? "segment-pill segment-pill-active" : "segment-pill"}
              onClick={() => setActiveStep(item.key)}
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
              <p className="eyebrow">{displayText(currentStep.label)}</p>
              <h3>{displayText(currentStep.title)}</h3>
              <p className="muted-text">{displayText(currentStep.description)}</p>
            </div>
            <span className="pill">
              {displayText(
                currentStep.key === "ready"
                  ? getStatusLabel({ done: serviceReady && (chatModelReady || modelConfigured), blocked: !serviceReady })
                  : currentStep.key === "import"
                  ? getStatusLabel({ done: importReady, waiting: serviceReady })
                  : getStatusLabel({ done: verifyReady, waiting: importReady }),
              )}
            </span>
          </div>

          <div className="onboarding-checklist">
            {checklist.map((item, index) => (
              <article className="onboarding-check-card" key={item.key}>
                <div className="onboarding-check-index">{index + 1}</div>
                <div className="onboarding-check-copy">
                  <strong>{displayText(item.title)}</strong>
                  <p>{displayText(item.summary)}</p>
                </div>
                <span className={item.done ? "result-badge result-badge-success" : "result-badge result-badge-warning"}>
                  {displayText(item.done ? "已完成" : "待处理")}
                </span>
              </article>
            ))}
          </div>

          {activeStep === "ready" && (
            <div className="advice-grid">
              <article className="advice-card">
                <strong>{displayText("服务先稳，再谈体验")}</strong>
                <p>{displayText("首页状态正常，设置页连通性测试通过，你后面的导入体验才不会像随机成功。")}</p>
              </article>
              <article className="advice-card">
                <strong>{displayText("首轮不用追求最强模型")}</strong>
                <p>{displayText("先用能稳定返回结果的厂商或本地模型，把体验打通，再回头细调效果。")}</p>
              </article>
            </div>
          )}

          {activeStep === "import" && (
            <div className="advice-grid">
              {!importReady && serviceReady && (
                <article className="advice-card" style={{ gridColumn: "1 / -1", borderLeft: "3px solid var(--accent)" }}>
                  <strong>{displayText("从这条开始验证链路")}</strong>
                  <p style={{ marginBottom: "var(--space-2)" }}>
                    {displayText("推荐导入一条公开 B 站知识讲解视频，带字幕、表达清晰的最容易成功。")}
                  </p>
                  <div className="header-actions" style={{ flexWrap: "wrap" }}>
                    <Link className="primary-button button-link" to="/library">
                      {displayText("去导入第一条内容")}
                    </Link>
                    <button
                      className="secondary-button"
                      type="button"
                      onClick={() => { setSampleMessage(""); initSamplesMutation.mutate(); }}
                      disabled={initSamplesMutation.isPending}
                    >
                      {initSamplesMutation.isPending ? displayText("插入中...") : displayText("加载示例内容")}
                    </button>
                  </div>
                  {sampleMessage && <p className="muted-text" style={{ marginTop: "var(--space-2)" }}>{displayText(sampleMessage)}</p>}
                </article>
              )}
              <article className="advice-card">
                <strong>{displayText("先选最容易成功的样本")}</strong>
                <p>{displayText("优先公开视频、知识讲解、表达清楚的内容，不要一开始就挑战登录态或模糊音频。")}</p>
              </article>
              <article className="advice-card">
                <strong>{displayText("看结果，不只看完成")}</strong>
                <p>{displayText("重点看摘要是否自然、证据层是否可回看、片段是否适合继续提问。")}</p>
              </article>
            </div>
          )}

          {activeStep === "verify" && (
            <div className="advice-grid">
              <article className="advice-card">
                <strong>{displayText("先问整条内容")}</strong>
                <p>{displayText("用总结型问题确认整体理解是否自然，再切到片段追问核对证据。")}</p>
              </article>
              <article className="advice-card">
                <strong>{displayText("把首轮体验当成验收")}</strong>
                <p>{displayText("如果引用能定位、详情可回看、回答不僵硬，这条产品链路就已经有交付基础。")}</p>
              </article>
            </div>
          )}
        </article>

        <article className="card detail-section-card glass-panel onboarding-side-card">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">{displayText("下一步")}</p>
              <h3>{displayText("按这条顺序继续就好")}</h3>
            </div>
          </div>

          <div className="signal-list">
            {onboardingSteps.map((item, index) => (
              <div className="signal-item" key={item.key}>
                <strong>{displayText(`步骤 ${index + 1} · ${item.label}`)}</strong>
                <span className="muted-text">{displayText(item.description)}</span>
              </div>
            ))}
          </div>

          <div className="glass-callout">
            <strong>{displayText(onboardingStatus === "completed" ? "引导已完成" : "当前最佳动作")}</strong>
            <p>{displayText(currentAction.hint)}</p>
          </div>

          <div className="header-actions">
            <Link className="primary-button button-link" to={currentAction.to}>
              {displayText(currentAction.label)}
            </Link>
            {serviceReady && importReady && verifyReady && onboardingStatus !== "completed" && (
              <button className="secondary-button" type="button" onClick={handleComplete}>
                {displayText("标记为已完成")}
              </button>
            )}
          </div>
        </article>
      </div>
    </section>
  );
}
