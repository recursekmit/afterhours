# Morse slips: the offline + online challenge

The main event mechanic for the Morse challenge and the treasure hunt. This file is the contract between the people building the slip format and scanner, and the people building the trails engine. Change it only through the lead.

## Idea

Every entry kit contains a few small printed **slips**. Each slip carries Morse code. Attendees scan a slip with the app's camera, and what the app reads depends on **how the slip is held**. Turning the slip changes which Morse strip is "the one you're reading", so it changes the answer. Different answers lead to different things: the next stop, a branch to another place, a side clue, a bonus, or a decoy. Treasure hunt stops work the same way. Slips can also be stuck on objects around the venue, not only put in kits.

## The slip format

- A slip is a card (default 85 x 55 mm, business-card size; the generator can also print other sizes) with a heavy ink **frame**, a **finder mark** in each corner, and up to **four Morse strips**, one along each inside edge.
  - The finder marks are identical, so the slip has no "right way up".
  - Each strip is printed upright as seen from its own edge: the bottom strip reads normally, and the top strip is printed upside down.
- A strip is a row of **dots** (filled circles) and **dashes** (filled capsules, at least 3x as long as a dot is wide) on a light background.
  - The gap between symbols within a letter is 1 unit; between letters, 3 units; between words, 7 units, with a unit roughly equal to a dot's diameter.
  - Ink is high contrast and nothing else is printed inside the strip bands.
- **Reading rule:** the active strip is the **horizontal strip nearest the bottom of the camera view**, read left to right. Rotating the slip 90° puts a different edge at the bottom, so you read a different strip.
  - The strip at the top of the view is upside down. Read naively, it comes out as its symbol sequence reversed. The scanner reports it too, so organisers can plant deliberate "upside-down" readings as decoys or secrets.
- A slip may use one to four strips. Empty edges are simply blank.
- Small print outside the strip bands is allowed: the Recurse mark, a slip number, and optionally a kit ID. The scanner ignores anything that isn't in a strip band.
- The words are authored per orientation in the console: bottom, right, top, left (which edge is at the bottom when read). The generator renders the strips from the words using the shared Morse table (`shared/src/features/morse.ts`).

## Scanner output (web, `shared/src/morse-slip.ts` types)

```ts
type Symbol = '.' | '-';
interface StripReading {
  morse: string;        // letters separated by ' ', words by ' / ', e.g. "-.-. --- -.. ."
  text: string | null;  // decoded with the shared table; null if any letter is invalid
  confidence: number;   // 0..1
  position: 'bottom' | 'top' | 'other';
}
interface SlipScan {
  primary: StripReading | null;   // the bottom strip, per the reading rule
  others: StripReading[];         // every other strip found (top strip as seen, i.e. reversed)
  at: number;                     // performance.now() of the frame
}
```

The scanner runs entirely on the phone (camera frames into a canvas, no upload). It only reports a result once the same `primary` has been read in several consecutive frames. The phone sends `primary.text`, or `primary.morse` when text is null, to the server. Typing the decoded word by hand is always available as a fallback.

## Server side (trails engine)

- A slip is defined in the console with up to four orientation readings. Each reading maps to an **outcome**:
  - `next`: advance to a given stop;
  - `branch`: jump to a stop or unlock another trail;
  - `clue`: show a text or image clue without moving;
  - `bonus`: award points once;
  - `decoy`: a playful "nope, try another angle" message, with no penalty.
