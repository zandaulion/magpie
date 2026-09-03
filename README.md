# 🐦‍⬛ Magpie

Throw scraps in. It works out what they add up to.

Text and pictures now, voice later. The point is that recording a thought
costs nothing — no title, no category, no tags — and that everything Magpie
makes of them afterwards sits on top rather than replacing them.

## What is here

Capture and read back, and the account machinery around it. Scraps are stored
exactly as written, newest first, and can be deleted. That is the whole of it
so far, and it is deliberately useful on its own: a plain heap you can add to
and search by eye is better than an empty clever thing.

## What is not here yet, in order

1. **Embeddings on save** — cheap, and the substrate for everything after.
2. **Connections** — "this touches that", computed locally against stored
   vectors, with no model call.
3. **Topics** — durable rows, not recomputed clusters, so a name you give one
   survives the next clustering run. A scrap belongs to several.
4. **Magpie expands** — a written reading of a topic, in its own table, never
   mixed into your words. Editing one makes it yours; regenerating then adds a
   new one beside it rather than overwriting what you touched.

Topics appear only once there are enough scraps to cluster honestly. Before
that the app says so rather than inventing categories out of four notes.

## Rules the code keeps

- **Scraps are immutable.** No update path for the body. Second thoughts are
  new scraps.
- **A model's words and yours are never stored the same way.** In six months
  you should still be able to tell which thoughts were yours.
- **Capture is the first thing on screen.** The moment dumping is behind
  navigation, the premise is gone.

## Running it

    npm install
    npm test
    DATA_DIR=./data npm start

Deployed as a container behind Caddy, with `ADMIN_TOKEN` and
`PUBLIC_BASE_URL` from `~/.config/magpie/magpie.env`. Invites and devices are
managed from the shared `pwa-invite-console`.
