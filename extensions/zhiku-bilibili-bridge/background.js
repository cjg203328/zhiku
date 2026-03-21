const BRIDGE_URL = "http://127.0.0.1:38765/api/v1/bilibili/bridge/session";
const SYNC_ALARM = "zhiku-bilibili-bridge-sync";
const IMPORTANT_COOKIE_NAMES = new Set([
  "SESSDATA",
  "bili_jct",
  "DedeUserID",
  "sid",
  "buvid3",
  "buvid4",
]);

function detectBrowserName() {
  const ua = navigator.userAgent || "";
  if (ua.includes("Edg/")) return "Microsoft Edge";
  if (ua.includes("Chrome/")) return "Google Chrome";
  if (ua.includes("Firefox/")) return "Firefox";
  return "当前浏览器";
}

function buildSourceLabel() {
  return `${detectBrowserName()} · 浏览器小助手`;
}

function isBilibiliUrl(url) {
  return typeof url === "string" && /bilibili\.com|b23\.tv/i.test(url);
}

function buildCookieHeader(cookies) {
  return cookies
    .filter((item) => item && item.name && typeof item.value === "string")
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((item) => `${item.name}=${item.value}`)
    .join("; ");
}

async function collectBilibiliCookies() {
  const cookies = await chrome.cookies.getAll({ domain: ".bilibili.com" });
  if (!cookies.length) {
    return null;
  }

  const header = buildCookieHeader(cookies);
  if (!header) {
    return null;
  }

  const hasImportantCookie = cookies.some((item) => IMPORTANT_COOKIE_NAMES.has(item.name));
  if (!hasImportantCookie) {
    return null;
  }

  return {
    cookieHeader: header,
    cookieCount: cookies.length,
  };
}

async function syncToZhiku(reason) {
  try {
    const result = await collectBilibiliCookies();
    if (!result) {
      await chrome.action.setBadgeText({ text: "" });
      return;
    }

    const response = await fetch(BRIDGE_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        cookie_header: result.cookieHeader,
        source_label: buildSourceLabel(),
        browser_name: detectBrowserName(),
        profile_name: "",
        ttl_seconds: 1800,
        reason,
      }),
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    await chrome.action.setBadgeBackgroundColor({ color: "#16a34a" });
    await chrome.action.setBadgeText({ text: "ON" });
  } catch (error) {
    console.warn("[zhiku-bilibili-bridge] sync failed:", error);
    await chrome.action.setBadgeBackgroundColor({ color: "#f59e0b" });
    await chrome.action.setBadgeText({ text: "!" });
  }
}

function scheduleSync() {
  chrome.alarms.create(SYNC_ALARM, { periodInMinutes: 5 });
}

chrome.runtime.onInstalled.addListener(() => {
  scheduleSync();
  void syncToZhiku("installed");
});

chrome.runtime.onStartup.addListener(() => {
  scheduleSync();
  void syncToZhiku("startup");
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === SYNC_ALARM) {
    void syncToZhiku("alarm");
  }
});

chrome.action.onClicked.addListener(() => {
  void syncToZhiku("manual-click");
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === "complete" && isBilibiliUrl(tab.url)) {
    void syncToZhiku("tab-update");
  }
});

chrome.cookies.onChanged.addListener((changeInfo) => {
  if (changeInfo.cookie && /\.?bilibili\.com$/i.test(changeInfo.cookie.domain)) {
    void syncToZhiku("cookie-change");
  }
});
