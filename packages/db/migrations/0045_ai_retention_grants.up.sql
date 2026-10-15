-- The assistant's retention sweep (docs/ai §12; ADR-0001 D7) removes a
-- conversation and its messages once the company's retention window has
-- passed, or once the member deleted it. Removal, not a tombstone: what a
-- member asked the assistant is theirs, and the promise is that it goes.
-- The app role could not delete from either table until now, so the sweep
-- counted conversations it could not remove.
grant delete on ai_conversations, ai_messages to integr8_app;
