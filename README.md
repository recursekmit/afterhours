# After Hours

The companion app for **After Hours**, a chill afternoon tech event by [Recurse](https://github.com/recursekmit), the technical club of KMIT. Event day: **Saturday 21 November 2026**.

Every participant runs it on their phone as an installable app. It shows what's on now and next, takes attendance, alerts people before the big moments, and hosts every activity. All points add up on one live leaderboard, which closes the day with a top-10 reveal on the projector.

| Document | What's in it |
|---|---|
| [docs/EVENT-DAY.md](docs/EVENT-DAY.md) | One-page operator cheat sheet: what to click, in order, and answers for volunteers |
| [docs/SCOPE.md](docs/SCOPE.md) | Scope and action plan: features, out of scope, roles, timeline, prep checklist, event-day run sheet, risks |
| [docs/SPEC.md](docs/SPEC.md) | Build spec: product, feel, stack, conventions |
| [docs/SLIPS.md](docs/SLIPS.md) | The Morse slips: slip format, orientation rule, scanner output, outcomes |
| [docs/EXTENDING.md](docs/EXTENDING.md) | How a feature plugs into the server and web registries |
| [docs/screens/](docs/screens/) | Screenshots of every screen |

## What it does

**Three screens, one app**

| Screen | URL | Who | Access |
|---|---|---|---|
| Participant app | `/` | Every attendee, on their phone | Entry-kit ID + password |
| Organiser console | `/admin` | Organisers, on a laptop | `ADMIN_PIN` |
| Projector | `/screen` | The room, on the big screen | `SCREEN_PIN` |
| Stall counter | `/stall` | Shopkeepers at the food, merch and mocktail stalls, on a phone or tablet | A 6-digit stall code from the console |

**Features**

- **Entry kits and attendance.**
  - Organisers generate kits in the console and print them as cut-out cards with a QR. The QR fills in the kit ID; the password is only printed on the card.
  - First sign-in is event attendance. One kit works on one phone, and the console can reset it.
  - Per-session check-in uses a 4-character code on the projector that rotates every 30 s.
  - CSV exports.
- **Now and next.**
  - Live "happening now" card, countdown to what's next, and the full timeline.
  - Organisers start, end, delay (+5/+10/+15), reorder and edit live.
- **Alerts.**
  - Web Push 15 minutes before and at the start of each highlight, re-armed when an activity is delayed.
  - Organiser announcements go out as push and as in-app banners.
- **Polls and quiz.**
  - Single, multi, this-or-that, rating, word cloud (with a profanity filter), and a server-timed quiz with a speed bonus.
  - A live poll takes over every phone; results race on the projector.
- **Trails (treasure hunt and Morse trail), online + offline.**
  - One engine runs both, configured from the console with no code changes.
  - Stop types:
    - **riddle**: type the answer;
    - **scan**: scan the sticker or object's QR;
    - **morse**: decode the Morse on a physical object;
    - **slip**: scan a Morse slip from your entry kit; how you hold it decides where it leads.
  - Trail orders: shuffled per person with a shared finale, fixed, or a **graph** where different answers lead down different paths.
  - Hints, cooldowns, finish bonuses.
  - The console prints QR stickers, Morse cards and slips.
- **Morse slips.** See [docs/SLIPS.md](docs/SLIPS.md).
  - Each slip has a Morse strip on every edge. The app reads the strip at the bottom of the camera view, so turning the slip gives a different answer.
  - An answer can lead to the next stop, a branch, a clue, a bonus or a decoy.
  - Slips can be the same in every kit, or different per kit.
  - Typing the decoded word always works as a fallback.
- **Online Morse challenge.**
  - Practice chart.
  - Decode rounds: the phone beeps, flashes and vibrates a word.
  - Encode rounds: a telegraph key, judged against your own rhythm.
  - Five levels, plus organiser-run speed rounds.
- **Arcade.**
  - Lag Spike (reaction time), Base Rush (binary/decimal/hex) and Echo (memory).
  - Capped at 60 points per person per day.
  - The puzzle hour: Packet Panic, Patch the Bot and Rebuild the Image in timed rounds, for houses and mocktail tokens.
- **Stalls and mocktails.**
  - Everyone starts with **2 free mocktails** (the allowance is set in the console). After that, points buy more: the home card shows "38 more points to your next mocktail".
  - Food, merch and the mocktail bar have menus built in the console: items, a points price, stock, a per-person limit, an optional photo, or a pasted CSV. A fresh database already has the mocktail bar (one mocktail: free allowance first, then 50 points).
  - The attendee shows a full-screen QR that changes every 30 s (plus a typed code). The shopkeeper scans it at `/stall`, sees free mocktails left, points and the basket, and taps "hand it over". The phone celebrates.
  - Spending never lowers the leaderboard: the board ranks points earned; spending lives in its own table.
  - Every hand-over is one SQLite transaction with an idempotency key, so two stalls can never give out a third free mocktail. Organisers can void a hand-over (points, drinks and stock come back) and export a transactions CSV.
- **Flash drops, live feed, hype.**
  - Drops fired or scheduled from the console take over every phone and the projector with a siren, a 3-2-1 and a countdown on the server clock: a **code drop** (first N to type the code win, live "17/20 claimed"), a **speed question**, a **golden slip** (a hidden word or QR, first finder takes the bonus and a sticker) and **everyone wins** (the room hits a reaction goal together). A ready-made library of tech and club drops fires in two taps.
  - A live feed of what's happening (nicknames only, coalesced and capped) as a strip on the home screen and a ticker on the projector. Organisers can mute it, hide a line or post their own.
  - A hype meter on the projector ("the room is on fire" at max, optionally firing an everyone-wins drop) and a personal streak chip on home.
- **Recap.**
  - After the closing reveal (or when the console opens it), everyone gets an Instagram-story style recap: arrival, check-ins, quiz rank and speed, trail path, Morse, arcade bests, stickers, final rank, top moment and an "after hours personality".
  - A 1080x1920 share image with their avatar and the Recurse logo, shared with the Web Share API or downloaded.
  - The projector shows the room's recap; the console previews anyone's.
- **Points, leaderboard, stickers, reactions.**
  - One points ledger where each thing pays once.
  - "You are #N, X behind" on the leaderboard, plus a freeze and top-10 countdown reveal.
  - A sticker book you flip like a zine (a page per category, completion, "only N% have this", cheeky hints on locked ones, tap to slap), and emoji reactions that rain on the projector.

**Fair play.** The server decides all scoring. Answers, future clues and quiz solutions never reach phones early. Everything spammable is rate-limited, and passwords are stored hashed (scrypt).

## Tech

- **Node 24+**, TypeScript everywhere, npm workspaces:
  - `shared/`: Zod schemas and types for every request, response and live event; both sides import them.
  - `server/`: Fastify and SQLite (built-in `node:sqlite`, WAL mode). Live updates over SSE with a polling fallback; Web Push.
  - `web/`: React, Vite, TanStack Query, `motion`, and `vite-plugin-pwa` (Workbox `injectManifest`).
- One Node process serves the API and the built web app.
- Fonts are bundled, so nothing is loaded from a font CDN.
- Designed and load-tested for 300 phones at once.

```
shared/src/            contract: core schemas + one file per feature (shared/src/features/*.ts)
server/src/core/       db + migrations, auth and kits, live bus, points and stickers, push, static
server/src/features/   one folder per feature, listed once in features/registry.ts
web/src/core/          api client, useLive(), server clock, feature contract
web/src/kit/           UI kit (cards, buttons, sheets, rings, stickers, avatar, QR, ...)
web/src/fun/           sfx, haptics, confetti, celebrations
web/src/surfaces/      attendee app, organiser console, projector
web/src/features/      one folder per feature, listed once in features/registry.ts
e2e/                   Playwright end-to-end tests against the built server
```

## Run it locally

You need **Node 24 or newer**.

```bash
npm install
npm run seed      # demo event: schedule, polls, trails, kits; prints demo logins and PINs
npm run dev       # API server + Vite dev server together
```

Open the Vite URL it prints (usually <http://localhost:5173>):

- participant app: `/`, signed in with a demo kit printed by the seed;
- console: `/admin`, with the console PIN printed by the seed;
- projector: `/screen`, with the projector PIN printed by the seed.

The seed's PINs and passwords are for local demos only.

The camera, push notifications and installing the app need HTTPS or `localhost`. To test on a real phone, use the deployed site, or a tunnel to your machine.

### Scripts

| Command | What it does |
|---|---|
| `npm run dev` | API (tsx watch) and web (Vite) side by side; Vite proxies `/api` |
| `npm run seed` | Load the demo event into the local database |
| `npm run build` | Build the web app and bundle the server |
| `npm start` | Run the built server (serves the built web app too) |
| `npm test` | All unit tests (Vitest): shared, server, pure web logic |
| `npm run typecheck` | TypeScript across every workspace and e2e |
| `npm run lint` | ESLint |
| `npm run check` | typecheck, lint, test and build in one go; run it before every commit |
| `npm run e2e` | Playwright end-to-end tests (run `npm run build` first). Set `E2E_PORT` to change the port |
| `npm run vapid -w server` | Generate a Web Push key pair |

## Configuration

All settings are environment variables; see [.env.example](.env.example) for every one, with notes. The important ones:

| Variable | Purpose |
|---|---|
| `ADMIN_PIN`, `SCREEN_PIN` | Console and projector PINs. Required in production, and they must differ. |
| `DOMAIN`, `ACME_EMAIL` | Public hostname and Let's Encrypt contact, used by Caddy under docker compose |
| `APP_URL` | Public URL used in QR codes. Compose sets it to `https://$DOMAIN`. |
| `DATABASE_PATH` | SQLite file. Under compose this is the `data` volume. |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` | Web Push. Optional: without them, alerts still show in the app. |
| `SESSION_HOURS` | How long an attendee stays signed in |
| `LOGIN_*` | Sign-in rate limits |

Never commit a real `.env`; it is git-ignored.

## Deploy (Docker droplet)

The app runs as one container behind Caddy, which gets HTTPS certificates automatically.

1. Point a DNS `A` record for your domain (for example `afterhours.recursekmit.in`) at the droplet's IP.
2. On the droplet, install Docker and clone this repo.
3. Configure:
   ```bash
   cp .env.example .env
   npm run vapid -w server   # or: docker run --rm node:24-slim npx web-push generate-vapid-keys
   # edit .env: ADMIN_PIN, SCREEN_PIN, DOMAIN, ACME_EMAIL, VAPID_* keys
   ```
4. Start:
   ```bash
   docker compose up -d --build
   docker compose ps              # app should be "healthy"
   curl https://$DOMAIN/api/health
   ```
5. Optional demo data, never on the real event database: `docker compose exec app node server/dist/seed.js`.

Ports 80 and 443 must be open. The SQLite database lives in the `data` volume, so back it up before and after the event:

```bash
docker compose exec app node -e "new (require('node:sqlite').DatabaseSync)('/data/afterhours.db').exec(\"VACUUM INTO '/data/backup.db'\")"
docker compose cp app:/data/backup.db ./afterhours-backup.db
```

To update: `git pull && docker compose up -d --build`. The database volume is kept.

## Event day, in short

The click-by-click version is [docs/EVENT-DAY.md](docs/EVENT-DAY.md). The run sheet and prep checklist are in [docs/SCOPE.md](docs/SCOPE.md).

1. In the console, load the real run of show, polls and trails. Generate and print the kit cards, QR stickers, Morse cards and slips.
2. At the entry desk, hand out kits and help each person sign in. Sign-in is their attendance.
3. Run the day from `/admin`:
   - start and end activities;
   - open check-ins;
   - launch, close and reveal polls;
   - open trails;
   - fire flash drops from the drop library;
   - send announcements.
4. Stalls: before doors, set each stall's menu in the console (stalls panel) and give each shopkeeper their 6-digit code. They open `/stall` on their phone, sign in, and scan attendees' QRs.
5. Keep `/screen` on the projector. It switches to whatever is live.
6. To close: freeze the leaderboard and run the top-10 reveal. Recaps open by themselves when it finishes. Afterwards, export the attendance and stall CSVs.

## Working on the code

- Read [docs/EXTENDING.md](docs/EXTENDING.md). A feature is one folder on each side plus one line in each registry.
- Run `npm run check` before committing. Commit small, with clear messages.
- The visual style is a deliberate cut-paper "zine": heavy ink outlines, offset shadows, tape, and loud flat colour. Use the kit components and the tokens in `web/src/styles/tokens.css`. Don't add new colours or fonts.
- Server-authoritative by design: anything that decides points is validated on the server.

## Credits

Built for and by **Recurse**, the technical club of KMIT, Hyderabad. Fonts are bundled under the SIL Open Font License; the licence files are next to the fonts in `web/src/assets/fonts/`.
