// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { Message } from "@/state/store";
import { peerExchanges } from "@/lib/peer-exchange";
import { PeerExchangeRow } from "./PeerExchange";

vi.mock("./ChatMarkdown", () => ({ ChatMarkdown: ({ text }: { text: string }) => createElement("p", null, text) }));
vi.mock("./AttachmentGallery", () => ({ MessageAttachmentGallery: () => null }));

afterEach(() => { document.body.replaceChildren(); });

it("keeps a long brief compact, opens the exchange, and restores focus on Escape", () => {
  const request: Message = { id: "request", role: "user", kind: "text", at: 1, peerAsk: { botId: "chief", name: "Chief" }, text: "Check the export\n" + "Long delivery notes. ".repeat(100) };
  const reply: Message = { id: "reply", role: "bot", kind: "text", at: 2, text: "Export checked." };
  const exchange = peerExchanges([request, reply], "scout", "Scout").get(request.id)!;
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    flushSync(() => root.render(createElement(PeerExchangeRow, { message: request, exchange, threadId: "thread" })));
    const button = host.querySelector<HTMLButtonElement>("button")!;
    expect(button.textContent).toContain("Chief → Scout");
    expect(host.textContent).not.toContain("Long delivery notes.");
    expect(document.querySelector("[role=dialog]")).toBeNull();
    button.focus();
    flushSync(() => button.click());
    const dialog = document.querySelector<HTMLElement>("[role=dialog]")!;
    expect(dialog.textContent).toContain(request.text!.trim());
    expect(dialog.textContent).toContain(reply.text);
    expect(dialog.contains(document.activeElement)).toBe(true);
    flushSync(() => dialog.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(document.querySelector("[role=dialog]")).toBeNull();
    expect(document.activeElement).toBe(button);
  } finally { flushSync(() => root.unmount()); }
});

it("shows a failed handoff's status in its compact row", () => {
  const message: Message = { id: "failure", role: "bot", kind: "activity", at: 1, tool: { name: "Scout failed: build broke", ok: false, output: "Diagnostic details" } };
  const host = document.createElement("div");
  const root = createRoot(host);
  try {
    flushSync(() => root.render(createElement(PeerExchangeRow, { message, exchange: { sender: "Scout", recipient: "Chief", messages: [message] }, threadId: "thread" })));
    expect(host.textContent).toContain("Scout failed: build broke");
    expect(host.querySelector(".text-danger")).not.toBeNull();
  } finally { flushSync(() => root.unmount()); }
});
