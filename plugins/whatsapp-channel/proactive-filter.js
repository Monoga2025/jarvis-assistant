// Anti-spam filter for proactive messages: per-type cooldowns plus identical-content suppression.
// State storage is injected ({ read(), write(state) }) so the filter has no file or path coupling.

import { createHash } from "node:crypto";

const H = 60 * 60 * 1000;
export const COOLDOWNS = {
  sin_estudio: 6 * H,
  estudio_bajo: 6 * H,
  score_financiero_bajo: 12 * H,
  saldo_critico: 12 * H,
  tareas_venciendo: 24 * H,
  spike_gasto: 1 * H,
  patron_decisiones_malas: 48 * H,
  weekly_reflection: 7 * 24 * H,
  morning_briefing: 20 * H,
  midday_check: 6 * H,
  evening_review: 20 * H,
  default: 4 * H
};

const MAX_LOG_SIZE = 100;
const RETENTION_MS = 48 * H;
const SAME_CONTENT_MS = 12 * H;

const hashContent = (s) => createHash("sha1").update(s).digest("hex").slice(0, 12);
const prune = (log, now) => log.filter((e) => new Date(e.ts).getTime() > now - RETENTION_MS);

export function createProactiveFilter(store, now = () => Date.now()) {
  const shouldSend = (type, content = "") => {
    const state = store.read();
    const log = prune(state.proactive_log ?? [], now());
    const last = log.filter((e) => e.tipo === type).sort((a, b) => new Date(b.ts) - new Date(a.ts))[0];
    if (!last) return { allow: true, reason: "ok" };
    const elapsed = now() - new Date(last.ts).getTime();
    if (last.hash === hashContent(type + content.slice(0, 100)) && elapsed < SAME_CONTENT_MS) {
      return { allow: false, reason: "same-content" };
    }
    const cooldown = COOLDOWNS[type] ?? COOLDOWNS.default;
    if (elapsed < cooldown) return { allow: false, reason: `cooldown:${type}` };
    return { allow: true, reason: "ok" };
  };

  const logSent = (type, content = "") => {
    const state = store.read();
    let log = prune(state.proactive_log ?? [], now());
    if (log.length >= MAX_LOG_SIZE) log = log.slice(-MAX_LOG_SIZE + 1);
    log.push({ tipo: type, hash: hashContent(type + content.slice(0, 100)), resumen: content.slice(0, 80), ts: new Date(now()).toISOString() });
    store.write({ ...state, proactive_log: log });
  };

  const isCrisisModeActive = () => store.read().crisis_mode?.active === true;

  return { shouldSend, logSent, isCrisisModeActive };
}
