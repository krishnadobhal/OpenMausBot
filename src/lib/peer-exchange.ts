import type { Message } from "@/state/store";
import { peerLine, peerRequest } from "./peer-message";

export interface PeerExchange {
  sender: string;
  recipient: string;
  messages: Message[];
}

export function peerExchanges(messages: readonly Message[], botId: string, botName: string): Map<string, PeerExchange> {
  const exchanges = new Map<string, PeerExchange>();
  let current: PeerExchange | undefined;
  for (const message of messages) {
    const peer = peerLine(message) ?? peerRequest(message, botId);
    if (peer) current = { sender: peer.name, recipient: botName, messages: [] };
    else if (message.role === "user" || message.roomRequest?.phase === "request") current = undefined;
    if (current && message.kind === "text" && (peer || !message.from || message.from.botId === botId)) {
      current.messages.push(message);
      exchanges.set(message.id, current);
    }
  }
  return exchanges;
}
