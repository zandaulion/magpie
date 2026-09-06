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
  if (!key) throw new ModelError('not_configured', 'Nu e configurat niciun model.', 503);

  const body = {
    contents: [{ role: 'user', parts }],
    generationConfig: {
      temperature,
      maxOutputTokens,
      // Reasoning tokens come out of maxOutputTokens, so a model left to think
      // spends the budget deliberating and returns a fragment. Asking for none
      // helps but is not honoured every time: measured over four identical
      // calls, three used no thinking at all and one spent 382 tokens, leaving
      // 14 for the answer and cutting it off mid-word. So the ask stays, and
      // the budget below is wide enough to survive being ignored.
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
    throw new ModelError('unreachable', 'N-am putut ajunge la model. Mai încearcă într-un minut.', 503);
  }

  if (res.status === 429) throw new ModelError('rate_limited', 'Prea multe deodată. Mai încearcă în scurt timp.', 429);
  if (!res.ok) {
    let detail = `status ${res.status}`;
    try { const j = await res.json(); if (j?.error?.message) detail = j.error.message; } catch {}
    throw new ModelError('upstream_error', detail, 502);
  }

  const json = await res.json();
  const candidate = json?.candidates?.[0];
  const text = candidate?.content?.parts?.[0]?.text;
  if (!text) throw new ModelError('empty', 'Modelul n-a returnat nimic.', 502);

  // A remark that stops mid-word is worse than none: it reads as the app
  // breaking rather than as the bird being brief. Refuse it and let the caller
  // decide, rather than storing a fragment that can never be repaired --
  // echoes are written once and kept.
  if (candidate.finishReason === 'MAX_TOKENS') {
    throw new ModelError('truncated', 'Răspunsul s-a oprit la jumătate.', 502);
  }

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
 * Romanian, because the person reading it thinks in Romanian and translating in
 * your head is friction -- which is the one thing this app exists to remove.
 *
 * Written for a fifteen-year-old, which is mostly a list of what it must not
 * be: no exclamation marks, no praise, no encouragement, and never the register
 * of an adult trying to be fun. Always "tu", never the polite form -- a bird
 * that addresses you formally is a bird from school.
 */
const VOICE = `Ești Magpie: o coțofană care adună ce e interesant din ce arunci
spre ea. Ești seacă, scurtă și un pic piezișă. Nu ești antrenor, asistent sau
profesor și nu suni niciodată ca unul.

Scrii în română. Te adresezi cu "tu", niciodată cu dumneavoastră.

Reguli pe care nu le încalci:
  - O propoziție. Cel mult două, și doar dacă a doua e scurtă.
  - Fără semne de exclamare. Fără emoji. Fără laude. Nu spui niciodată "super",
    "genial" sau "interesant" despre ce a scris.
  - Nu îi spui ce să facă. Nu pomenești de productivitate, obiective,
    concentrare, organizare sau felul în care gândește.
  - Nu îi rezumi ce a scris. Știe ce a scris.
  - Dacă fragmentul e banal, e în regulă. Spui ceva mic și mergi mai departe.
    Nu inventezi entuziasm.`;

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
    ? `Pune o întrebare scurtă despre asta. Curioasă, nu instructivă: întrebarea
       pe care o pune un prieten, nu una de la școală. Nu întreba niciodată care
       e următorul pas sau cum se apucă.`
    : `Spune un lucru scurt înapoi. O remarcă seacă, un unghi ciudat, sau ceva
       ce ai observat. Nu sfaturi.`;

  const { text, usage, model } = await call(
    [{ text: `${VOICE}\n\n${shape}\n\nCe a aruncat înăuntru:\n\n${body}` }],
    { temperature: 1.0, maxOutputTokens: 1500 }
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

Două lucruri fără legătură pe care le-a scris. Pune-le împreună și spune ce iese:
o idee, o glumă, o întrebare, ceva absurd. Nu explica legătura și nu menționa că
n-au legătură. Una sau două propoziții.

A: ${first}

B: ${second}` }],
    { temperature: 1.15, maxOutputTokens: 1500 }
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

/**
 * One short thing back, about a photograph.
 *
 * Same job as echo(), same voice, different sense. Kept separate rather than
 * folded in because a picture needs its own instruction: the failure mode is a
 * model that describes what it sees, and a description of your own photograph
 * is the least interesting thing anyone could say about it.
 */
export async function look(imageBase64, mimeType = 'image/jpeg', body = '') {
  const said = body.trim()
    ? `Au scris și asta lângă poză:\n\n${body.trim()}`
    : 'N-au scris nimic, doar poza.';

  const { text, usage, model } = await call([
    { inlineData: { mimeType, data: imageBase64 } },
    { text: `${VOICE}

O poză pe care a aruncat-o înăuntru. Spune un lucru scurt despre ea, sau pune o
întrebare scurtă.

Nu descrie ce se vede. Știe ce a fotografiat — a fost acolo. Dacă în poză e text
scris de mână sau pe tablă, nu îl citi cu voce tare înapoi.

${said}` }
  ], { temperature: 1.0, maxOutputTokens: 1500 });

  return { text: text.replace(/^["'“”]+|["'“”]+$/g, '').trim(), usage, model };
}

/**
 * The words out of a photograph.
 *
 * The same shape as speech: the picture is what was produced and is kept, and
 * this is only a reading of it, dropped into the box to be looked at before
 * anything is saved. A whiteboard at the end of a lesson is a thought worth
 * catching, and retyping it is exactly the friction the app exists to remove.
 */
export async function readImageText(imageBase64, mimeType = 'image/jpeg') {
  const { text, usage, model } = await call([
    { inlineData: { mimeType, data: imageBase64 } },
    { text: `Scrie textul care se vede în imagine, în limba în care e scris.

Doar textul: fără rezumat, fără introducere, fără ghilimele în jur, fără să
descrii imaginea.

Scrie-l compact. Rândurile de pe un ambalaj sau un afiș sunt rupte de lățimea
lui, nu de sens — lipește-le la loc într-un text curgător. Nu lăsa rânduri
goale. Nu repeta același lucru în două limbi: alege una.

Păstrează rândul separat doar unde chiar înseamnă ceva: elementele unei liste,
punctele unei teme, rândurile unei rețete. În rest, un singur paragraf.

Dacă nu se vede niciun text lizibil, returnează un șir gol.` }
  ], { temperature: 0, maxOutputTokens: 4096 });

  return { text: text.replace(/^["'“”]+|["'“”]+$/g, '').trim(), usage, model };
}

/**
 * The vector behind a scrap.
 *
 * A different endpoint and a different model from the three above: embedding
 * is not generation, it costs a small fraction of a generation call, and it is
 * deliberately outside the daily budget. Rationing it would ration the thing
 * the app is for -- connections between scraps are computed locally against
 * these vectors, with no model call at all.
 *
 * RETRIEVAL_DOCUMENT rather than the default, because every scrap is stored to
 * be found later by another scrap; asking for the symmetric task puts the
 * whole pile in one space where near really does mean near.
 */
const EMBED_MODEL = (process.env.GEMINI_EMBED_MODEL || 'gemini-embedding-001').trim();

export const embedModel = () => EMBED_MODEL;

export async function embed(text) {
  const key = getKey();
  if (!key) throw new ModelError('not_configured', 'Nu e configurat niciun model.', 503);

  const trimmed = String(text || '').trim();
  if (!trimmed) throw new ModelError('empty', 'Nimic de reprezentat.', 400);

  let res;
  try {
    res = await fetch(`${ENDPOINT_BASE}${EMBED_MODEL}:embedContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      // Bounded: a very long scrap would otherwise be truncated by the service
      // at a point we do not choose. 8k characters is far more than any scrap
      // seen so far and well inside the model's input limit.
      body: JSON.stringify({
        model: `models/${EMBED_MODEL}`,
        content: { parts: [{ text: trimmed.slice(0, 8000) }] },
        taskType: 'RETRIEVAL_DOCUMENT'
      })
    });
  } catch (err) {
    throw new ModelError('unreachable', 'Nu am putut ajunge la model.', 502);
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new ModelError('upstream', `Modelul a răspuns ${res.status}. ${detail.slice(0, 200)}`,
                         res.status === 429 ? 429 : 502);
  }

  const json = await res.json();
  const values = json?.embedding?.values;
  if (!Array.isArray(values) || !values.length) {
    throw new ModelError('unreadable', 'Răspuns fără vector.', 502);
  }
  return values;
}

