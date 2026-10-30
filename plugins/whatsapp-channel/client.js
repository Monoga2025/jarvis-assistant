// EXPERIMENTAL WhatsApp channel (Evolution API). Not wired into the OpenClaw runtime.
// Configuration is read from environment variables at call time; nothing is hardcoded.

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function readEvolutionConfig(env = process.env) {
  const baseUrl = env.EVOLUTION_API_URL;
  const apiKey = env.EVOLUTION_API_KEY;
  const instance = env.EVOLUTION_INSTANCE;
  if (!baseUrl || !apiKey || !instance) {
    throw new Error("Missing EVOLUTION_API_URL, EVOLUTION_API_KEY or EVOLUTION_INSTANCE.");
  }
  return { baseUrl: baseUrl.replace(/\/+$/, ""), apiKey, instance };
}

export function createWhatsAppClient({ env = process.env, fetchImpl = fetch, sleepImpl = defaultSleep } = {}) {
  const call = async (path, { method = "GET", body } = {}) => {
    const { baseUrl, apiKey, instance } = readEvolutionConfig(env);
    const res = await fetchImpl(`${baseUrl}${path}/${encodeURIComponent(instance)}`, {
      method,
      headers: { apikey: apiKey, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    if (!res.ok) throw new Error(`Evolution API ${res.status}`);
    return res.json();
  };

  const send = (number, text) => call("/message/sendText", { method: "POST", body: { number, text } });

  const sendTyping = async (number, ms) => {
    try {
      await call("/chat/sendPresence", { method: "POST", body: { number, options: { presence: "composing", delay: ms } } });
    } catch {
      // Typing indicator is cosmetic; never block delivery.
    }
  };

  // Splits on "|||" and sends each part with a typing indicator and a human-like delay.
  const sendHuman = async (number, text) => {
    const parts = text.split("|||").map((p) => p.trim()).filter(Boolean);
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const typingMs = Math.min(600 + part.length * 28, 3800);
      await sendTyping(number, typingMs);
      await sleepImpl(typingMs);
      await send(number, part);
      if (i < parts.length - 1) await sleepImpl(600 + Math.random() * 900);
    }
  };

  const setWebhook = (url) =>
    call("/webhook/set", {
      method: "POST",
      body: { webhook: { enabled: true, url, webhookByEvents: false, webhookBase64: false, events: ["MESSAGES_UPSERT"] } }
    });

  const getStatus = () => call("/instance/connectionState");

  const downloadMedia = async ({ key, message }) => {
    const data = await call("/chat/getBase64FromMediaMessage", { method: "POST", body: { message: { key, message } } });
    if (!data.base64) throw new Error("Evolution returned no base64 payload.");
    return { base64: data.base64, mimetype: data.mimetype || "application/octet-stream" };
  };

  return { send, sendTyping, sendHuman, setWebhook, getStatus, downloadMedia };
}
