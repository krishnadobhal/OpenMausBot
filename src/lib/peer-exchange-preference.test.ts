import { afterEach, expect, it, vi } from "vitest";

vi.mock("react", () => ({ useSyncExternalStore: (_subscribe: unknown, snapshot: () => boolean) => snapshot() }));
afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });

it("defaults to compact and persists either choice across reloads", async () => {
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) });
  let preference = await import("./peer-exchange-preference");
  expect(preference.useInlinePeerExchanges()).toBe(false);
  preference.setInlinePeerExchanges(true);
  vi.resetModules();
  preference = await import("./peer-exchange-preference");
  expect(preference.useInlinePeerExchanges()).toBe(true);
  preference.setInlinePeerExchanges(false);
  vi.resetModules();
  preference = await import("./peer-exchange-preference");
  expect(preference.useInlinePeerExchanges()).toBe(false);
});

it("keeps the preference usable when storage is blocked", async () => {
  vi.stubGlobal("localStorage", { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); } });
  const preference = await import("./peer-exchange-preference");
  expect(preference.useInlinePeerExchanges()).toBe(false);
  preference.setInlinePeerExchanges(true);
  expect(preference.useInlinePeerExchanges()).toBe(true);
});
