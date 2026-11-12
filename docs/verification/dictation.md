# Native dictation

The same two synthetic utterances in the isolated browser fixture:

| Before: the first sentence is lost | After: both sentences and the stop control remain |
| --- | --- |
| ![Original composer](../screenshots/dictation/before.png) | ![Fixed composer](../screenshots/dictation/after.png) |

Run the regression tests with synthetic Japanese and Chinese text:

```sh
node --test electron/speech-transcript.node-test.mjs
pnpm exec vitest run electron/speech.test.mjs src/components/Composer.dictation.test.ts src/components/Composer.ime.test.ts src/components/CallView.composer.test.ts src/components/CallView.voiceSetup.test.ts src/components/ChatView.voice.test.ts --maxWorkers=1
pnpm exec vitest run scripts/testing/dictation.e2e.test.ts --maxWorkers=1
```

Launch the isolated fake-engine browser fixture:

```sh
node --experimental-strip-types scripts/control-omb.ts ui launch --entry dictation
```

Use its printed `ui` handle for every command. Click `Start dictation` with
`control-omb ui click --ui HANDLE --name ...`. This fixture never opens a microphone.
With `control-omb ui eval --ui HANDLE --js ...`, call:

```js
window.dictationFixture.hear({ text: "架空の一文目。", partial: true, utteranceFinal: true, speechStart: 0 });
// Wait for a renderer update before the next simulated callback.
window.dictationFixture.hear({ text: "架空の二文目。", partial: true, utteranceFinal: true, speechStart: 5 });
window.dictationFixture.hear({ text: "", partial: true });
```

The textarea must contain `架空の一文目。 架空の二文目。`. Both the stop-microphone
and send-arrow buttons must remain available. Click `Send message`, then inject:

```js
window.dictationFixture.late("架空の一文目。 架空の二文目。");
window.dictationFixture.hear({ text: "送信後の独り言。", partial: true });
window.dictationFixture.stats();
```

The textarea must stay empty and `capturing` must be false. Fetch `messages`
using the fixture's printed URL and bot ID. It must contain one user message
with both sentences, followed by the fake engine's answer. Stop only the
fixture launcher with Ctrl-C to remove its temporary data.

Repeat with `这是第一句话。` and `這是第二句話。`, expecting one combined
message `这是第一句话。 這是第二句話。`. The automated browser test performs both
language cases in the same disposable fixture and saves a redacted
`<fixture-log-path>.dictation.json` containing the fixture URL, messages and
checks. Set `OMB_UI_E2E=1` to require execution when the browser tooling has
not yet been installed; the launcher installs tools in its own checkout tools
directory. On PowerShell:

```powershell
$env:OMB_UI_E2E = '1'
node node_modules/vitest/vitest.mjs run scripts/testing/dictation.e2e.test.ts --maxWorkers=1
```

This fixture injects transcript events without using a microphone or a speech
provider. It proves Unicode retention and send/cancel behavior, including
ignoring callbacks after sending; it does not prove language recognition.

## App language and native recognition

The [speech language recipe](speech-language.md) covers locale resolution and
the recorded Fish Audio upload alongside these native checks.

In a disposable macOS app profile, choose Chinese in Settings → Language while
the OS uses English. Start dictation and speak a non-sensitive Chinese
sentence, finish, check its text and send it. Repeat with both Chinese app
choices, English on a Chinese OS, Follow system, and another supported
language. Record the chosen recognition locale separately from the spoken
dialect and resulting script. Selecting Traditional Chinese is not a promise
of Cantonese support or script conversion.

Change the app language during capture: the current recording keeps its
starting locale and the next one adopts the change. Confirm an explicit
language without an available native recognizer gives the localized language
error rather than unrelated English output. Keep the current conditional
on-device policy and rebuild the helper with `pnpm build:speech` before testing.
An older caller that omits a locale keeps the OS-preference selection behavior.

## Scope

Apple's on-device Speech implementation can return a completed utterance's
metadata with `isFinal == false`, then reset the transcript on the next
utterance. The native helper forwards that boundary and its audio start time;
Electron accumulates utterances before forwarding a cumulative transcript to
the composer and call views. `partial: false` still means session completion,
so call-mode utterance boundaries do not submit extra turns.

