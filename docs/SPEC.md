# After Hours — build spec

Single source of truth for everyone building this app. If the code and this file disagree, raise it; don't silently pick one.

## 1. What this is

After Hours is a chill afternoon tech event run by Recurse, the technical club of KMIT. This app is the attendee's companion for the afternoon: an installable PWA they open on their phone at the door. It shows what is running now and next, alerts them before highlight activities, and is where they play every poll, hunt, Morse round and mini-game.

- Event date: **21 November 2026**, one afternoon, one venue.
- Audience: college students on their own phones (mostly Android Chrome, some iPhone Safari), on flaky college Wi-Fi or mobile data.
- Scale: design and test for **300 concurrent phones**.
- Three surfaces, one codebase:
  - **Attendee app** (`/`) — phone first, installable.
  - **Organiser console** (`/admin`) — laptop first, PIN protected.
  - **Projector view** (`/screen`) — 16:9 big screen, read only, PIN protected.

## 2. The feel (non-negotiable)

The owner's words: "really interactive, really fun, not some static one, very fun elements, funky style."

Every screen must react to the person using it. A screen that only displays text and a button is a failed screen.

- **Motion everywhere it means something:** springy presses, numbers that count up, bars that race, pins pressed onto the page, seals that crack, letters that unfold, pages that flip.
- **Sound and haptics:** short synthesised WebAudio blips (no audio files to download), `navigator.vibrate` on Android. One global mute toggle, remembered. Never play sound before the first user gesture.
- **Rewards:** spell-sparks and an enamel pin (a sticker) on every win. A personal **sticker book** (a leather tome) fills as people check in, vote, find hunt stops and beat Morse rounds.
- **Presence:** people see that others are here: live counters ("143 voting"), floating emoji reactions that also rain on the projector, a leaderboard that reshuffles with animation.
- **Voice:** copy is written like a club member talking to a friend. Short, cheeky, lowercase is fine. No corporate phrasing, no "Welcome to the platform".

### Visual direction: "a candlelit night at an old academy of magic and machines"

The owner's words: "kind of Harry Potter aesthetic, not exactly Harry Potter." Read as an **original wizarding-academy, dark-academia look**, built on the owner's four engraved tickets (`design/tickets/`, the art the Morse slips are printed on). It is our own world, never someone else's (see the IP rule below).

**The four tickets.** Antique-gold and cream etched line art on deep, slightly grained grounds; double-rule gold borders with corner flourishes and four-point stars; notched ticket corners; plaque cartouches and square frames.

