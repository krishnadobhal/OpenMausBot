# Speech input language

Composer dictation, Take turns calls and the Mac talk shortcut capture the
selected app language when a recording starts. Follow system uses the
speaking device's locale. Changing the app language affects the next recording.
There is no separate speech-language preference.

On macOS, the native recognizer selects a supported locale of the requested
language, preferring an exact locale and then compatible script and region.
An explicitly unsupported or unavailable native language gives a localized
error. Older callers without a locale retain the OS-preference behavior.
Rebuild the helper with `pnpm build:speech` before packaged verification.

Fish receives the selected language through the optional
`x-omb-stt-language` upload header. The route validates the locale and maps
supported app languages to ISO 639-1 hints such as `zh` and `hi`. Older clients
without the header keep automatic detection. Valid languages without a
supported mapping omit the hint; malformed, repeated or overlong supplied
headers are refused before reaching Fish.

Fish's [language documentation](https://docs.fish.audio/features/speech-to-text#language)
says `transcribe-1-pro` detects language automatically and the hint does not
change the transcript. The hint does not force recognition of Hindi, Chinese
or another language. Selecting Traditional Chinese also does not establish
Cantonese support or convert the output script.

## Isolated checks

Follow [README](README.md) and use disposable fixture homes and owned
loopback provider stand-ins. Never point verification at a live app or its data.

```sh
node node_modules/vitest/vitest.mjs run shared/stt-language.test.ts src/lib/language-preference.test.ts src/lib/fish-speech.test.ts src/lib/use-composer-dictation.fish.test.ts server/routes/tts.test.ts server/tts/fish.test.ts server/speech-language.e2e.test.ts --maxWorkers=1
node --test --test-force-exit electron/speech-locale.node-test.mjs electron/talk-main.node-test.mjs electron/talk-session.node-test.mjs electron/speech-helper-release.node-test.mjs
```

The Fish fixture inspects actual HTTP uploads to its own loopback provider;
its response is synthetic. It checks mapped hints, omitted hints, invalid
headers, original Unicode text and requests from older clients. The
[dictation browser fixture](dictation.md) checks Japanese and Chinese text
through composer send and rejects late callbacks. These checks establish
request wiring and text handling, not recognition accuracy.

## Real-audio qualification

Use a disposable profile, non-sensitive sentences and a speaker who understands
the tested language. Record app version, OS, recognizer/model, selected app
language, device language, spoken language/dialect, expected words and actual
transcript. Check Chinese selected on an English OS, English selected on a
Chinese OS, Follow system, both Chinese app choices, Hindi and another
supported language. Repeat composer dictation and Take turns; on macOS also
verify the [global talk shortcut](talk-shortcut.md).

Change language during recording and confirm only the next recording changes.
Check native unsupported/unavailable errors. Build the Swift helper and run
its macOS-only locale and transport tests on a Mac. Windows checks cannot
qualify the packaged helper, hotkey, physical microphone or actual provider
recognition accuracy.

## Main-based verification record (2026-11-12, Windows)

The four focused server/shared suites passed 65 tests on the main-based
implementation. The disposable server at `http://127.0.0.1:22176` sent actual
requests to its owned loopback Fish stand-in. Checks covered Chinese, Hindi
and Portuguese hints, unsupported-hint and legacy omission, invalid and
repeated header rejection before provider dispatch, unchanged Unicode text
and the `transcribe-1-pro` model header.

Redacted request evidence is retained under the OS temporary directory at
`openmausbot-verification-evidence/server-1794494886458-12948.log.speech-language.json`,
with the server log beside it. The [main-based browser record](dictation.md#main-based-verification-record-2026-11-12-windows)
covers text through the composer and send. These fixtures do not establish
real Fish recognition accuracy or native macOS behavior.
