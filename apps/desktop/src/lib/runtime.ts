import { API_BASE_URL } from "./api";

export type RuntimeInfo = {
  app_name: string;
  app_version: string;
  sidecar_mode: string;
};

export type SidecarStatus = {
  started: boolean;
  pid: number | null;
  mode: string;
  command: string;
};

function getWindowWithTauri() {
  return window as Window & {
    __TAURI_INTERNALS__?: unknown;
  };
}

export function isTauriRuntime() {
  return typeof window !== "undefined" && Boolean(getWindowWithTauri().__TAURI_INTERNALS__);
}

async function invokeCommand<T>(command: string, args?: Record<string, unknown>) {
  const module = await import("@tauri-apps/api/core");
  return module.invoke<T>(command, args);
}

export function getRuntimeInfo() {
  return invokeCommand<RuntimeInfo>("get_runtime_info");
}

export function getSidecarState() {
  return invokeCommand<SidecarStatus>("get_sidecar_state");
}

export function startApiSidecar() {
  return invokeCommand<SidecarStatus>("start_api_sidecar");
}

export function stopApiSidecar() {
  return invokeCommand<SidecarStatus>("stop_api_sidecar");
}

async function wait(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForApiHealth(maxAttempts = 12, delayMs = 800) {
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      const response = await fetch(`${API_BASE_URL}/api/v1/health`);
      if (response.ok) {
        return true;
      }
    } catch {
      // noop
    }
    await wait(delayMs);
  }
  return false;
}

export async function ensureApiReady() {
  const healthyBeforeStart = await waitForApiHealth(1, 100);
  if (healthyBeforeStart) {
    return {
      mode: "external-api",
      sidecar: null as SidecarStatus | null,
    };
  }

  if (!isTauriRuntime()) {
    return {
      mode: "browser-no-sidecar",
      sidecar: null as SidecarStatus | null,
    };
  }

  const sidecar = await startApiSidecar();
  const healthy = await waitForApiHealth(14, 700);
  if (!healthy) {
    throw new Error("sidecar 已启动，但 API 仍未在预期时间内就绪。");
  }

  return {
    mode: "tauri-sidecar",
    sidecar,
  };
}
