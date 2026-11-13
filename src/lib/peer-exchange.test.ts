import { describe, expect, it } from "vitest";
import type { Message } from "@/state/store";
import { peerExchanges } from "./peer-exchange";

const line = (id: string, fields: Partial<Message> = {}): Message => ({ id, role: "bot", kind: "text", at: 1, text: id, ...fields });
const request = line("request", { roomRequest: { id: "r1", phase: "request" }, from: { botId: "chief", name: "Chief", color: "blue" } });

describe("peer exchanges", () => {
  it("keeps a request and its replies together, ending at the person's next message", () => {
    const reply = line("reply"), person = line("person", { role: "user" }), answer = line("answer");
    const exchanges = peerExchanges([request, reply, person, answer], "scout", "Scout");
    expect(exchanges.get("request")).toEqual({ sender: "Chief", recipient: "Scout", messages: [request, reply] });
    expect(exchanges.get("reply")).toBe(exchanges.get("request"));
    expect(exchanges.has("person")).toBe(false);
    expect(exchanges.has("answer")).toBe(false);
  });

  it("separates successive briefs and supports legacy peer messages", () => {
    const legacy = line("legacy", { role: "user", peerAsk: { botId: "mira", name: "Mira" } });
    const exchanges = peerExchanges([request, line("first"), legacy, line("second")], "scout", "Scout");
    expect(exchanges.get("request")?.messages.map((m) => m.id)).toEqual(["request", "first"]);
    expect(exchanges.get("legacy")?.messages.map((m) => m.id)).toEqual(["legacy", "second"]);
    expect(exchanges.get("legacy")?.sender).toBe("Mira");
  });

  it("leaves the bot's own request and another participant's text alone", () => {
    expect(peerExchanges([request], "chief", "Chief").size).toBe(0);
    const stranger = line("other", { from: { botId: "mira", name: "Mira", color: "teal" } });
    expect(peerExchanges([request, stranger], "scout", "Scout").has("other")).toBe(false);
  });
});
