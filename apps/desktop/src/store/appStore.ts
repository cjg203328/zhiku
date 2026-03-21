import { create } from "zustand";

type ToastLevel = "info" | "success" | "warning" | "error";

interface Toast {
  id: string;
  message: string;
  level: ToastLevel;
}

interface AppState {
  // 全局 Toast
  toasts: Toast[];
  showToast: (message: string, level?: ToastLevel) => void;
  dismissToast: (id: string) => void;

  // 活跃 Chat Session
  activeSessionId: string | null;
  setActiveSessionId: (id: string | null) => void;

  // 导入任务角标
  pendingImportCount: number;
  setPendingImportCount: (count: number) => void;
}

let _toastCounter = 0;

export const useAppStore = create<AppState>((set) => ({
  toasts: [],
  showToast: (message, level = "info") => {
    const id = `toast-${++_toastCounter}`;
    set((s) => ({ toasts: [...s.toasts, { id, message, level }] }));
    setTimeout(() => {
      set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
    }, 4000);
  },
  dismissToast: (id) =>
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),

  activeSessionId: null,
  setActiveSessionId: (id) => set({ activeSessionId: id }),

  pendingImportCount: 0,
  setPendingImportCount: (count) => set({ pendingImportCount: count }),
}));
