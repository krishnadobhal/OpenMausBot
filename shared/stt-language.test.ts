import { describe, expect, it } from "vitest";
import { canonicalSpeechLocale, transcriptionLanguage } from "./stt-language";

describe("speech language tags", () => {
  it.each([
    ["zh-tw", "zh-TW"], ["zh-hant-hk", "zh-Hant-HK"], ["pt-br", "pt-BR"],
    ["EN-us", "en-US"], ["ja", "ja"], ["ko", "ko"], ["hi", "hi"], ["iw", "he"],
    ["en-us-u-nu-hanidec", "en-US-u-nu-hanidec"],
  ])("canonicalizes %s without losing script or region", (tag, expected) => {
    expect(canonicalSpeechLocale(tag)).toBe(expected);
  });

  it.each([undefined, null, [], 42, "", "und", "zh_CN", "en,zh", "English language", "en-", "x-private", "123", "en-" + "a".repeat(100)])("rejects absent or malformed input %s", (tag) => {
    expect(canonicalSpeechLocale(tag)).toBeUndefined();
  });
});

describe("transcription language hints", () => {
  it.each([
    ["zh-Hans-CN", "zh"], ["zh-Hant-TW", "zh"], ["pt-BR", "pt"], ["en-US", "en"],
    ["ja-JP", "ja"], ["ko-KR", "ko"], ["hi-IN", "hi"], ["en-US-u-nu-hanidec", "en"],
  ])("maps %s to %s", (locale, hint) => {
    expect(transcriptionLanguage(locale)).toBe(hint);
  });

  it.each([undefined, "", "ar-EG", "yue-HK", "en,zh", "und"]) ("omits an unavailable or unsupported hint %s", (locale) => {
    expect(transcriptionLanguage(locale)).toBeUndefined();
  });
});
