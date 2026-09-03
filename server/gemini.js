// The three things Magpie asks a model to do. All small, all cheap, none of
// them needing a corpus -- which is the point: the app has to be worth opening
// on the first scrap, not the fiftieth.

const ENDPOINT_BASE = 'https://generativelanguage.googleapis.com/v1beta/models/';

export const getModel = () => (process.env.GEMINI_MODEL || 'gemini-3.8-flash').trim();
const getKey = () => (process.env.GEMINI_API_KEY || '').trim();
export const isConfigured = () => Boolean(getKey());

export class ModelError extends Error {
  constructor(code, message, status = 502) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

async function call(parts, { temperature = 0.9, maxOutputTokens = 800, schema = null, think = false } = {}) {
  const key = getKey();
  if (!key) throw new ModelError('not_configured', 'No model is configured.', 503);

  const body = {
    contents: [{ role: 'user', parts }],
    generationConfig: {
      temperature,
      maxOutputTokens,
      // Reasoning tokens are drawn from maxOutputTokens, so a model left to
      // think spends the whole budget deliberating and returns a fragment --
      // which is exactly what happened here: every reply came back truncated
      // mid-word. Nothing Magpie says is worth thinking about first.
      ...(think ? {} : { thinkingConfig: { thinkingBudget: 0 } }),
      ...(schema ? { responseMimeType: 'application/json', responseSchema: schema } : {})
    }
  };

  let res;
  try {
    res = await fetch(`${ENDPOINT_BASE}${encodeURIComponent(getModel())}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(45000)
    });
  } catch {
    throw new ModelError('unreachable', 'Could not reach the model. Try again in a moment.', 503);
  }

  if (res.status === 429) throw new ModelError('rate_limited', 'Too many at once. Try again shortly.', 429);
  if (!res.ok) {
    let detail = `status ${res.status}`;
    try { const j = await res.json(); if (j?.error?.message) detail = j.error.message; } catch {}
    throw new ModelError('upstream_error', detail, 502);
  }

  const json = await res.json();
  const text = json?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new ModelError('empty', 'The model returned nothing.', 502);

  return {
    text: text.trim(),
    usage: {
      promptTokens: json.usageMetadata?.promptTokens ?? json.usageMetadata?.promptTokenCount ?? 0,
      outputTokens: json.usageMetadata?.candidatesTokenCount ?? 0
    },
    model: getModel()
  };
}

/**
 * The voice of the thing.
 *
 * Written for a fifteen-year-old, which mostly means what it must not be. No
 * exclamation marks, no encouragement, no enthusiasm, and never the register of
 * an adult being fun -- that is the fastest way to make someone close an app and
 * not reopen it. Short, dry, and then quiet.
 */
const VOICE = `You are Magpie: a bird that collects the interesting bits of what
someone throws at you. You are dry, brief and a bit sideways. You are not a
coach, an assistant or a teacher, and you never sound like one.

Rules you do not break:
  - One sentence. Two at the very most, and only if the second is short.
  - No exclamation marks. No emoji. No praise. Never say "great" or "love this"
    or "interesting" about what they wrote.
  - Never tell them what to do. Never mention productivity, goals, focus,
    organising, or their own thinking process.
  - Do not summarise what they said back to them. They know what they wrote.
  - If the scrap is dull, that is fine. Say something small and move on. Do not
    manufacture enthusiasm.`;

/**
 * One short thing said back, immediately, on a single scrap.
 *
 * This is the whole answer to the cold start. Connections need a pile and
 * topics need a bigger one, but being said something to needs only the scrap
 * that was just thrown in.
 *
 * Two shapes, chosen at random rather than by rule. A question that opens the
 * idea up is more useful; a remark is better company. Alternating unpredictably
 * is also the point -- a response you can predict stops being worth reading.
 */
export async function echo(body, { wantQuestion = Math.random() < 0.45 } = {}) {
  const shape = wantQuestion
    ? `Ask one short question about it. Curious, not instructive: the question a
       friend asks, not the one a teacher asks. Never ask what their next step
       is or how they will get started.`
    : `Say one short thing back. A dry remark, an odd angle on it, or something
       you noticed. Not advice.`;

  const { text, usage, model } = await call(
    [{ text: `${VOICE}\n\n${shape}\n\nWhat they threw in:\n\n${body}` }],
    { temperature: 1.0, maxOutputTokens: 400 }
  );
  // Models like to wrap a single line in quotes; it reads as a citation rather
  // than as something said.
  return { text: text.replace(/^["'“”]+|["'“”]+$/g, '').trim(), usage, model };
}

/**
 * Two unrelated scraps, knocked together.
 *
 * Needs exactly two, which is the reason it exists: clustering wants dozens,
 * but collision wants a pair, so this works on day one. It also plays to
 * divergent thinking rather than against it -- the pile becomes a toy long
 * before it becomes an archive.
 */
export async function collide(first, second) {
  const { text, usage, model } = await call(
    [{ text: `${VOICE}

Two unrelated things they wrote. Put them together and say what falls out: an
idea, a joke, a question, something absurd. Do not explain the connection or
point out that they are unrelated. One or two sentences.

A: ${first}

B: ${second}` }],
    { temperature: 1.15, maxOutputTokens: 400 }
  );
  return { text: text.replace(/^["'“”]+|["'“”]+$/g, '').trim(), usage, model };
}

/**
 * Speech to text.
 *
 * The recording is the scrap and is kept; this is only a reading of it. That
 * ordering matters and is the same rule the rest of the app follows -- what the
 * person produced is never replaced by what a model made of it, so a wrong
 * transcript is a wrong label on the original rather than a lost thought.
 */
export async function transcribe(audioBase64, mimeType = 'audio/webm') {
  const { text, usage, model } = await call([
    { inlineData: { mimeType, data: audioBase64 } },
    { text: `Write out what is said, in the language it is spoken in. Nothing
else: no summary, no preamble, no speaker labels, no timestamps, no quotation
marks around it. Keep it as spoken, including false starts, rather than tidying
it into sentences. If there is no speech at all, return an empty string.` }
  ], { temperature: 0, maxOutputTokens: 4096 });

  return { text: text.replace(/^["'“”]+|["'“”]+$/g, '').trim(), usage, model };
}
