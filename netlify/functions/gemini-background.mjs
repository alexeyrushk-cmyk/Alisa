import { getStore } from "@netlify/blobs";

export const config = { background: true };
const store = getStore("gemini-alice-jobs");

function safeError(error) {
  const message = error instanceof Error ? error.message : String(error || "Unknown error");
  // Never persist a URL that could contain the API key.
  return message.replace(/key=[^&\s]+/gi, "key=[redacted]").slice(0, 500);
}

export default async (req) => {
  let payload;
  try { payload = await req.json(); }
  catch {
    console.error("Gemini background: invalid JSON payload");
    return new Response("Bad JSON", { status: 400 });
  }

  const { key, jobId, question } = payload || {};
  if (!key || !jobId || !question) {
    console.error("Gemini background: missing required payload fields");
    return new Response("Missing fields", { status: 400 });
  }

  console.log("Gemini background: job started", { jobId, questionLength: String(question).length });

  try {
    const current = await store.get(key, { type: "json" });
    if (!current || current.jobId !== jobId) {
      console.warn("Gemini background: job superseded or missing", { jobId, found: Boolean(current) });
      return new Response("Job superseded", { status: 200 });
    }

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error("Missing GEMINI_API_KEY in Netlify function environment");

    console.log("Gemini background: calling Gemini API", { jobId, model: "gemini-3.6-flash" });
    const response = await fetch(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent?key=" + encodeURIComponent(apiKey),
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: question }] }],
          generationConfig: { maxOutputTokens: 700, temperature: 0.7 }
        })
      }
    );

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message = data?.error?.message || `Gemini API returned HTTP ${response.status}`;
      console.error("Gemini background: API request failed", { jobId, status: response.status, message });
      throw new Error(`Gemini API HTTP ${response.status}: ${message}`);
    }

    const answer = (data?.candidates?.[0]?.content?.parts || [])
      .map(part => part.text || "")
      .join("\n")
      .trim();
    if (!answer) {
      const reason = data?.promptFeedback?.blockReason;
      throw new Error(reason ? `Gemini blocked the prompt: ${reason}` : "Gemini returned an empty answer");
    }

    const latest = await store.get(key, { type: "json" });
    if (latest?.jobId === jobId) {
      await store.setJSON(key, { status: "done", jobId, question, answer, updatedAt: Date.now() });
      console.log("Gemini background: answer saved", { jobId, answerLength: answer.length });
    } else {
      console.warn("Gemini background: answer not saved because a newer job exists", { jobId });
    }
  } catch (error) {
    const errorMessage = safeError(error);
    console.error("Gemini background job failed:", { jobId, error: errorMessage });
    try {
      const latest = await store.get(key, { type: "json" });
      if (latest?.jobId === jobId) {
        await store.setJSON(key, {
          status: "error",
          jobId,
          question,
          errorMessage,
          updatedAt: Date.now()
        });
        console.log("Gemini background: error status saved", { jobId });
      }
    } catch (storeError) {
      console.error("Gemini background: could not save error status", {
        jobId,
        error: safeError(storeError)
      });
    }
  }

  return new Response("Accepted", { status: 200 });
};
