-- Byte length of the Claude CLI JSONL at checkpoint time, plus the
-- session id that file belonged to. Rollback copies that prefix onto a
-- new sid instead of seeding a migration prelude.
ALTER TABLE conversation_checkpoints ADD COLUMN jsonl_byte_len INTEGER;
ALTER TABLE conversation_checkpoints ADD COLUMN jsonl_session_id TEXT;
