# After Hours: scope and action plan

Recurse, the technical club of KMIT. Event: **Saturday 21 November 2026**, one afternoon, one venue.
Status as of Friday 20 November 2026: every feature below is built and tested on `main`. The detailed build spec is [SPEC.md](SPEC.md).

## 1. What we are building

After Hours is the companion app for a chill tech afternoon for about **60-70 participants**. Every participant runs it on their phone as an installable app. It does four jobs:

1. It tells people what is on now and next, and alerts them before the big moments.
2. It takes attendance: once at the entry desk and again at each session.
3. It hosts every activity: polls and a quiz, the treasure hunt, the Morse challenge, an arcade, flash drops, and live emoji reactions.
4. It totals points from everything into one live leaderboard, which ends the day with a top-10 reveal on the projector. Points also buy mocktails and treats at the stalls, and everyone leaves with a personal recap.

The same app runs on four kinds of screen:

| Surface | Who | Where | Notes |
|---|---|---|---|
| Participant app `/` | Every attendee | Their own phone | Mobile app, installs to the home screen and opens full screen. On a laptop it shows a phone-sized column and a QR to open it on a phone. |
| Organiser console `/admin` | Organisers | Laptop | PIN protected. Runs the schedule and every activity, prints cards and stickers, exports attendance. |
| Projector `/screen` | The room | Big screen | PIN protected. Read only. Shows live results, check-in codes, the leaderboard and reactions. |
| Stall counter `/stall` | Shopkeepers | Their phone or a tablet at the stall | Signed in with the stall's 6-digit code from the console. Scans attendee QRs (or the typed code) and hands things over. |

Branding: Recurse logo and credits on sign-in, app header, app icon and launch screen, notifications, the install prompt, printed cards and stickers, every projector scene and the console. The colour theme stays as designed.

## 2. In scope

### Sign-in and attendance
- Organisers generate **entry kits** in the console. Each kit is a card with a kit ID and a password. The QR on the card opens the app with the kit ID filled in; the password is only printed, never in the QR.
- Volunteers help each person sign in at the entry desk. **First sign-in is event attendance.**
- One kit works on one phone. An organiser can reset a kit if someone changes phones.
- Kits can be blank or printed with names from a pasted name/roll-number list.
- **Per-session check-in:** the projector shows a 4-character code that changes every 30 seconds, plus a QR. Attendees type or scan it. A forwarded code stops working within a minute.
- Manual check-in from the console for someone whose phone has died.
- CSV export of event attendance and per-session attendance.

### Now and next, alerts
- Live "happening now" card with a progress ring, a countdown to what's next, and the full timeline.
- Organisers can start, end, delay (+5, +10, +15 minutes), reorder, edit and add activities live. Phones update within 2 seconds.
- Push notifications 15 minutes before and at the start of each highlight. If an activity is delayed, its alert moves with it.
- Organiser announcements go out as a push and as an in-app banner. iPhones only get push after "Add to Home Screen", so the app explains how. The in-app banner reaches everyone.

### Polls and quiz
- Six types: single choice, multiple choice, this-or-that, rating, word cloud, and a timed quiz.
- A live poll takes over every phone's screen (collapsible to a pill). Results animate on the phone after voting and on the projector live.
- Quiz: server-timed countdown, points for correct answers with a speed bonus. Answers and points are held until the reveal.
- Word cloud has a profanity filter (English, Hindi and Telugu romanised), and organisers can hide a word live.

### Trails: treasure hunt and Morse trail (online + offline)
Both run on one flexible trail engine, so organisers can reshape them from the console on the day without code changes.

- A **trail** is a sequence of stops with its own title, open/close state, points and stickers.
  - Order is either shuffled per person with the same finale (spreads the crowd) or a fixed sequence.
  - Hints and wrong-answer cooldowns can be switched on or off per trail.
  - Organisers can create extra trails.
- Each **stop** has a challenge type:

  | Type | What the attendee does |
  |---|---|
  | Riddle | Reads a clue and types the answer. |
  | Scan | Finds the sticker or object and scans its QR. |
  | Morse | Finds a physical object with a Morse message on it, decodes it with the in-app Morse chart, and types the word. |

- Optional per stop:
  - **Must scan first:** the attendee must scan the object's QR before the answer box unlocks. This proves they found it rather than being told the word.
  - **Online fallback:** the phone plays or flashes the Morse itself, for a stop with no physical object or for remote play.
- Up to 2 hints per stop, each costing points. Escalating cooldown on wrong answers.
- Bonuses for finish order and speed. The first finishers are announced on the projector.
- Console prints **QR stickers** and **Morse cards**: large dots and dashes to stick on objects, with an optional small QR.

### Online Morse challenge
- Practice mode with a tappable Morse chart.
- **Decode** rounds: the phone beeps, flashes and vibrates a word, and you type it. It is fully playable with sound off.
- **Encode** rounds: tap a word on a telegraph key. Timing is judged against the player's own rhythm, so a slow but steady tapper passes.
- Five levels that get longer and faster, plus organiser-run **speed rounds** with a live top 5 and a podium.

