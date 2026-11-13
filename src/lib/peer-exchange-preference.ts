import { useSyncExternalStore } from "react";

export const PEER_EXCHANGE_KEY = "omb-inline-peer-exchanges";

let sessionChoice: boolean | undefined;
const listeners = new Set<() => void>();

function storage(): Storage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

function inlinePeerExchanges(): boolean {
  if (sessionChoice !== undefined) return sessionChoice;
  try {
    return storage()?.getItem(PEER_EXCHANGE_KEY) === "1";
  } catch {
    return false;
  }
}

function notify() {
  for (const listener of listeners) listener();
}

function onStorage(event: StorageEvent) {
  if (event.key !== PEER_EXCHANGE_KEY && event.key !== null) return;
  if (event.storageArea && event.storageArea !== storage()) return;
  sessionChoice = undefined;
  notify();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1 && typeof window !== "undefined") {
    window.addEventListener("storage", onStorage);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && typeof window !== "undefined") {
      window.removeEventListener("storage", onStorage);
    }
  };
}

export function setInlinePeerExchanges(enabled: boolean): void {
  sessionChoice = enabled;
  try {
    storage()?.setItem(PEER_EXCHANGE_KEY, enabled ? "1" : "0");
  } catch {
  }
  notify();
}

export function useInlinePeerExchanges(): boolean {
  return useSyncExternalStore(subscribe, inlinePeerExchanges, () => false);
}
