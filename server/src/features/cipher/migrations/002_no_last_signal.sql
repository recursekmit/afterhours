-- The last signal (trial 7) is switched off: sealing the pact completes the cipher. Anyone already
-- waiting on trial 7 has sealed all six played trials, so they are done.
UPDATE cipher_players SET trial = 8 WHERE trial = 7;
