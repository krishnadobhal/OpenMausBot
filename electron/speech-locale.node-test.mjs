import assert from "node:assert/strict";
import test from "node:test";
import { nativeSpeechLocale, shortcutSpeechLocale, speechLocaleArguments } from "./speech-locale.mjs";

test("native speech gets canonical locale arguments without Unicode presentation extensions", () => {
  assert.deepEqual(speechLocaleArguments("zh-hant-tw"), ["--locale", "zh-Hant-TW"]);
  assert.deepEqual(speechLocaleArguments("pt-br"), ["--locale", "pt-BR"]);
  assert.deepEqual(speechLocaleArguments("en-US-u-nu-hanidec"), ["--locale", "en-US"]);
  assert.deepEqual(speechLocaleArguments(undefined), []);
  for (const tag of ["en,zh", "", "und", "en_US", null, [], "en-" + "a".repeat(100)]) {
    assert.equal(nativeSpeechLocale(tag), undefined);
    assert.throws(() => speechLocaleArguments(tag), /unsupported-language/);
  }
});

test("shortcut speech follows the saved choice, inherited default or raw device locale", () => {
  assert.equal(shortcutSpeechLocale("zh-tw", "ja", "en-US"), "zh-TW");
  assert.equal(shortcutSpeechLocale(null, "hi", "en-US"), "hi");
  assert.equal(shortcutSpeechLocale("", "ja", "zh-Hant-HK"), "zh-Hant-HK");
  assert.equal(shortcutSpeechLocale(null, undefined, "sr-Latn-RS"), "sr-Latn-RS");
});
