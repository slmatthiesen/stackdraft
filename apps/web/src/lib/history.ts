/**
 * Client-side design history (localStorage).
 *
 * Every generated design is saved in the browser — the full result, not just the
 * prompt — so re-opening a past design is 100% client-side: instant, $0, and it
 * survives the server's 24h response-cache TTL. Per-browser only (a snapshot, not
 * synced across devices). All access is defensive: localStorage can throw (private
 * mode / quota), so failures degrade to an empty history rather than crashing.
 */
import type { GenerateResponse } from "./types.js";

export interface HistoryEntry {
  id: string;
  /** The system description that produced this design (the page goal). */
  prompt: string;
  result: GenerateResponse;
  /** epoch ms when saved. */
  savedAt: number;
}

const KEY = "drafture.history.v1";
// Pre-rename key (Stackdraft -> Drafture). Kept only to migrate existing data.
const LEGACY_KEY = "stackdraft.history.v1";
const MAX = 20;

/**
 * One-time move of pre-rename history. When the product was renamed Stackdraft ->
 * Drafture the storage key changed, which orphaned designs already saved in a user's
 * browser. If the current key is empty and the legacy key has valid data, copy it over
 * and drop the legacy key so this runs once. Best-effort, like every other access.
 */
function migrateLegacyKey(): void {
  try {
    if (localStorage.getItem(KEY) !== null) return;
    const legacy = localStorage.getItem(LEGACY_KEY);
    if (!legacy) return;
    // Only migrate shape we can actually read; leave anything else untouched.
    const parsed: unknown = JSON.parse(legacy);
    if (!Array.isArray(parsed)) return;
    localStorage.setItem(KEY, legacy);
    localStorage.removeItem(LEGACY_KEY);
  } catch {
    /* corrupt legacy entry — ignore, same as a failed read */
  }
}

export function loadHistory(): HistoryEntry[] {
  migrateLegacyKey();
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as HistoryEntry[]) : [];
  } catch {
    return [];
  }
}

function persist(entries: HistoryEntry[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(entries));
  } catch {
    /* quota or unavailable — history is best-effort */
  }
}

/** Save a design; de-dupes by prompt (keeps the newest), caps at MAX, newest first. */
export function addHistory(prompt: string, result: GenerateResponse): HistoryEntry[] {
  const existing = loadHistory().filter((e) => e.prompt !== prompt);
  const entry: HistoryEntry = { id: makeId(), prompt, result, savedAt: Date.now() };
  const next = [entry, ...existing].slice(0, MAX);
  persist(next);
  return next;
}

export function removeHistory(id: string): HistoryEntry[] {
  const next = loadHistory().filter((e) => e.id !== id);
  persist(next);
  return next;
}

export function clearHistory(): HistoryEntry[] {
  persist([]);
  return [];
}

function makeId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }
}
