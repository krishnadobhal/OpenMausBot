import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { launchVerificationServer, verificationServerArgs, verificationServerEnvironment, type VerificationServer } from "../scripts/control-omb.ts";
import { STT_LANGUAGE_HEADER } from "../shared/stt-language.ts";
import { waitForExit } from "./testing/cleanup.ts";
import { hostTimeout } from "./testing/host-timeout.ts";

let fixture: VerificationServer | undefined;
let child: ChildProcess | undefined;
let provider: Server | undefined;
const requests: Array<{ model?: string; language: ReturnType<FormData["get"]>; audio: string }> = [];

beforeAll(async () => {
  provider = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const request = new Request("http://fixture/upload", { method: "POST", headers: { "content-type": req.headers["content-type"]! }, body: Buffer.concat(chunks) });
    const form = await request.formData();
    const audio = form.get("audio") as File;
    requests.push({ model: req.headers.model as string | undefined, language: form.get("language"), audio: await audio.text() });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ text: "  你好，世界。 नमस्ते दुनिया।  " }));
  });
  await new Promise<void>((resolve) => provider!.listen(0, "127.0.0.1", resolve));
  const endpoint = `http://127.0.0.1:${(provider.address() as AddressInfo).port}`;
  fixture = await launchVerificationServer();
  await waitForExit(fixture.child, { signal: "SIGTERM" });
  const configPath = join(fixture.info.dataDir, "config.json");
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  config.tts = { ...config.tts, fishKey: "fixture-speech-language-key" };
  writeFileSync(configPath, JSON.stringify(config));
  const env = {
    ...verificationServerEnvironment(process.env, fixture.info.dataDir, Number(new URL(fixture.info.url).port)),
    OMB_FISH_AUDIO_API: endpoint,
  };
  const log = openSync(fixture.info.logPath, "a", 0o600);
  try { child = spawn(process.execPath, verificationServerArgs(env), { env, stdio: ["ignore", log, log], windowsHide: true }); }
  finally { closeSync(log); }
}, hostTimeout(90_000));

afterAll(async () => {
  try { await waitForExit(child, { signal: "SIGTERM" }); }
  finally {
    try { await fixture?.close(); }
    finally { if (provider) await new Promise<void>((resolve, reject) => provider!.close((error) => error ? reject(error) : resolve())); }
  }
});

it("validates recording languages and maps Fish hints through the isolated server", async () => {
  await expect.poll(async () => {
    try { return (await fetch(`${fixture!.info.url}/api/health`, { signal: AbortSignal.timeout(1_000) })).status; }
    catch { return 0; }
  }, { timeout: hostTimeout(30_000), interval: 100 }).toBe(200);
  const upload = async (locale?: string) => {
    const response = await fetch(`${fixture!.info.url}/api/tts/transcribe`, {
      method: "POST", headers: { "content-type": "audio/wav", origin: fixture!.info.url, ...(locale === undefined ? {} : { [STT_LANGUAGE_HEADER]: locale }) },
      body: Buffer.from("RIFF-fixture-speech"),
    });
    return { status: response.status, body: await response.json() };
  };
  for (const [locale, language] of [["ZH-hant-tw", "zh"], ["hi-IN", "hi"], ["pt-BR", "pt"], ["yue-HK", null], [undefined, null]] as const) {
    expect(await upload(locale)).toEqual({ status: 200, body: { text: "你好，世界。 नमस्ते दुनिया।" } });
    expect(requests.at(-1)).toEqual({ model: "transcribe-1-pro", language, audio: "RIFF-fixture-speech" });
  }
  const count = requests.length;
  for (const locale of ["", "zh_CN", "zh, en", "a".repeat(101), "und"]) expect((await upload(locale)).status).toBe(400);
  const duplicate = await new Promise<number | undefined>((resolve, reject) => {
    const request = httpRequest(`${fixture!.info.url}/api/tts/transcribe`, {
      method: "POST", headers: ["content-type", "audio/wav", "origin", fixture!.info.url, STT_LANGUAGE_HEADER, "zh", STT_LANGUAGE_HEADER, "hi"],
    }, (response) => { response.resume(); response.on("end", () => resolve(response.statusCode)); });
    request.on("error", reject);
    request.end("RIFF-fixture-speech");
  });
  expect(duplicate).toBe(400);
  expect(requests).toHaveLength(count);
  const evidencePath = `${fixture!.info.logPath}.speech-language.json`;
  writeFileSync(evidencePath, JSON.stringify({ fixture: fixture!.info, requests, checks: ["Chinese and Hindi hints mapped", "regional hint mapped", "unsupported hint omitted", "legacy no-language request", "invalid and repeated headers refused before provider", "Unicode transcript retained", "Fish pro model preserved"] }, null, 2));
  console.log(`Speech language evidence: ${evidencePath}`);
}, hostTimeout(60_000));
