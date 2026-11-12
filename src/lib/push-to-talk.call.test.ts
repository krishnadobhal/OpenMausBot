// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

vi.mock("./call", () => ({ currentCall: () => "bot-1" }));
const bridge = vi.hoisted(() => ({
  speechStart: vi.fn(async () => {}), speechStop: vi.fn(async () => {}), speechFinish: vi.fn(async () => {}),
  onSpeechTranscript: () => () => {}, onSpeechEnd: () => () => {},
}));
vi.mock("./speech", () => ({ speechBridge: () => bridge }));

import { usePushToTalk } from "./push-to-talk";

it("captures the current language for each held-key recording", () => {
  let language = "zh-tw";
  const Probe = () => { usePushToTalk("bot-1", true, () => {}, language); return null; };
  const root = createRoot(document.createElement("div"));
  flushSync(() => root.render(createElement(Probe)));
  flushSync(() => { window.dispatchEvent(new KeyboardEvent("keydown", { code: "ControlLeft", ctrlKey: true, altKey: true })); });
  expect(bridge.speechStart).toHaveBeenCalledExactlyOnceWith({ locale: "zh-TW" });
  language = "ja";
  flushSync(() => root.render(createElement(Probe)));
  expect(bridge.speechStart).toHaveBeenCalledOnce();
  flushSync(() => { window.dispatchEvent(new KeyboardEvent("keyup", { code: "ControlLeft" })); });
  expect(bridge.speechFinish).toHaveBeenCalledOnce();
  flushSync(() => { window.dispatchEvent(new KeyboardEvent("keydown", { code: "ControlLeft", ctrlKey: true, altKey: true })); });
  expect(bridge.speechStart).toHaveBeenLastCalledWith({ locale: "ja" });
  flushSync(() => root.unmount());
});
