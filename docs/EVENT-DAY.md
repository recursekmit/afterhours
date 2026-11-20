# Event day: operator cheat sheet

Saturday 21 November 2026. Console at `/admin` (laptop, `ADMIN_PIN`), projector at `/screen` (`SCREEN_PIN`), shopkeepers at `/stall`. Everything below is a panel in the console's left menu.

## Before doors (T-90 to T-30)

1. **Health.** `curl https://<domain>/api/health` returns ok. Take a database backup (README, "Deploy").
2. **Wipe the dry run.** In each panel's danger zone, as needed: stalls ("RESET STALLS": purchases only, menus stay), drops ("reset drops"), arcade, run of show.
3. **run of show.** Load the real schedule. Mark the highlights.
4. **polls, hunt.** Real polls and quiz loaded; trails closed until their slot.
5. **stalls.**
   - "free mocktails per person": 2.
   - The **mocktail bar** already exists with "mocktail" (free allowance first, then 50 points). Change its price in the pts cell if the team decides.
   - Add the food and merch stalls: type items, or paste a CSV (`stall,item,price,stock,limit[,free]`). Click a thumbnail to add a photo.
   - Give each shopkeeper their stall's **6-digit code**. They open `/stall` on their phone, type it, and leave the page open (it keeps the screen awake).
   - Leave "spending lowers the leaderboard" **off**.
6. **drops.** Check "feed on" and "hype meter" are ticked. Print the golden slip's QR from the drop's "slip QR" button if you plan one, and hide it.
7. **projector.** `/screen` signed in, display sleep off, sound on. No pinned scene.

## Doors

8. **kits.** Hand out kit cards. Sign-in is attendance. Help with the avatar; suggest "add to home screen" and alerts.

## During the afternoon

9. **run of show.** Start each activity when it starts; +5/+10/+15 when it runs late.
10. **check-in.** Open check-in for the session. The projector shows the code; people type it.
11. **polls.** Launch, then close, then reveal. The projector takes over by itself.
12. **hunt.** Open a trail at its slot. Marshals at the stops.
13. **drops.** Between segments, open "drop library" and press **fire** (or "in 5 min" to tease phones). One drop at a time. "cancel it" stops a live one; points already won stay. Post a feed line with "say something in the feed"; "hide" removes a bad line.
14. **stalls and the mocktail bar.** Nothing to click while it runs. Watch "hand-overs" in the stalls panel. Shopkeeper flow: scan the attendee's QR (or type their 6-character code), check the big "free mocktails left", tap items, **hand it over**, next person.
15. **announce.** Banners and push for anything urgent.

## Closing

16. **leaderboard.** Freeze, then run the top-10 reveal on the projector.
17. **recap.** Opens on every phone by itself when the reveal finishes. "open recaps now" opens it early; pin "room recap" on the projector for the room's totals.
18. **After.** Export the attendance CSVs (check-in, kits) and the stall CSV (stalls, "export CSV"). Back up the database.

## Volunteer answers

| Problem | Fix |
|---|---|
| **Lost or broken phone** | kits: find their kit, "reset", "reset, same password". They sign in on the new phone with the same card. Points, stickers, free mocktails and receipts stay with them. |
| **Lost the kit card** | kits: find them by name, "reset with a new password", read it out once. |
| **"My kit is already in use"** | The kit is bound to another phone. Reset it (above). |
| **Camera denied or no scanner** | Every scan has a typed fallback: check-in code, trail answers and stop codes, slip words. At a stall, the attendee reads the 6-character code under their QR and the shopkeeper types it. Or the shopkeeper's own phone camera app opens the QR link straight into `/stall`. |
| **Refund or wrong item at a stall** | stalls: "hand-overs", search the kit or nickname, **void**. Points, the free mocktail and stock come back; their phone says so. Then hand over the right thing. |
| **"It says no free mocktails left"** | They used both. A mocktail now costs its points price; the home card shows how many points to the next one. Puzzle-hour tokens are claimed at the arcade desk (arcade panel). |
| **Shopkeeper signed out or wrong stall** | Give them the code again. "rotate" a stall's code if it leaked; everyone on the old code is signed out. |
| **QR "expired"** | It changes every 30 s on purpose. Ask them to keep the QR screen open and scan again. |
| **Drop stuck on phones** | drops: "cancel it". Phones tuck it away after the reveal; the close button hides it any time. |
| **Projector frozen on a scene** | projector panel: unpin. Reload `/screen` if needed. |
| **Someone's phone died mid-session** | check-in: "check in" next to their name for a manual check-in. |
