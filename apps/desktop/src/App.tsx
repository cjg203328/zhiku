import { Suspense, lazy } from "react";
import { NavLink, Route, Routes } from "react-router-dom";
import { Home, BookOpen, MessageCircle, Trash2, Settings } from "lucide-react";
import { useLanguage, type AppLanguage } from "./lib/language";
import ErrorBoundary from "./components/ErrorBoundary";
import ToastContainer from "./components/ToastContainer";

const StartupPage = lazy(() => import("./pages/StartupPage"));
const OnboardingPage = lazy(() => import("./pages/OnboardingPage"));
const LibraryPage = lazy(() => import("./pages/LibraryPage"));
const ChatPage = lazy(() => import("./pages/ChatPage"));
const ContentDetailPage = lazy(() => import("./pages/ContentDetailPage"));
const RecycleBinPage = lazy(() => import("./pages/RecycleBinPage"));
const SettingsPage = lazy(() => import("./pages/SettingsPage"));

const navItems = [
  { to: "/", label: "首页", hint: "状态概览", Icon: Home },
  { to: "/library", label: "知识库", hint: "导入与浏览", Icon: BookOpen },
  { to: "/chat", label: "智能问答", hint: "对话与检索", Icon: MessageCircle },
  { to: "/trash", label: "回收站", hint: "已删除内容", Icon: Trash2 },
  { to: "/settings", label: "设置", hint: "模型与配置", Icon: Settings },
];

const languageItems: { value: AppLanguage; label: string }[] = [
  { value: "zh-CN", label: "简体中文" },
  { value: "en", label: "English" },
];

export default function App() {
  const { language, setLanguage, displayText } = useLanguage();

  return (
    <div className="app-shell">
      <ToastContainer />
      <aside className="sidebar">
        <div className="sidebar-top">
          <div className="brand-block">
            <div className="brand-logo">
              <div className="brand-icon">知</div>
              <span className="brand-name">知库</span>
            </div>
            <p className="brand-tagline">{displayText("B站视频 · 本地知识库 · 智能问答")}</p>
            <div className="lang-switch">
              {languageItems.map((item) => (
                <button
                  key={item.value}
                  type="button"
                  className={language === item.value ? "lang-chip lang-chip-active" : "lang-chip"}
                  onClick={() => setLanguage(item.value)}
                >
                  {item.label}
                </button>
              ))}
            </div>
          </div>

          <nav className="nav">
            {navItems.map(({ to, label, hint, Icon }) => (
              <NavLink
                key={to}
                to={to}
                end={to === "/"}
                className={({ isActive }) =>
                  isActive ? "nav-link nav-link-active" : "nav-link"
                }
              >
                <span className="nav-link-icon"><Icon size={16} strokeWidth={1.8} /></span>
                <span className="nav-link-label">{displayText(label)}</span>
                <span className="nav-link-hint">{displayText(hint)}</span>
              </NavLink>
            ))}
          </nav>
        </div>
      </aside>
      <main className="content">
        <ErrorBoundary>
        <Suspense
          fallback={
            <section className="page route-loading-page">
              <article className="card glass-panel route-loading-card">
                <p className="eyebrow">{displayText("页面切换中")}</p>
                <h2>{displayText("正在加载当前工作台")}</h2>
                <p className="muted-text">{displayText("继续保持当前操作，页面马上就绪。")}</p>
              </article>
            </section>
          }
        >
          <Routes>
            <Route path="/" element={<StartupPage />} />
            <Route path="/library" element={<LibraryPage />} />
            <Route path="/library/:contentId" element={<ContentDetailPage />} />
            <Route path="/trash" element={<RecycleBinPage />} />
            <Route path="/chat" element={<ChatPage />} />
            <Route path="/settings" element={<SettingsPage />} />
            <Route path="/onboarding" element={<OnboardingPage />} />
          </Routes>
        </Suspense>
        </ErrorBoundary>
      </main>
    </div>
  );
}
