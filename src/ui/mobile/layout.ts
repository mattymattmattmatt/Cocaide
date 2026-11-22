// Which layout the app opens in: the touch viewer on a phone, the full app
// everywhere else. A phone browser's "Desktop site" switch makes it say it is a
// computer, so ticking it brings the full app; a headset's browser says it is a
// computer too. The viewer's "Full app" and the full app's "Viewer" (shown on a
// phone) switch by hand, remembered on that phone; ?viewer and ?full in the
// address force one (tests).

import { useSyncExternalStore } from "react";

export type Layout = "viewer" | "full";
const KEY = "cocaide.layout";

interface Nav {
  userAgent: string;
  userAgentData?: { mobile?: boolean };
}

/** Whether this is a phone's browser as it asks for pages (not "Desktop site"; never a headset). */
export function phoneBrowser(nav: Nav = navigator as Nav): boolean {
  const ua = nav.userAgent ?? "";
  if (/OculusBrowser|Quest|Pico|Wolvic/i.test(ua)) return false;
  if (typeof nav.userAgentData?.mobile === "boolean") return nav.userAgentData.mobile;
  return /Android.+Mobile|iPhone|iPod|Windows Phone|\bMobi/i.test(ua);
}

/** The layout for this browser: forced by the address, else the phone's own choice, else viewer on a phone, full elsewhere. */
export function layoutFor(phone: boolean, search: string, stored: string | null): Layout {
  const q = new URLSearchParams(search);
  if (q.has("viewer")) return "viewer";
  if (q.has("full")) return "full";
  if (!phone) return "full";
  return stored === "full" ? "full" : "viewer";
}

const listeners = new Set<() => void>();
let current: Layout | null = null;
const read = (): Layout => {
  if (current) return current;
  let stored: string | null = null;
  try {
    stored = localStorage.getItem(KEY);
  } catch {
    /* private window: no memory */
  }
  current = layoutFor(phoneBrowser(), typeof location !== "undefined" ? location.search : "", stored);
  return current;
};

/** Switch layout (remembered on a phone). */
export function setLayout(next: Layout): void {
  current = next;
  try {
    if (phoneBrowser()) localStorage.setItem(KEY, next);
  } catch {
    /* private window */
  }
  for (const l of listeners) l();
}

export function useLayout(): Layout {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    read,
    () => "full",
  );
}
