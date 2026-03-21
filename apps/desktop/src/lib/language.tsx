import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { translateToEnglish } from "./translations";

export type AppLanguage = "zh-CN" | "en";

type TextConverter = (value: string) => string;

type LanguageContextValue = {
  language: AppLanguage;
  setLanguage: (value: AppLanguage) => void;
  displayText: (value: string | null | undefined) => string;
};

const STORAGE_KEY = "zhiku.language";
let simplifiedConverterPromise: Promise<TextConverter> | null = null;

const LanguageContext = createContext<LanguageContextValue | null>(null);

function loadSimplifiedConverter() {
  if (!simplifiedConverterPromise) {
    simplifiedConverterPromise = import("opencc-js/t2cn").then((module) =>
      module.Converter({ from: "tw", to: "cn" }),
    );
  }
  return simplifiedConverterPromise;
}

function readInitialLanguage(): AppLanguage {
  if (typeof window === "undefined") {
    return "zh-CN";
  }
  const cached = window.localStorage.getItem(STORAGE_KEY);
  if (cached === "zh-CN" || cached === "en") {
    return cached;
  }
  return "zh-CN";
}

function convertText(
  value: string | null | undefined,
  language: AppLanguage,
  toSimplified: TextConverter | null,
) {
  const source = value ?? "";
  if (!source) {
    return "";
  }
  if (language === "en") {
    return translateToEnglish(source);
  }
  if (!toSimplified) {
    return source;
  }
  return toSimplified(source);
}

export function LanguageProvider({ children }: { children: ReactNode }) {
  const [language, setLanguage] = useState<AppLanguage>(readInitialLanguage);
  const [toSimplified, setToSimplified] = useState<TextConverter | null>(null);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    window.localStorage.setItem(STORAGE_KEY, language);
    document.documentElement.lang = language === "en" ? "en" : "zh-CN";
  }, [language]);

  useEffect(() => {
    if (typeof window === "undefined" || language === "en" || toSimplified) {
      return;
    }

    let cancelled = false;
    const timer = window.setTimeout(() => {
      void loadSimplifiedConverter()
        .then((loadedConverter) => {
          if (cancelled) {
            return;
          }
          setToSimplified((current: TextConverter | null) => current ?? loadedConverter);
        })
        .catch(() => {
          // Keep source text visible even if the optional language pack fails to load.
        });
    }, 160);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [language, toSimplified]);

  const displayText = useCallback(
    (value: string | null | undefined) => convertText(value, language, toSimplified),
    [language, toSimplified],
  );

  const contextValue = useMemo(
    () => ({
      language,
      setLanguage,
      displayText,
    }),
    [displayText, language],
  );

  return <LanguageContext.Provider value={contextValue}>{children}</LanguageContext.Provider>;
}

export function useLanguage() {
  const context = useContext(LanguageContext);
  if (!context) {
    throw new Error("useLanguage must be used within LanguageProvider");
  }
  return context;
}
