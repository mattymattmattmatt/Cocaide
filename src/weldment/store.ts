// The section library in this browser (IndexedDB). Storage can be missing (a
// private window): the library is then empty and saving says so; parts are
// unaffected, since each keeps its own copies.

import type { LibraryEntry } from "./library";

const DB = "cocaide-sections";
const STORE = "profiles";

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: "id" });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function run<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> {
  const db = await open();
  try {
    return await new Promise<T | undefined>((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const req = fn(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(req ? req.result : undefined);
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

export async function listProfiles(): Promise<LibraryEntry[]> {
  try {
    return ((await run<LibraryEntry[]>("readonly", (s) => s.getAll())) ?? []) as LibraryEntry[];
  } catch {
    return [];
  }
}

export async function saveProfile(entry: LibraryEntry): Promise<void> {
  await run("readwrite", (s) => s.put(entry));
}

export async function saveProfiles(entries: LibraryEntry[]): Promise<void> {
  await run("readwrite", (s) => {
    for (const e of entries) s.put(e);
  });
}

export async function deleteProfile(id: string): Promise<void> {
  await run("readwrite", (s) => s.delete(id));
}
