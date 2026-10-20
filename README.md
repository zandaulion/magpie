# 🐦‍⬛ Magpie

Throw scraps in. It works out what they add up to.

Text, pictures and voice. The point is that recording a thought costs nothing —
no title, no category, no tags — and that everything Magpie makes of them
afterwards sits on top rather than replacing them.

**The interface and Magpie's replies are in Romanian.** The people using it
think in Romanian, and reading a second language is friction — which is the one
thing this app exists to remove. Comments and commits stay in English; only
what a person sees is translated.

## What is here

A self-hosted capture app with account/device invitations, text, photographs and
voice notes. Original scraps remain separate from model-generated responses.
The current implementation also includes embeddings, related scraps, topic
grouping/naming and editable topic expansions. AI features require a configured
provider; basic capture remains useful without one.

[Project overview](https://zandaulion.com/magpie.html) · [Run locally](#running-it)
· [Configuration](#configuration) · [Security](SECURITY.md)

## What it does now

Capture, and three things that need no pile to be worth anything:

- **Magpie says one thing back** to each scrap — a dry remark, or a question
  that opens it up. Chosen at random between the two, because a response you
  can predict stops being worth reading. Asked for *after* the scrap is saved,
  so a slow or absent model costs a remark and never a thought.
- **Knock two together** — two scraps at random, and what falls out. Available
  from the second scrap, which is the point of it: clustering needs dozens
  before it can say anything true, collision needs a pair.
- **Say it** — speak instead of typing. The recording is kept and the
  transcript is a reading of it, so a bad transcription is a wrong label rather
  than a lost thought.
- **Photographs** get a remark of their own, and a photographed board or page
  can have its text lifted into the box — offered as a button rather than done
  automatically, because reading a picture means sending it away.

What leaves the server: a scrap goes to the model when Magpie is asked to say
something about it, read a photograph or transcribe speech. Nothing else does,
and the settings screen says so in as many words.

None of this needs a corpus. That is deliberate: an app whose payoff arrives in
three weeks is an app nobody reaches week two of.

## What it will not do

No streaks. No reminders asking where you have been. No count that implies a
target. A missed week should cost nothing, because an app that can make you
feel behind is one you stop opening.

## Connections, topics and expansions

The server exposes embedding backfill, related-scrap lookup, topic regrouping,
topic naming, and topic expansions; the UI provides these actions. Topics need
enough material to form a useful group. A lack of topics in a small collection
does not mean capture failed. Model availability, account limits and corpus size
affect which actions can complete.

Treat this as a personal experimental application, not an independently audited
service. Propose future work through Issues instead of treating older design
ideas as a current release checklist.

## Rules the code keeps

- **Scraps are immutable.** No update path for the body. Second thoughts are
  new scraps.
- **A model's words and yours are never stored the same way.** In six months
  you should still be able to tell which thoughts were yours.
- **Capture is the first thing on screen.** The moment dumping is behind
  navigation, the premise is gone.

## Running it

Use Node.js 24 or newer (`node:sqlite`), npm, and `openssl`. From the repository root:

```bash
npm ci
npm test
umask 077
printf 'ADMIN_TOKEN=%s\nPUBLIC_BASE_URL=http://127.0.0.1:3000\nCOOKIE_INSECURE=1\nDATA_DIR=./data\n' \
  "$(openssl rand -hex 32)" > .env
set -a
. ./.env
set +a
npm start
```

This creates a new ignored `.env`; use an empty checkout and do not overwrite an
existing deployment’s environment file. In another terminal in the same checkout:

```bash
set -a
. ./.env
set +a
curl --fail http://127.0.0.1:3000/api/admin/invites \
  -H "X-Admin-Token: $ADMIN_TOKEN" -H 'Content-Type: application/json' \
  --data '{"label":"Demo device"}'
```

Open the returned `url` to activate the browser. `COOKIE_INSECURE=1` is for this
loopback HTTP trial only; remove it for HTTPS deployment. The app listens on
loopback by default. A production reverse proxy must block public admin routes
and must not forward a caller-supplied admin header.

## Configuration

| Variable | Purpose |
| --- | --- |
| `ADMIN_TOKEN` | Required secret for the private admin API; absent means admin access is denied. |
| `PUBLIC_BASE_URL` | Exact origin used to construct invitations. |
| `DATA_DIR` | Database, images and audio; defaults to `./data`. |
| `HOST`, `PORT` | Listener; defaults to `127.0.0.1:3000`. |
| `COOKIE_INSECURE` | `1` permits local HTTP; leave unset for secure cookies. |
| `GEMINI_API_KEY` | Optional provider credential for AI responses, media interpretation and embeddings. |
| `GEMINI_MODEL`, `GEMINI_EMBED_MODEL` | Optional model overrides; see `server/gemini.js` for current defaults. |
| `MAGPIE_DAILY_AI_LIMIT` | Daily request budget; see `server/budget.js`. |

Model requests can send selected scrap text, images or audio to the provider.
Keep the provider key outside Git and review its terms before using personal data.
Local capture does not require successful model calls.

For deployment, build `deploy/Containerfile` and provide the same environment,
persistent data volume and HTTPS/private-admin routing. Back up the entire data
directory with the server stopped, together with the private configuration.
Databases, recordings, images and recovery codes must not be shared in bug reports.

## License

[GNU GPL v3 or later](LICENSE).


## Support and contributions

Use this repository’s Issues for reproducible bugs and focused feature requests. Include the version, relevant runtime/browser, expected behavior and a minimal synthetic example. Remove credentials, personal records, device identifiers and deployment-specific values before sharing logs or screenshots.

Run `npm test` before submitting server changes. Tests use temporary synthetic data; do not point them at a live data directory.

Keep changes focused and update the affected documentation. Security-sensitive reports should follow [SECURITY.md](SECURITY.md).
