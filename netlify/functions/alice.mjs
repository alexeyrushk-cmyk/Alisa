import { getStore } from "@netlify/blobs";

const store = getStore("gemini-alice-jobs");
const VERSION = "1.0";
const MAX_TEXT = 4800;

function aliceReply(text, sessionState = {}, endSession = false) {
  return new Response(JSON.stringify({
    version: VERSION,
    response: { text: String(text).slice(0, MAX_TEXT), end_session: endSession },
    session_state: sessionState
  }), { headers: { "content-type": "application/json; charset=utf-8" } });
}

function normalize(text = "") {
  return text.toLowerCase().replace(/[ё]/g, "е").trim().replace(/[.!?,;:]+$/g, "");
}

function isContinue(text) {
  const t = normalize(text);
  return /^(продолжай|дальше|готово|ну что там|есть ответ|зачитай|скажи ответ|повтори ответ|проверить ответ)$/.test(t)
    || t.includes("продолжай") || t.includes("есть ответ") || t.includes("ну что там");
}

function getKey(body) {
  const session = body?.session ?? {};
  // session_id stays stable during an active Alice skill session.
  return session.session_id || session.user_id || session.application?.application_id || "anonymous";
}

export default async (req) => {
  if (req.method !== "POST") return aliceReply("Этот адрес принимает только запросы навыка Алисы.", {}, true);

  let body;
  try { body = await req.json(); }
  catch { return aliceReply("Не получилось прочитать запрос. Попробуй ещё раз.", {}, true); }

  const command = body?.request?.command || body?.request?.original_utterance || "";
  const key = getKey(body);
  const sessionState = body?.state?.session || {};

  try {
    if (isContinue(command)) {
      const job = await store.get(key, { type: "json" });
      if (!job) return aliceReply("У меня нет сохранённого ответа. Сначала задай вопрос.", sessionState, false);
      if (job.status === "pending") return aliceReply("Gemini ещё думает. Скажи «Продолжай» чуть позже.", sessionState, false);
      if (job.status === "error") {
        const detail = job.errorMessage ? ` Причина: ${String(job.errorMessage).slice(0, 350)}.` : "";
        return aliceReply(`Не получилось получить ответ от Gemini.${detail} Попробуй задать вопрос ещё раз.`, sessionState, false);
      }
      if (job.status === "done") {
        await store.setJSON(key, { ...job, status: "delivered", updatedAt: Date.now() });
        return aliceReply(job.answer || "Ответ пустой. Попробуй задать вопрос иначе.", sessionState, false);
      }
      if (job.status === "delivered") return aliceReply("Этот ответ я уже прочитала. Задай новый вопрос.", sessionState, false);
    }

    if (!command.trim()) return aliceReply("Привет! Спроси меня о чём-нибудь.", sessionState, false);
    if (!process.env.GEMINI_API_KEY) return aliceReply("Нужно добавить GEMINI_API_KEY в переменные окружения Netlify.", sessionState, true);

    const jobId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    await store.setJSON(key, { status: "pending", jobId, question: command, createdAt: Date.now() });

    const baseUrl = process.env.URL;
    if (!baseUrl) {
      await store.setJSON(key, { status: "error", jobId, question: command, updatedAt: Date.now() });
      return aliceReply("Не настроен адрес сайта Netlify. Проверь переменные окружения и деплой.", sessionState, true);
    }

    const start = await fetch(`${baseUrl}/.netlify/functions/gemini-background`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key, jobId, question: command })
    });

    if (!start.ok && start.status !== 202) {
      await store.setJSON(key, { status: "error", jobId, question: command, errorMessage: `Не удалось запустить фоновую функцию (HTTP ${start.status})`, updatedAt: Date.now() });
      return aliceReply("Не удалось запустить обработку Gemini. Попробуй ещё раз чуть позже.", sessionState, false);
    }

    return aliceReply("Секунду, отправляю вопрос Gemini. Когда захочешь проверить ответ, скажи «Продолжай».", sessionState, false);
  } catch (error) {
    console.error("Alice webhook error:", error);
    return aliceReply("Что-то пошло не так на сервере. Попробуй ещё раз.", sessionState, false);
  }
};