### Arcade
- Three games under a minute each:
  - **Lag Spike:** reaction time.
  - **Base Rush:** binary, decimal and hex conversion.
  - **Echo:** memory pattern.
- Arcade points are capped at 60 per person for the day, so it can't outweigh the main activities.

### Points, leaderboard, stickers, reactions
- Every check-in, vote, quiz answer, trail stop, Morse level and arcade run feeds one points total. Each thing pays once.
- Leaderboard: top list plus "you are #N, X points behind <name>", reshuffling live.
- The organiser can freeze the leaderboard and run a dramatic **top-10 countdown reveal** on the projector to close the day.
- Sticker book that fills as people play.
- Emoji reaction bar: taps float on the phone and rain on the projector.

### Stalls and mocktails
- Every participant starts with **2 free mocktails** (an allowance set in the console). Points earned buy more; the home card shows the progress to the next one.
- **2 stalls**: the mocktail bar and one food and merch stall. Each has a menu set in the console: items, points price, stock, per-person limit, optional photo, or a pasted CSV. A fresh database starts with the mocktail bar (mocktail: free allowance first, then 50 points, editable).
- The attendee shows a rotating QR (30 s, plus a typed code); the shopkeeper at `/stall` signs in with the stall's 6-digit code, scans it, and hands it over with one tap. The phone celebrates; receipts are in the wallet.
- Spending never lowers the leaderboard. A console switch "spending lowers the leaderboard" exists, off, and is not wired.
- Atomic and idempotent: two stalls can never exceed the allowance, stock or a balance. Organisers can void a hand-over and export a transactions CSV.
- Puzzle-hour mocktail tokens are shown read-only; staff claim them in the arcade console.

### Flash drops, live feed, hype, streaks
- Drops fired or scheduled from the console take over every phone and the projector (siren, 3-2-1, countdown): code drop (first N win), speed question, golden slip (hidden word or QR), and everyone wins (a room reaction goal). A ready-made library fires in two taps.
- A live feed on the home screen and as a projector ticker, nicknames only, coalesced and capped; organisers can mute it, hide a line or post one.
- A hype meter on the projector, optionally firing an everyone-wins drop at max, and a personal streak chip on home.

### Recap and sticker book
- After the closing reveal, or when the console opens it: an Instagram-story recap on every phone (arrival, check-ins, quiz, trail path, Morse, arcade, stickers, final rank, top moment, "after hours personality") with a 1080x1920 share image.
- The projector shows the room's recap; the console previews anyone's.
- The sticker book is a flippable tome (enamel pins on parchment leaves) with a page per category, completion, rarity ("only N% have this"), hints on locked stickers and tap to slap.

### Fair play and safety
- All scoring is decided on the server. Answers, future clues and quiz solutions never reach phones early.
- Everything that can be spammed is rate-limited.
- Passwords are stored hashed. Attendee text shown on the projector is filtered and escaped.

### Hosting
- Docker on a DigitalOcean droplet with automatic HTTPS. HTTPS is required for push notifications and the camera.
- Sized for the **60-70 people** on the day; load-tested for **300 phones at once** as headroom. Drop winners, room goals and the hype meter scale to the people signed in.

## 3. Out of scope

- Team play. The hunt and every activity are individual.
- Registration or ticketing before the event. Entry is by printed kit only.
- Native App Store or Play Store apps. It is an installable web app (PWA).
- Email or SMS messages. Notifications are push and in-app only.
- Working without internet. The app needs Wi-Fi or mobile data; it rides out short drops by polling.
- Multiple events or days in one install. One event, one database.
- Prizes or real-money payments (stalls use points only), or any personal data beyond name, roll number and nickname.

## 4. Roles

| Role | Before the event | On the day |
|---|---|---|
| Event lead | Final run of show, content sign-off, go/no-go on Friday | Calls delays and announcements |
| Content owners | Poll and quiz questions, hunt clues, Morse words, stop locations | Help organisers adjust trails live |
| Console operator | Learns the console in the Friday dry run | Starts and ends activities, launches polls, opens check-ins, runs the reveal |
| Entry desk (2–3 volunteers) | Cut and sort kit cards | Hand out kits, help sign-ins, reset kits for phone swaps |
| Trail marshals | Place stickers and Morse cards around the venue | Watch the trails, replace a damaged sticker, nudge stuck players |
| Projector operator | Tests the projector laptop and browser | Keeps `/screen` up, pins a scene when asked |
| Tech on-call | Deploys and rehearses | Watches the server and fixes problems |

## 5. Action plan

