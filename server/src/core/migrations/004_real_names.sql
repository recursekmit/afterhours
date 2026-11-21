-- Their own names, no usernames (event day, 2026-11-21): everyone signed in from the participant list is
-- shown by their registered name. Brings anyone who already picked a nickname in line.
UPDATE attendees
   SET nickname = (SELECT TRIM(k.preset_name) FROM kits k WHERE k.id = attendees.kit_id),
       name = (SELECT TRIM(k.preset_name) FROM kits k WHERE k.id = attendees.kit_id)
 WHERE COALESCE((SELECT TRIM(k.preset_name) FROM kits k WHERE k.id = attendees.kit_id), '') != '';
