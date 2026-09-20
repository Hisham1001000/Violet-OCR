// The balance is shown in the top bar on every page, but it changes somewhere
// else entirely — a document finishes and is charged for, or credit is added.
// Rather than poll it on a timer, whoever knows the balance moved says so and
// the chip refetches once.

const EVENT_NAME = "violet_balance_changed";

export function notifyBalanceChanged(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(EVENT_NAME));
}

export function listenBalanceChanged(cb: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  window.addEventListener(EVENT_NAME, cb);
  return () => window.removeEventListener(EVENT_NAME, cb);
}

/**
 * Whether this job's charge has already been announced.
 *
 * The document page polls, so without a marker the same "you were charged"
 * notification would fire on every tick. Keyed per job and kept in
 * localStorage so it survives a reload of the same page.
 */
export function markCharged(jobId: string): boolean {
  if (typeof window === "undefined") return false;
  const key = `violet_charged_${jobId}`;
  try {
    if (localStorage.getItem(key)) return false;
    localStorage.setItem(key, "1");
    return true;
  } catch {
    // Private mode: better to announce twice than never.
    return true;
  }
}
