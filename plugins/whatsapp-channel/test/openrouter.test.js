import { test } from "node:test";
import assert from "node:assert/strict";
import { ocrReceipt, transcribeAudio, parseJsonReply } from "../openrouter.js";

const env = { OPENROUTER_API_KEY: "k", VISION_MODEL: "m" };
const reply = (content) => async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content } }] }) });

test("parseJsonReply strips markdown fences", () => {
  assert.deepEqual(parseJsonReply('```json\n{"a":1}\n```'), { a: 1 });
});

test("ocrReceipt returns parsed JSON and rejects invalid output", async () => {
  assert.equal((await ocrReceipt("b64", "image/png", { env, fetchImpl: reply('{"monto":5000}') })).monto, 5000);
  await assert.rejects(ocrReceipt("b64", "image/png", { env, fetchImpl: reply("nope") }), /valid JSON/);
});

test("transcribeAudio derives the format from the mime type and rejects empty text", async () => {
  let body;
  const fetchImpl = async (_u, init) => { body = JSON.parse(init.body); return reply("hola")(); };
  assert.equal(await transcribeAudio("b64", "audio/ogg; codecs=opus", { env, fetchImpl }), "hola");
  assert.equal(body.messages[0].content[0].input_audio.format, "ogg");
  await assert.rejects(transcribeAudio("b64", "audio/ogg", { env, fetchImpl: reply("") }), /Empty/);
});

test("missing key fails before any request", async () => {
  await assert.rejects(transcribeAudio("b", "audio/ogg", { env: {}, fetchImpl: () => { throw new Error("called"); } }), /OPENROUTER_API_KEY/);
});
