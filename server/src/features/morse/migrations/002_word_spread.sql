-- pickWord spreads words over the room: "how often did this word go out at this level lately".
CREATE INDEX morse_rounds_level ON morse_rounds(level, issued_at);