The accumulator accepts cumulative recognizers, repeated boundary callbacks,
empty callbacks, partial corrections and distinct utterances with identical
words. The composer cancels capture on send, explicit stop, manual editing or
thread changes, and rejects late callbacks even before React removes listeners.
Rebuild the native Speech helper with `pnpm build:speech` as well as the
renderer; copying only the renderer does not deliver this fix.

The boundary workaround follows observations in the
[Apple Developer Forums](https://developer.apple.com/forums/thread/762952).
These observations are not a guarantee about every macOS Speech version.
If an OS returns truncated text without boundary metadata or distinguishable
audio timing, it cannot always be distinguished from a legitimate partial
correction. The synthetic fixture does not establish real microphone accuracy,
audio-device behavior, or unlimited native recognition duration. Verify those
manually on the target Mac without sending sensitive speech. Recognition
keeps the existing on-device setting; this fix adds no cloud transcription.

## Local verification record (2026-10-18)

The synthetic browser fixture retained both sentences, ignored an empty
callback, sent one combined message to the fake engine, and kept the textarea
empty after both an old callback and additional speech. Capture was false
after the send arrow. The unit suite also exercises 200 utterance boundaries,
Enter-to-send, manual corrections, thread switching, and recognition failure.
The native microphone itself was not used for this automated check.

A separate local file-only check streamed synthetic Japanese speech with
three-second silent gaps into the native on-device recognizer. It retained
all three utterances through the production Electron transport, preload and
Composer. Sending during recognition stopped capture, and the textarea stayed
empty for twenty seconds afterward. The native callback was unchanged; only
the test helper's microphone input was replaced by real-time file buffers.
This checks actual recognition boundaries, but not physical microphone quality.

## Earlier verification record (2026-11-12, Windows)

This run used the earlier speech-provider checkout, before adapting the
language change to main. It is historical evidence and does not qualify the
main-based implementation. The browser run passed with `OMB_UI_E2E=1`
(one test, 44.94 seconds). The disposable fixture at
`http://127.0.0.1:19680` retained Japanese and Chinese utterances, sent exactly
one user message for each pair, stopped capture, and ignored empty and late
callbacks. Its synthetic conversation and check results are retained under
the OS temporary directory in
`openmausbot-verification-evidence/server-1794491300197-26296.log.dictation.json`;
the adjacent `.log` is the fixture server log. The launcher was stopped by
the test's owned-process cleanup after explicitly closing its browser session.
The temporary fixture directory can remain on Windows after process cleanup;
no fixture listener remains. No microphone, live app, user data or
production transcription provider was used. The native macOS build, packaged
helper locale selection, global hotkey, physical microphone and real-provider
recognition accuracy remain pending.

That checkout's required `pnpm typecheck` reported existing
`findLast`, `findLastIndex` and `Promise.withResolvers` uses against its ES2022
library configuration. Keep this baseline failure separate from focused
language tests; do not treat a passing synthetic dictation test as a full
typecheck or native qualification.

## Main-based verification record (2026-11-12, Windows)

After adapting the language change to main at `2d74ba961`, the required
isolated browser run passed again with `OMB_UI_E2E=1` (one test, 64.79 seconds).
The disposable fixture at `http://127.0.0.1:21984` retained Japanese and Chinese
utterances, sent each combined pair once, stopped capture and ignored late
callbacks. Its redacted evidence is retained under the OS temporary directory
at `openmausbot-verification-evidence/server-1794494913926-1748.log.dictation.json`,
with the server log beside it. Scoped cleanup closed the fixture browser and
server; no listener or browser remained for this fixture.

The native locale, shortcut and session node suites passed 50 tests. Three
Swift checks and 16 native transport checks require macOS and were skipped;
the native-key catalog suite passed three tests and all 16 locale catalogs
validated. No real microphone or production speech provider was used.
Packaged Mac helper compilation, hotkeys and real-audio accuracy remain pending.