| Day | Build | Team actions | Status |
|---|---|---|---|
| Mon 16 Nov | Spec. Foundation: sign-in, live updates, points, UI kit. | | Done |
| Tue 17 Nov | Foundation screens and look. Server rules and tests for every feature (376 tests passing together). | | Done |
| Wed 18 Nov | Every feature merged and given working screens (full outline commit). Mobile-app shell, Recurse branding, hybrid trails. | Start drafting real content (section 6) | Done |
| Thu 19 Nov | Polish pass: the rich interactions. Morse slips and the camera scanner. Arcade puzzle hour. Full-app checks: 300-phone bot run, Docker build. | **Real content and server access needed today** | Done (droplet deploy: tech on-call) |
| Fri 20 Nov | Stalls and mocktails, flash drops and the live feed, recap and sticker book. Full suite, 300-phone run, Docker build. Load real content. | **Organiser dry run on real phones** (Android and iPhone). Print kit cards, QR stickers, Morse cards and golden slips. Set stall menus. Go/no-go. | Built and tested |
| Sat 21 Nov | Tech on call. | **After Hours.** Run sheet in section 8. | Event day |

## 6. What the team needs to provide

| Item | Detail | Needed by |
|---|---|---|
| Run of show | Every activity with start/end time, location, and which are highlights | Thu 19 Nov |
| Poll and quiz questions | The polls to run; quiz questions with the correct answer | Thu 19 Nov |
| Treasure hunt | Stop locations, a clue per stop, the answer(s), two hints each, which stops need a scan | Thu 19 Nov |
| Morse trail | The objects to use, the word on each, where they go, which stops need a scan or an online fallback | Thu 19 Nov |
| Attendee list (optional) | Name and roll number, to print named kit cards. Blank cards work otherwise. | Fri 20 Nov |
| Server access | Droplet IP and SSH login; the web address to use (for example afterhours.recursekmit.in) and access to its DNS | Thu 19 Nov |
| Crew | Names for each role in section 4 | Fri 20 Nov |

## 7. Physical prep checklist (Friday)

- [ ] About **80 kit cards** printed (the 60-70 headcount plus spares), cut, and sorted by kit ID.
- [ ] Hunt QR stickers printed; each one has its printed backup code.
- [ ] Morse cards printed and attached to their objects. Each card read back with the in-app chart to confirm it decodes to the right word.
- [ ] Stickers and objects placed. Every stop scanned once with a test phone.
- [ ] Projector laptop: browser signed in to `/screen`, display sleep off, sound on for reactions.
- [ ] Console laptop: signed in to `/admin`, charger plugged in.
- [ ] Venue Wi-Fi tested with 10+ phones. Mobile data works as a fallback.
- [ ] Entry desk: kit cards, a printed one-page "how to sign in", a phone charger strip.
- [ ] Test announcement and test push sent to organiser phones.

## 8. Event-day run sheet (actions, not the schedule)

| When | Action | Who |
|---|---|---|
| T-90 min | Server health check; organiser phones sign in; projector on the join scene | Tech on-call, projector operator |
| T-60 min | Reset demo data, load the real run of show; trails open or closed as planned | Console operator |
| T-30 min | Entry desk set up; first kits handed out as people arrive | Entry desk |
| Doors | Sign-ins; install prompt and alerts opt-in on every phone | Entry desk |
| Each session | Start it on the console; open check-in; projector shows the code | Console operator |
| Poll segments | Launch, close and reveal from the console; projector takes over automatically | Console operator |
| Trails open | Open the trail; marshals in place; projector crowd map | Console operator, marshals |
| Delays | Use +5, +10 or +15 on the console; everyone's phone and alerts update | Event lead, console operator |
| Breaks | Stalls open; shopkeepers on `/stall`; fire a flash drop from the library to wake the room | Console operator, shopkeepers |
| Before the close | Freeze the leaderboard | Console operator |
| Close | Run the top-10 reveal on the projector; recaps open on every phone when it finishes | Console operator, event lead |
| After | Export attendance CSVs; keep the database backup | Tech on-call |

## 9. Risks and what we do about them

| Risk | Mitigation |
|---|---|
| Venue Wi-Fi can't handle the crowd | Light pages and live updates; automatic fallback to polling; mobile data works. Test on Friday. |
| iPhones don't get push notifications | In-app banners reach everyone. Install prompt explains Add to Home Screen. |
| Someone loses their card or changes phone | Console kit reset; spare blank kits at the desk |
| A QR sticker or Morse card goes missing | Every stop has a typed code or answer; console can rotate a sticker's code; marshals carry spares |
| Camera blocked or no in-app scanner (iPhone) | QRs are plain links, so the phone's camera app opens them; typed code always works |
| Cheating with developer tools or scripts | Server decides all scoring; answers never sent early; rate limits; arcade points capped |
| Server problem on the day | Rehearsed deploy; health check; database backup; tech on call |
| Build time runs out | Built breadth-first: every feature works in outline before polish, so nothing is missing, only less animated |

## 10. Definition of done

- All features usable end to end on Android Chrome and iPhone Safari, at 360px and 390px widths.
- `npm run check` passes (typecheck, lint, all tests, build). The browser test suite passes.
- A 300-attendee simulated run against the deployed server completes with no errors.
- Organisers complete the Friday dry run using only the console.
- Real content loaded; kit cards, stickers and Morse cards printed and placed.

## 11. Open decisions

- Real run of show and highlight activities.
- Which trail stops need a scan first, and whether the Morse trail has online fallbacks for remote players.
- Domain name and droplet access.
- Whether kit cards are named or blank.
