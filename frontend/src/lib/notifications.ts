const STORAGE_KEY = "app_notifications";
const EVENT_NAME  = "app_notifications_changed";

export type AppNotification = {
  id: string;
  message: string;
  timestamp: string;
  read: boolean;
};

// Suppress duplicate-by-message notifications added within this window. React
// StrictMode double-invocation, polling effects, and rapid re-renders all
// caused users to see the same "you were upgraded" toast multiple times.
const DEDUP_WINDOW_MS = 60 * 60 * 1000;   // 1 hour

export function addNotification(message: string): void {
  if (typeof window === "undefined") return;
  const list = getNotifications();
  const now  = Date.now();
  const dup  = list.find(
    (n) => n.message === message && now - new Date(n.timestamp).getTime() < DEDUP_WINDOW_MS,
  );
  if (dup) return;   // already shown recently — silently ignore
  list.unshift({ id: now.toString(), message, timestamp: new Date().toISOString(), read: false });
  localStorage.setItem(STORAGE_KEY, JSON.stringify(list.slice(0, 30)));
  window.dispatchEvent(new Event(EVENT_NAME));
}

export function getNotifications(): AppNotification[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

export function markAllRead(): void {
  if (typeof window === "undefined") return;
  const list = getNotifications().map((n) => ({ ...n, read: true }));
  localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
  window.dispatchEvent(new Event(EVENT_NAME));
}

export function listenForChanges(cb: () => void): () => void {
  window.addEventListener(EVENT_NAME, cb);
  return () => window.removeEventListener(EVENT_NAME, cb);
}

/** Relative time label — e.g. "منذ دقيقتين" / "2 min ago" */
export function relativeTime(iso: string, lang: "en" | "ar"): string {
  const diff = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (diff < 60) return lang === "ar" ? "الآن" : "just now";
  if (diff < 3600) {
    const m = Math.floor(diff / 60);
    return lang === "ar" ? `منذ ${m} د` : `${m}m ago`;
  }
  if (diff < 86400) {
    const h = Math.floor(diff / 3600);
    return lang === "ar" ? `منذ ${h} س` : `${h}h ago`;
  }
  const d = Math.floor(diff / 86400);
  return lang === "ar" ? `منذ ${d} يوم` : `${d}d ago`;
}