- An orientation with no reading set gives a friendly "nothing there, try turning it" response.
- Unknown sequences get the same friendly response, and never reveal what the valid readings are.
- Trails can be linear (as today) or a **graph**: a stop's outcomes can point to different next stops, so different orientations send people down different paths.
- Slips can be **shared** (the same slips in every kit), **per-kit** (each kit's slip words come from a pool, and the server knows which words belong to which kit) or **unique** (below: every printed copy has its own words and belongs to whoever scans it first).
- Readings are matched on the normalised Morse sequence (exact), and also on the decoded text for typed fallbacks.
- Scoring, cooldowns and "pays once" rules follow the existing trail rules.

## Ticket slips (default for kit slips)

Kit slips print as one of the four engraved after hours tickets (the owner's art: `design/tickets/`, cropped by `node scripts/tickets.mjs` into `web/src/assets/tickets/`): **armillary** (maroon), **wave** (navy), **ginkgo** (forest) and **ruins** (plum). A set can print all as one design, or "mixed" (slip N gets design N mod 4).

- **Size:** `SLIP_SIZES.ticket`, 176 x 80 mm (2.2 : 1). The short edges carry 56 mm of band: 3+ letters at full dot size. A4 holds 3 per page with crop marks; the cut line has a concave 3 mm notch at each corner (`TICKET_NOTCH_MM`), drawn as a dashed line, clear of the frame.
- **Geometry is unchanged:** the same `SLIP_SPEC` ratios and `layoutSlip`, so the scanner needs no ticket mode. From the cut edge in:
  - cream quiet margin (`#f3e8cc`);
  - the dark ink frame, in the ticket's ground colour;
  - a cream **ribbon** with the four finder bullseyes (exact geometry, they read as the ticket's corner rosettes) and the four Morse bands, dark ink, nothing else;
  - the engraved panel: the art (only here, never in a band or its 1.2 mm quiet gap), a gold double rule with corner stars, the art's own **plaque** ("AFTER HOURS" and "no. 07", kit id when per kit), the vertical **star divider**, and the **square frame** with the Recurse mark, a small QR (`square: 'qr'`, `qr`) or the "turn me" glyph (`square: 'glyph'`).
- **Polarity:** dark symbols on the cream ribbon. Luminance contrast is 13.7 : 1 (`#131d37` on `#f3e8cc`) against 9.9 : 1 for gold `#e3c48a` on navy, and it is the dark-on-light the threshold, components and finder checks already expect. Gold-on-dark would need a polarity pass and would put the engraved gold line art (same colour as the symbols) next to the bands.
- **Camera:** the scanner asks for 1920 x 1080 (was 1280 x 720), so a whole 176 mm ticket in a portrait frame still gets 4-5 px/mm.
- **Proof:** `web/src/lib/slips/scanner/tickets.test.ts` reads the real renderer's print of each design (`fixtures/ticket-*.png`) through the synthetic camera: 4 designs x 4 turns x 12 conditions (tilt, perspective, blur, motion, noise, dim, low contrast, gradient and shadow, dark table, everything at once). Result on 20 Nov: **372 / 384 correct (96.9 %), 0 wrong**, misses only under strong perspective (no frame found, never a wrong word); the 45 degree zone gave **0 readings in 32 frames**. The fake-camera e2e (`e2e/trails-camera.spec.ts`) scans the armillary kit ticket.
- Choose the design in the console (trails, slips, "print slips as") or on `/dev/slips` (`?size=ticket&ticket=wave&square=qr`).

## Unique slips (default for kit slips)

Every student decodes different Morse. A unique set prints **N copies** of every slip (default 80, `UNIQUE_SLIP_COPIES`), and every copy carries **its own word on every edge**. What each orientation *does* (next, branch, clue, bonus, decoy and their targets) is still defined once per slip, so the trail is the same for everyone. Kits are packed first come, first served and registered students sign in with their student ID, so a copy is not tied to a kit or a person in advance: **the first person whose reading matches a copy claims it.**

- **Data** (`server/src/features/hunt/migrations/004_unique_slips.sql`): `hunt_slip_sets.mode = 'unique'` and `copies`; `hunt_slip_copies` (slip, serial 1..N, `claimed_by`, `claimed_at`; unique index on (slip, claimed_by)); `hunt_slip_copy_words` (copy, reading, word, Morse key; the key is unique across every unique copy). Readings with no word are generated per copy; an `extra` with no sequence is that copy's top strip read upside down.
- **Words** (`server/src/features/hunt/slipwords.ts`), for every word handed out:
  1. unique across every copy and edge (and every other unique set);
  2. at least two symbol edits from every other word on copies of the same slip, so a misread lands on "nothing there", never on someone else's copy;
  3. never the upside-down reversal of a word in use, never its own reversal (top-strip decoys stay unambiguous);
  4. fits its edge on the 176 x 80 ticket with dots of at least 1.6 mm (short edges: 34 units, about 3 letters; long edges: 45 units, about 4) and on the plain 85 x 55 card (`edgeCapacity`);
  5. not on the polls profanity list (read only) or the slip blocklist, nor is the text its upside-down strip spells.
  Order of preference: real short tech words (BIT, GPU, NODE, CACHE...), pronounceable codes (CVC on short edges, CVCV on long ones), then letter+digit codes.
- **Claiming** (`unique.ts`, `submitSlip`): a reading at a slip stop is looked up across every copy of that slip. Unclaimed: claimed atomically (one conditional UPDATE, backed by the unique index), then the outcome applies. Claimed by you: works. Claimed by someone else: `outcome: 'taken'`, "this slip belongs to someone else. scan your own.", nothing happens. You already hold another copy of this slip: `taken`, "yours is no. 037". Unknown: the usual "nothing there". Refusals count against the same scan rate limit as misses. Slips 1, 2, 3 are claimed independently. A trail reset frees every copy.
- **Printing**: copies in serial order, slips 1..n of one serial together, 3 tickets per A4, crop marks; the plaque reads "no. 037, slip 2". For 80 kits of the 3-slip trail that is 80 pages (240 tickets); the 1-slip hunt set is 27 pages. A serial range can be printed on its own.
- **Console** (trail, "slips"): "copies" opens the copies table (serial; per slip: claimed by, at, **release**), the copy count (grow any time, shrink only past unclaimed serials, "new words for all" only while nothing is claimed), a warning when fewer copies than people signed in, "print set" / a serial range, and the private **answer key CSV** (serial -> words). A shared set nobody has scanned yet has "switch to unique copies".
- **API**: `GET|POST /api/hunt/admin/slip-sets/:id/copies` (`{ copies, regenerate? }`), `PUT /api/hunt/admin/slip-sets/:id/mode` (`{ mode: 'unique', copies }`), `POST /api/hunt/admin/slip-copies/:id/release`, `GET /api/hunt/admin/slip-sets/:id/answer-key.csv`. `slip-print` items carry `serial`; `HuntSlipResult` carries `serial`; the current stop's `slip` says `unique` and your `serial`.
- **Proof**: `server/src/features/hunt/unique.test.ts` (generator at 80 and 120 copies, claiming, the race, release, every orientation, typed vs scanned, migration); `web/src/lib/slips/scanner/unique.test.ts` reads 12 generated copies as tickets under 8 hall conditions: 383 / 384 correct, 0 wrong, nothing in the 45 degree zone; `e2e/unique-slips.spec.ts` scans two printed copies on two phones with the fake camera.

## Physical Morse cards: K of M stops

Cards stuck on venue objects cannot differ per student. A shuffled or fixed trail can instead give each player **K of its M stops before the finale** (console, trail settings, "each player gets"; `subsetK`, off by default). The K are picked per attendee from the trail's seed (the same hash as the shuffled order), so neighbours walk different objects; everyone ends at the shared finale.
