import { test } from "node:test";
import assert from "node:assert/strict";
import { createWhatsAppClient } from "../client.js";

const env = { EVOLUTION_API_URL: "http://evo.test/", EVOLUTION_API_KEY: "k", EVOLUTION_INSTANCE: "inst one" };
const recorder = (responses = {}) => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    const hit = Object.entries(responses).find(([p]) => url.includes(p));
    return { ok: hit?.[1].ok ?? true, status: hit?.[1].status ?? 200, json: async () => hit?.[1].body ?? {} };
  };
  return { calls, fetchImpl };
};

test("send posts to the encoded instance path with the api key header", async () => {
  const { calls, fetchImpl } = recorder();
  await createWhatsAppClient({ env, fetchImpl }).send("100", "hi");
  assert.equal(calls[0].url, "http://evo.test/message/sendText/inst%20one");
  assert.equal(calls[0].init.headers.apikey, "k");
  assert.deepEqual(JSON.parse(calls[0].init.body), { number: "100", text: "hi" });
});

test("sendHuman splits on ||| and sends each non-empty part in order", async () => {
  const { calls, fetchImpl } = recorder();
  await createWhatsAppClient({ env, fetchImpl, sleepImpl: async () => {} }).sendHuman("100", "a ||| b ||| ");
  const texts = calls.filter((c) => c.url.includes("sendText")).map((c) => JSON.parse(c.init.body).text);
  assert.deepEqual(texts, ["a", "b"]);
});

test("missing configuration fails closed", async () => {
  const { fetchImpl } = recorder();
  await assert.rejects(createWhatsAppClient({ env: {}, fetchImpl }).send("1", "x"), /Missing EVOLUTION/);
});

test("HTTP errors do not leak the response body", async () => {
  const { fetchImpl } = recorder({ sendText: { ok: false, status: 401, body: { secret: "x" } } });
  await assert.rejects(createWhatsAppClient({ env, fetchImpl }).send("1", "x"), (e) => e.message === "Evolution API 401");
});

test("downloadMedia requires base64 in the response", async () => {
  const { fetchImpl } = recorder({ getBase64: { body: {} } });
  await assert.rejects(createWhatsAppClient({ env, fetchImpl }).downloadMedia({ key: {}, message: {} }), /no base64/);
});
