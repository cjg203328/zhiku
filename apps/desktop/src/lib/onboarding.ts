export type OnboardingStatus = "pending" | "dismissed" | "completed";

const ONBOARDING_STORAGE_KEY = "zhiku.onboarding.status";

export function readOnboardingStatus(): OnboardingStatus {
  if (typeof window === "undefined") {
    return "pending";
  }
  const rawValue = window.localStorage.getItem(ONBOARDING_STORAGE_KEY);
  if (rawValue === "dismissed" || rawValue === "completed") {
    return rawValue;
  }
  return "pending";
}

export function writeOnboardingStatus(status: OnboardingStatus) {
  if (typeof window === "undefined") {
    return;
  }
  window.localStorage.setItem(ONBOARDING_STORAGE_KEY, status);
}

export function shouldShowOnboarding(options: {
  onboardingStatus: OnboardingStatus;
  contentCount: number;
  sessionCount?: number;
  modelReady: boolean;
}) {
  if (options.onboardingStatus === "completed") {
    return false;
  }
  if (options.onboardingStatus === "dismissed") {
    return false;
  }
  if (options.contentCount === 0) {
    return true;
  }
  if (!options.modelReady) {
    return true;
  }
  return (options.sessionCount ?? 0) === 0;
}
