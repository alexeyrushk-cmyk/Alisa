import { getStore } from "@netlify/blobs";

export const config = { background: true };
const store = getStore("gemini-alice-jobs");

export default async (req) => {
  let payload;
  try { payload = await req.json(); }
  catch { return new Response("Bad JSON", { status: 400 }); }

  const { key, jobId, question } = payload || {};
  if (!key || !jobId || !question) return new Response("Missing fields", { status: 400 });

  try {
    const current = await store.get(key, { type: "json" });
    if (!current || current.jobId !== jobId) return new Response("Job superseded", { status: 200 });

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error("Missing GEMINI_API_KEY");

    const response = await fetch(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent?key=" + encodeURIComponent(apiKey),
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
      const message = data?.error?.message || `Gemini API returned ${response.status}`;
      throw new Error(message);
    }

    const answer = (data?.candidates?.[0]?.content?.parts || [])
      .map(part => part.text || "")
      .join("\n")
      .trim();
    if (!answer) throw new Error("Gemini returned an empty answer");

    const latest = await store.get(key, { type: "json" });
    if (latest?.jobId === jobId) {
      await store.setJSON(key, { status: "done", jobId, question, answer, updatedAt: Date.now() });
    }
  } catch (error) {
    console.error("Gemini background job failed:", error);
    const latest = await store.get(key, { type: "json" }).catch(() => null);
    if (latest?.jobId === jobId) {
      await store.setJSON(key, { status: "error", jobId, question, updatedAt: Date.now() }).catch(() => {});
    }
  }

  return new Response("Accepted", { status: 200 });
};
