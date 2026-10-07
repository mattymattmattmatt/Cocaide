// The photos behind underlays, kept in this browser (IndexedDB) by SHA-256.
// The document names the photo; the pixels never go in it. Storage can be
// unavailable (a private window): then the underlay is simply not shown.

import type { PreparedPhoto } from "./prepare";

const DB = "cocaide-photos";
const STORE = "photos";

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: "sha256" });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function savePhoto(photo: PreparedPhoto): Promise<void> {
  try {
    const db = await open();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(photo);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch {
    // Not stored: the underlay won't show after a reload. The document is unaffected.
  }
}

export async function loadPhoto(sha256: string): Promise<PreparedPhoto | null> {
  try {
    const db = await open();
    const photo = await new Promise<PreparedPhoto | null>((resolve, reject) => {
      const req = db.transaction(STORE).objectStore(STORE).get(sha256);
      req.onsuccess = () => resolve((req.result as PreparedPhoto | undefined) ?? null);
      req.onerror = () => reject(req.error);
    });
    db.close();
    return photo;
  } catch {
    return null;
  }
}