| ticket | ground | home of |
| --- | --- | --- |
| armillary sphere | maroon | Morse, slips (and the PIN gates' backdrop) |
| great wave and moon | navy | hunt, trails, home, wallet, sign-in (the base palette) |
| ginkgo, books and lantern | forest-black, cream line art | polls, quiz, schedule, check-in |
| ruins and wisteria | plum | arcade, drops, recap, sticker book, leaderboard |

The attendee shell sets `data-palette` on `<body>` from the route; the projector sets it per scene; the four houses map onto the same four tickets visually.

**Grounds and surfaces.**
- *Night ground:* the page itself, the palette's deep colour with a faint gold grain and a candle-lit vignette. Headers, frames, plaques, nav and the projector are **gold on dark**.
- *Aged parchment:* the reading surface. Default cards (`<Card>`, tone `paper`), sheets, letters, the sticker-book leaves and the passport map carry `data-ground="parchment"`: warm cream, foxed edges, a faint fibre, an engraved gold-brown frame. Inside it the tokens flip to **iron-gall ink on cream** (14:1), the six accents become pale washes (iron-gall text on each is AA+), and buttons become dark plaques with gold letters (or struck gold for the call to action). Long text lives on parchment, never as long gold-on-dark runs.
- *Night plaques* (tone `ink`) and the tinted ticket cards (tones `tangerine` maroon, `sky` navy, `lime` forest, `grape` plum, `pink` rose, `sun` bronze) carry gold/cream text on the night ground.

**Type** (all SIL OFL 1.1, bundled as woff2 in `web/src/assets/fonts`, licences beside them, no font CDN):
- *Cinzel* (engraved capitals): display, headings, buttons, numerals.
- *EB Garamond* (old-style book face): body text, weight 500 on a 17px root, so body text is comfortably readable at 16px and above.
- *IM Fell English* italic: hand-set asides, labels and hints. No blackletter, ever, and never for body copy.

**Ornament** (`kit/Ornament.tsx`, `kit/WaxSeal.tsx`, `kit/Hourglass.tsx`): four-point stars on card corners, the star rule under every title, the notched cartouche (wordmark, plaques), the gold double rule (cards, the projector frame, icons, the share image).

**Motifs, mapped to features (the fun stays, restyled):**
- *Celebrations:* gold spell-sparks (four-point stars), winking glints and drifting candle embers instead of confetti; a soft candle-flicker glow on highlight cards.
- *Trail stamps:* wax seals pressed onto the passport, which is an **inked parchment map**: stops along a dotted path, footprints between the stops you have walked, a compass rose.
- *Stickers:* **enamel pins** (struck-gold rim, enamel colour, glassy shine); the sticker book is a **leather tome** with parchment leaves that flip and a ribbon marker; pins still to find are ink impressions.
- *Alerts:* an announcement arrives as a **sealed letter**: it drops in, the wax seal cracks, the letter unfolds. On the projector it unrolls as a proclamation.
- *Morse:* the telegraph key is a **brass instrument** on a polished wooden base; the armillary is its palette.
- *Polls and quiz:* the quiz is an enchanted exam, timed by a **sand hourglass**.
- *Wallet and stalls:* mocktails are drawn as **potion bottles**, points as **gold coins**; your rank is pressed in red wax. The UI keeps the plain words "points" and "mocktails" so nobody is confused at the counter; flavour lives in visuals and small copy.
- *Leaderboard:* your rank is an **illuminated scroll** on gilt rods (vermilion numeral); the projector reveal is a proclamation.
- *Flash drops:* a shooting star (the old lightning-bolt glyph is redrawn; see the IP rule).

**Original, not Harry Potter (hard rule).** No Harry Potter names, terms, logos, fonts or iconography anywhere in the app, copy, notifications or assets: no Hogwarts, the four house names, Quidditch, Galleons, Muggle, Marauder's Map, Sorting Hat, Hedwig or owl post; no lightning-bolt scar or bolt motif; no HP logo typeface or lookalikes; no crests or characters. Generic motifs are fine: candles, parchment, wax seals, potion bottles, quills, keys, books, stars, hourglasses, brass instruments. The club's own identity stays prominent: "after hours", the Recurse logo (white on the night ground, black on paper prints) and the Recurse robot.

**Hard bans** (still): frosted glass panels, purple-to-blue gradients, glowing status dots, gradient pill buttons, middle-dot separators, generic dashboard cards with soft shadows, emoji as the only decoration, stock icon-library look, clip-art cartoons. Cinzel capitals are for headings, buttons and numerals; small labels use the IM Fell italic, not letter-spaced caps.

**PWA and print.** Icons, maskable icons and the iOS launch images are the Recurse icon on the wave navy inside the gold double rule (`node scripts/make-icons.mjs`); the boot screen and `theme_color` are the same navy. The recap share image (1080x1920) is an engraved ticket on the ruins plum.

Design tokens live in one file (`web/src/styles/tokens.css`), including the parchment scope, the enamel, wax, brass and wood colours. Feature code uses tokens and the shared UI kit; it never invents colours, fonts or shadows.

Accessibility floor: 4.5:1 text contrast (3:1 for large display type) on both grounds, 44px touch targets, a visible focus state (a bright gold double ring on the night ground, a deep gold one on parchment), `prefers-reduced-motion` respected (motion reduced, not removed: sparks drift instead of bursting, the candle flicker and seal crack hold still), every game playable without sound.

## 3. Stack

- **Node 24**, TypeScript everywhere, npm workspaces: `shared/`, `server/`, `web/`.
- **server/**: Fastify, `node:sqlite` (built in, no native module), Zod validation, `web-push` for notifications. One process. SQLite file in a mounted volume, WAL mode.
- **web/**: Vite, React, React Router, TanStack Query, `motion` for animation, `vite-plugin-pwa` (Workbox, `injectManifest` so the service worker can handle push). CSS Modules + CSS variables. No Tailwind, no component library.
- **shared/**: Zod schemas and TypeScript types for every request, response and live event. Server and web both import from here. Nobody hand-writes a type that crosses the wire.
- **Live updates:** one SSE stream `GET /api/live` per client, with automatic fallback to polling `GET /api/live/poll?since=<cursor>` if the stream fails or stalls for 5 s. The web app has one `useLive()` layer; features subscribe by event name.
- **Tests:** Vitest for server logic and shared code; Playwright for a few end-to-end flows. `npm test` at the root runs everything that doesn't need a browser.
- **Deploy:** Docker on a DigitalOcean droplet. Multi-stage `Dockerfile` (build web, build server, slim runtime serving the built web statically from Fastify), `docker-compose.yml` with the app plus Caddy for automatic HTTPS, data volume for SQLite, all secrets via env (`.env.example` documents each). HTTPS is mandatory: service workers, push and the camera all need it.

Keep dependencies few. Every dependency added must be justified in the PR/commit message.

## 4. Sign-in

Passwords are handed out on a card in the **entry kit**. Organisers help people sign in at the entry desk.

- An organiser generates **kits** in the console: each kit is a short ID (e.g. `AH-042`) and a password of 3 short words or 6 unambiguous characters (no 0/O, 1/l/I). The console prints them as cut-out cards with a QR code that opens the app with the kit ID prefilled. The password is **never** in the QR.
- Kits can be generated blank (N cards) or from a pasted CSV of `name,roll`.
- Attendee signs in with kit ID + password. On first sign-in they confirm name and roll number, pick a nickname and build an avatar. A kit binds to one attendee; it can be signed in on a second device only after an organiser resets it.
- Passwords are stored hashed (scrypt). Plain passwords exist only in the printable sheet shown once at generation and in a downloadable CSV at that moment.
- Session: httpOnly, SameSite=Lax, Secure cookie; lasts the event day. Login is rate limited per IP and per kit ID.
- Organisers: a console PIN from env (`ADMIN_PIN`), separate cookie. Projector: `SCREEN_PIN`.
- **First sign-in is the event attendance record** (timestamped).

### 4.1 Student-ID login

- The registered list (Google Form) is imported in the console **participants** panel or with `npm run import-participants -w server -- --db <db> --csv <csv>` (same code). Rolls are normalised (uppercase, O to 0 where a roll has digits) and deduped by roll; duplicates and conflicts (same roll, different name or phone) are reported, the first is kept, conflicts are noted for the desk.
- Each participant owns a synthetic **roster kit** (`kits.kind = 'roster'`, id = their roll). The phone binds to it exactly like a printed kit and the first sign-in creates a normal attendee, so `attendeeId` and `kit_id` work everywhere downstream. Roster kits have no usable password and are hidden from the kits panel.
- The ID card QR (e.g. `055W-12600-C-NAME-CSE-250908`) is read by its first segment, the roll's last four. Names and dates are not used. One match: "that's you?". Several: a "who are you?" picker with name, year and section only (bound people disabled). None: "not on the list, show this at the desk". The server checks a pick belongs to the card and is not bound elsewhere.
- Typed fallback: full roll + last 4 digits of the registered phone; one reply for unknown roll and wrong digits; limited per roll and per network. Name-returning lookups are limited per network.
- One phone per ID (first wins; the console's participants panel and desk mode unbind). Optional console setting, off by default: also ask the last 4 phone digits after a scan.
- Browsers without BarcodeDetector (iPhone Safari, desk laptops) decode with jsQR, lazy-loaded and kept out of the precache.

## 5. Features

### 5.1 Home: now and next
- Big "happening now" card with a live progress ring, "up next" with a countdown, the full timeline below.
- A highlight activity gets special treatment (bigger, animated, sticker).
- Organisers can start, end, delay (+5/+10/+15), reorder and edit activities live; every phone updates within 2 s.
- Each activity has: title, blurb, location, start, end, kind (`talk | game | poll | hunt | morse | break | other`), highlight flag, optional link to the in-app feature that goes with it.
- Server time is the source of truth; the client computes an offset and never trusts the phone clock.

### 5.2 Attendance
- Event attendance = first sign-in.
- Per-activity check-in: the projector shows a 4-character code that rotates every 30 s (TOTP-style, derived server side, accepts current and previous window). Attendee types it, or scans the QR beside it. Check-in earns a sticker and points.
- Console: live count per activity, searchable list, CSV export.

### 5.3 Alerts
- Web Push "starts in 15 min" and "live now" for highlight activities, plus organiser broadcast announcements. Sent once each, idempotent across restarts and schedule edits (a delayed activity re-arms its 15-minute alert).
- In-app banner/toast for everyone via the live stream, whether or not push is enabled.
- A friendly permission prompt at a sensible moment (after first sign-in, not on page load). On iPhone, explain that alerts need "Add to Home Screen" and show how.

### 5.4 Polls
- Types: single choice, multi choice, this-or-that (two big tappable halves), rating scale (drag slider or emoji scale), word cloud (short free text), and **quiz** (one correct answer, countdown, points with a speed bonus).
- Organiser builds polls ahead of time, then launches / closes / reveals. One live poll at a time; it takes over the attendee home screen with an animated entrance.
- Results animate live on phones (after voting) and on the projector. Word cloud text passes a profanity filter and can be hidden by an organiser.
- One vote per attendee per poll, enforced server side. Quiz answers never reach the client before reveal.

### 5.5 Treasure hunt (individual)
- A sequence of stops. Each has a clue (text, optional image), and is solved by scanning a QR sticker at the venue or typing an answer. Answers are normalised (case, spaces) and checked server side; the client never holds answers or future clues.
- Each attendee gets the stops in a **shuffled order** (same final stop for all) so people spread out instead of following each other.
- Hints: up to 2 per stop, each costs points. Wrong-answer cooldown to stop brute force.
- Camera QR scanning in-app (`BarcodeDetector` where available, a small JS decoder fallback), with typed code fallback when the camera is denied.
- UI is a map/passport that collects stamps. Finishing triggers a big celebration; finish order and time decide bonus points.
- Console: build stops, print the QR stickers, watch live progress, open/close the hunt.

### 5.6 Morse challenge
- Practice mode with a tappable chart and a free-play key.
- **Decode** rounds: the phone plays a word as beeps, screen flashes and vibration; attendee types it. **Encode** rounds: attendee taps a big telegraph key (short/long press, real tone) to send a given word; timing is judged with tolerance.
- Rounds get harder (longer words, faster speed). Words are picked server side per attendee; the answer for a decode round is never sent to the client in readable form before submission. (Timings are necessarily observable; that is accepted.)
- Scored on accuracy and speed.

### 5.7 Arcade
Three small, quick, tech-flavoured mini-games people can play between sessions, each under 60 seconds a run, each feeding the leaderboard with a capped daily contribution so the arcade cannot outweigh the main challenges. Scores are sanity-checked server side (run tokens, plausible bounds). Suggested: a reaction-time game, a binary/hex speed game, a memory-pattern game. The builder may propose better ones.

### 5.8 Points, leaderboard, sticker book
- One points ledger table: every award is a row (`attendee, source, ref, points, at`) with a unique key so nothing is awarded twice.
- Leaderboard: top list + "you are #N", animated reordering, live. Projector version too.
- Sticker book: a defined set of stickers with unlock rules; unlocking is a ledger-like idempotent event and pops a celebration.

### 5.9 Reactions
A floating reaction bar on the attendee home screen: tap an emoji and it floats up on your phone and on the projector. Rate limited per attendee, batched on the server.

### 5.10 Organiser console
Run of show (5.1), kits and attendance (4, 5.2), polls (5.4), hunt (5.5), Morse and arcade on/off, announcements, leaderboard, and a danger zone (reset a feature's data, behind a typed confirmation).

### 5.11 Projector view
Auto-rotating scenes driven by what is live: join QR and now/next by default; live poll results when a poll is open; check-in code when a check-in is open; leaderboard; hunt progress; reaction rain overlaid on everything. Organiser can pin a scene.

## 6. Security and fairness
- Everything that decides points is validated on the server. Assume attendees open dev tools.
- Zod-validate every input. Rate limit auth, votes, answers, reactions.
- No secrets in the repo. `.env` is git-ignored.
- Escape/whitelist any attendee-supplied text shown on the projector.

## 7. Repo conventions
- Feature code is foldered by feature on both sides: `server/src/features/<name>/` and `web/src/features/<name>/`. A feature registers its routes, live events, attendee screens, console panel and projector scene through small registries set up by the foundation. A feature agent should rarely need to touch another feature's folder.
- Database migrations are numbered SQL files per feature (`server/src/features/<name>/migrations/NNN_*.sql`), applied in order at boot.
- TypeScript strict. No `any` across module boundaries. Lint and typecheck must pass.
- Commit small and often with clear messages. **Never push.** Never commit secrets.
- `npm run dev` starts server and web together. `npm run seed` loads a believable demo event (schedule, polls, hunt, kits with known demo passwords) so anyone can try everything in two minutes.
