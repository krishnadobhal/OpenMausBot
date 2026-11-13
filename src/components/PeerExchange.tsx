import { useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ChevronRight, X } from "lucide-react";
import type { Message } from "@/state/store";
import type { PeerExchange as Exchange } from "@/lib/peer-exchange";
import { peerLine } from "@/lib/peer-message";
import { stripLeakedSystemHarnessMessages } from "../../shared/system-message-guard";
import { t } from "@/lib/i18n";
import { useModalDialog } from "@/hooks/use-modal-dialog";
import { ChatMarkdown } from "./ChatMarkdown";
import { MessageAttachmentGallery } from "./AttachmentGallery";
import { CopyButton } from "./MessageActions";
import { VoiceNoteBubble } from "./VoiceNoteBubble";

function body(message: Message): string {
  return stripLeakedSystemHarnessMessages(peerLine(message)?.body ?? message.text ?? message.tool?.output ?? "");
}

export function PeerExchangeRow({ message, exchange, threadId, children }: { message: Message; exchange: Exchange; threadId: string; children?: ReactNode }) {
  const [open, setOpen] = useState(false);
  const reply = message !== exchange.messages[0];
  const sender = reply ? exchange.recipient : exchange.sender;
  const recipient = reply ? exchange.sender : exchange.recipient;
  const label = `${sender} → ${recipient}`;
  const summary = message.tool?.ok === false ? message.tool.name : body(message).trim().split(/\r?\n/, 1)[0]?.slice(0, 160) ?? "";
  return <>
    <button type="button" data-peer-exchange={message.id} aria-haspopup="dialog" aria-expanded={open}
      onClick={() => setOpen(true)} className="flex w-full min-w-0 items-center gap-2 rounded-xl px-3 py-2 text-left text-[13px] text-ink-secondary hover:bg-raised focus-visible:outline-2 focus-visible:outline-accent">
      <span className="max-w-[50%] truncate font-medium">{label}</span>
      <span className={`min-w-0 flex-1 truncate${message.tool?.ok === false ? " text-danger" : ""}`} dir="auto">{summary || message.tool?.name || t("chat.peer.requested")}</span>
      <ChevronRight size={14} className="shrink-0" aria-hidden="true" />
    </button>
    {open && <PeerExchangeView exchange={exchange} threadId={threadId} close={() => setOpen(false)}>{children}</PeerExchangeView>}
  </>;
}

function PeerExchangeView({ exchange, threadId, close, children }: { exchange: Exchange; threadId: string; close: () => void; children?: ReactNode }) {
  const dialog = useRef<HTMLDivElement>(null);
  useModalDialog(dialog, close);
  const title = `${exchange.sender} ↔ ${exchange.recipient}`;
  return createPortal(
    <div className="fixed inset-0 z-50 flex justify-end bg-black/20" onClick={close}>
      <div ref={dialog} role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} onClick={(event) => event.stopPropagation()}
        className="flex h-full w-full max-w-xl flex-col border-l border-hairline bg-panel text-ink shadow-xl outline-none">
        <header className="flex items-center gap-3 border-b border-hairline px-4 pb-3 pt-[max(0.75rem,env(safe-area-inset-top))]">
          <h2 className="min-w-0 flex-1 truncate text-[15px] font-semibold">{title}</h2>
          <button type="button" className="ui-icon-button" aria-label={t("common.close")} onClick={close}><X size={18} /></button>
        </header>
        <div className="min-h-0 flex-1 space-y-5 overflow-auto p-4">
          {children}
          {exchange.messages.map((message, index) => <section key={message.id} className="min-w-0 space-y-2" data-peer-message={message.id}>
            <div className="flex items-center gap-2 text-[12px] font-medium text-ink-secondary">
              <span className="min-w-0 flex-1 truncate">{message.from?.name ?? (index === 0 ? exchange.sender : exchange.recipient)}</span>
              <CopyButton text={body(message)} />
            </div>
            {message.tool?.ok === false && <p role="status" className="text-danger">{message.tool.name}</p>}
            <ChatMarkdown text={body(message)} message={{ threadId, messageId: message.id }} />
            <MessageAttachmentGallery text={body(message)} attachments={message.attachments} message={{ threadId, messageId: message.id }} />
            {message.attachments?.map((attachment) => attachment.kind === "audio" ? <VoiceNoteBubble key={attachment.path} attachment={attachment} /> : null)}
          </section>)}
        </div>
      </div>
    </div>, document.body,
  );
}
