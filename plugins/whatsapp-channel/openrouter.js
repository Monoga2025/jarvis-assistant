// OpenRouter helpers: receipt OCR and audio transcription. Key and model come from env.

async function chat(body, { env, fetchImpl }) {
  if (!env.OPENROUTER_API_KEY) throw new Error("Missing OPENROUTER_API_KEY.");
  const res = await fetchImpl("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.OPENROUTER_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error(`OpenRouter ${res.status}`);
  const data = await res.json();
  return data.choices?.[0]?.message?.content?.trim() ?? "";
}

const OCR_PROMPT = `Analiza este recibo, factura o captura de pago. Extrae la informacion en JSON puro sin markdown ni explicacion:

{"tipo":"gasto","concepto":"descripcion corta max 30 chars","monto":numero_entero_sin_puntos,"categoria":"Alimentacion","fecha":"YYYY-MM-DD o null","establecimiento":"nombre del lugar o null","confianza":"alta|media|baja"}

Categorias validas: Alimentacion, Transporte, Vivienda, Servicios, Educacion, Salud, Ocio, Negocios, Ahorro, Otros

Reglas:
- monto siempre en pesos colombianos, sin puntos ni comas, numero entero
- concepto: nombre del producto/servicio o del lugar
- confianza "baja" si el monto no se ve claro o hay dudas
- Si no es recibo o no hay monto: {"error":"no es recibo"}

Solo JSON.`;

export function parseJsonReply(raw) {
  const clean = raw.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
  try {
    return JSON.parse(clean);
  } catch {
    throw new Error("Vision model did not return valid JSON.");
  }
}

export async function ocrReceipt(base64Image, mimeType = "image/jpeg", { env = process.env, fetchImpl = fetch } = {}) {
  const raw = await chat(
    {
      model: env.VISION_MODEL,
      messages: [{ role: "user", content: [
        { type: "image_url", image_url: { url: `data:${mimeType};base64,${base64Image}` } },
        { type: "text", text: OCR_PROMPT }
      ] }],
      max_tokens: 250,
      temperature: 0
    },
    { env, fetchImpl }
  );
  return parseJsonReply(raw || "{}");
}

export async function transcribeAudio(base64Audio, mimeType = "audio/ogg", { env = process.env, fetchImpl = fetch } = {}) {
  const format = mimeType.split(";")[0].split("/")[1] || "ogg";
  const text = await chat(
    {
      model: env.VISION_MODEL,
      messages: [{ role: "user", content: [
        { type: "input_audio", input_audio: { data: base64Audio, format } },
        { type: "text", text: "Transcribe exactamente lo que dice este audio en español. Solo el texto transcrito, sin explicacion ni comillas." }
      ] }],
      max_tokens: 500,
      temperature: 0
    },
    { env, fetchImpl }
  );
  if (!text) throw new Error("Empty transcription.");
  return text;
}
