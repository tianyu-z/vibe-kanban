// Persisted user preference for "default additional agents" — set on the
// onboarding LandingPage, read on every fresh Create-Workspace draft to
// pre-populate the multi-select dropdown.
//
// Stored as JSON array of BaseCodingAgent string keys (e.g. ['CODEX','GEMINI']).
// The PRIMARY agent lives in config.executor_profile and is NOT stored here.

import type { BaseCodingAgent } from 'shared/types';

const STORAGE_KEY = 'vk-default-additional-executors';

export function readDefaultAdditionalExecutors(): BaseCodingAgent[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((v): v is BaseCodingAgent => typeof v === 'string');
  } catch {
    return [];
  }
}

export function saveDefaultAdditionalExecutors(
  agents: BaseCodingAgent[]
): void {
  try {
    if (agents.length === 0) {
      localStorage.removeItem(STORAGE_KEY);
    } else {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(agents));
    }
  } catch {
    // localStorage may be unavailable (private mode, quota, etc.) — preference
    // simply won't persist; not worth surfacing.
  }
}
