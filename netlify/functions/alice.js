const MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash-lite';
const SYSTEM = 'Ты голосовой помощник на умной колонке. Отвечай по-русски, коротко: одно-три предложения, не больше 300 символов. Без markdown, списков, эмодзи и ссылок.';
const EXIT = ['хватит', 'выход', 'выйти', 'закрой', 'стоп', 'пока'];

const reply = (body, text, end = false, state) => ({
  statusCode: 200,
  headers: { 'Content-Type': 'application/json; charset=utf-8' },
  body: JSON.stringify({
    version: body.version || '1.0',
    session: body.session,
    response: { text: text.slice(0, 1000), end_session: end },
    ...(state ? { session_state: state } : {}),
  }),
});

async function ask(history) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 2600);
  try {
    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': process.env.GEMINI_API_KEY,
        },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: SYSTEM }] },
          contents: history.map((m) => ({ role: m.role, parts: [{ text: m.text }] })),
          generationConfig: { maxOutputTokens: 200, temperature: 0.7 },
        }),
        signal: ctrl.signal,
      }
    );
    if (!r.ok) { console.error(r.status, await r.text()); return null; }
    const d = await r.json();
    const parts = d?.candidates?.[0]?.content?.parts || [];
    return parts.map((p) => p.text || '').join('').trim() || null;
  } catch (e) {
    console.error(e.message);
    return null;
  } finally {
    clearTimeout(t);
  }
}

exports.handler = async (event) => {
  let body;
  try {
    const raw = event.isBase64Encoded
      ? Buffer.from(event.body || '', 'base64').toString('utf-8')
      : event.body || '{}';
    body = JSON.parse(raw || '{}');
  } catch (e) {
    console.error('parse error', e.message, event.body);
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ version: '1.0', response: { text: 'Ошибка разбора запроса', end_session: false } }),
    };
  }

  const req = body.request || {};
  const utt = (req.original_utterance || '').trim();
  const cmd = (req.command || '').trim().toLowerCase();

  if (utt.toLowerCase() === 'ping') return reply(body, 'pong');
  if (!cmd) return reply(body, body.session?.new ? 'Привет! Спрашивай что угодно.' : 'Не расслышала, повтори.');
  if (EXIT.includes(cmd)) return reply(body, 'Хорошо, до связи!', true);
  if (!process.env.GEMINI_API_KEY) return reply(body, 'Не задан ключ Gemini в Netlify.');

  const prev = body.state?.session?.history || [];
  const hist = [...prev, { role: 'user', text: utt || cmd }].slice(-6);
  const ans = await ask(hist);
  if (!ans) return reply(body, 'Нейросеть не успела ответить. Попробуй ещё раз.', false, { history: prev });
  return reply(body, ans, false, { history: [...hist, { role: 'model', text: ans }].slice(-6) });
};