/**
 * A name for a group of scraps.
 *
 * Not in Magpie's voice, deliberately. The remarks and collisions are Magpie
 * talking; a topic name is a label the person has to live with in a list, and
 * a dry aside makes a bad label. So this one asks for plain words and nothing
 * else -- and it is only ever a suggestion, never applied over a name someone
 * typed themselves.
 */
export async function nameTopic(bodies) {
  const sample = bodies
    .slice(0, 12)
    .map((b) => `- ${String(b).replace(/\s+/g, ' ').slice(0, 200)}`)
    .join('\n');

  const { text, usage, model } = await call(
    [{
      text: `Următoarele fragmente au fost scrise de aceeași persoană și par să
fie despre același lucru. Dă-le un nume scurt, în română.

Reguli:
  - Două-patru cuvinte. Un substantiv sau o sintagmă, nu o propoziție.
  - Descriptiv și simplu. Numele stă într-o listă și trebuie recunoscut dintr-o
    privire.
  - Fără ghilimele, fără punct final, fără emoji.
  - Nu inventa un subiect care nu e acolo. Dacă fragmentele sunt despre muncă,
    spune despre ce anume.

Fragmentele:

${sample}`
    }],
    { temperature: 0.4, maxOutputTokens: 300 }
  );

  return {
    // Models like to answer a naming request with a sentence about the name.
    name: text.replace(/^["'“”]+|["'“”.]+$/g, '').split('\n')[0].trim().slice(0, 80),
    usage,
    model
  };
}

/**
 * Magpie's reading of a topic.
 *
 * The one piece of its writing meant to be kept, so it is the one that gets
 * more than a sentence. Everything else Magpie says is disposable -- an echo
 * can be deleted and nothing is lost -- but an extension is something a person
 * may edit and make theirs, which changes what it has to be worth.
 *
 * The hard rule is the same one VOICE carries and it matters more here than
 * anywhere: this must not be a summary. Handed a cluster of somebody's own
 * scraps, a model's instinct is to hand them back tidied up, and being told
 * what you already wrote is worse than being told nothing. So the ask is for
 * the thing the scraps are circling and have not said.
 */
/**
 * The angles an extension can take, one per call.
 *
 * Offered as a list in the prompt, the model worked through all of them in
 * order and every reading came out with the same shape -- "X repeats... what
 * is missing is... it remains unclear whether". A response you can predict
 * stops being worth reading, which is the same reason echo picks its shape at
 * random rather than by rule.
 */
const EXTENSION_ANGLES = [
  `Ce se repetă de la un fragment la altul și cum se schimbă pe drum.`,
  `Ce lipsește dintre lucrurile pe care te-ai fi așteptat să le găsești aici.`,
  `Un detaliu mic dintr-un singur fragment, care arată altfel lângă celelalte.`,
  `O întrebare la care fragmentele astea nu răspund.`,
  `Cum se schimbă felul de a scrie de la primele fragmente la ultimele.`,
  `Ce fel de lucru e ăsta, de fapt, judecând numai după ce e scris aici.`
];

export async function extend(topicName, bodies) {
  const angle = EXTENSION_ANGLES[Math.floor(Math.random() * EXTENSION_ANGLES.length)];
  const sample = bodies
    .slice(0, 20)
    .map((b) => `- ${String(b).replace(/\s+/g, ' ').slice(0, 400)}`)
    .join('\n');

  const { text, usage, model } = await call(
    [{
      text: `Ești Magpie: o coțofană care adună ce e interesant din ce arunci
spre ea. Curioasă, seacă, deloc entuziastă.

Scrii în română, cu "tu".

Fragmentele de mai jos sunt scrise de aceeași persoană, în timp, și par să fie
despre același lucru: "${topicName}".

Scrie despre ce e acolo, dintr-un singur unghi:

  ${angle}

Ăsta e unghiul. Nu le atingi pe toate celelalte pe rând.

Scrii despre fragmente, nu despre omul care le-a scris. Asta e regula
principală și e ușor de încălcat fără să bagi de seamă.

Reguli pe care nu le încalci:
  - Nu spui ce fel de om e, ce evită, ce urmărește de fapt, ce nu recunoaște
    sau ce se ascunde în spatele a ce a scris. Nu ești terapeut și nu ai fost
    întrebată.
  - Nu cauți contradicții și nu i le arăți. Dacă două fragmente se bat cap în
    cap, e viața lui, nu o greșeală de prins.
  - Nu rezuma. Știe ce a scris.
  - Două-cinci propoziții. Un singur paragraf. Scrii mereu ceva: chiar dacă
    fragmentele nu se leagă între ele, spui asta într-o propoziție. Un răspuns
    gol nu e o opțiune.
  - Nu inventa un fir care nu e acolo.
  - Fără sfaturi, fără pași următori, fără productivitate sau obiective.
  - Fără laude, fără emoji, fără semne de exclamare.

Dacă fragmentele sunt despre oameni apropiați sau despre ceva greu, rămâi la
ce e scris. Nu comentezi relația și nu împarți dreptate.

Fragmentele:

${sample}`
    }],
    { temperature: 0.95, maxOutputTokens: 1600 }
  );

  return { text: text.trim(), usage, model };
}
