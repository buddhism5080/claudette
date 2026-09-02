-- Tools hang on the turn-start user message, not the restore checkpoint.
-- Steer bubbles hang on that same user via parent_message_id and are not
-- their own rollback targets.
ALTER TABLE chat_messages ADD COLUMN parent_message_id TEXT
    REFERENCES chat_messages(id) ON DELETE SET NULL;

CREATE TABLE turn_tool_activities_v2 (
    id TEXT PRIMARY KEY,
    checkpoint_id TEXT REFERENCES conversation_checkpoints(id) ON DELETE SET NULL,
    user_message_id TEXT NOT NULL REFERENCES chat_messages(id) ON DELETE CASCADE,
    tool_use_id TEXT NOT NULL,
    tool_name TEXT NOT NULL,
    input_json TEXT NOT NULL DEFAULT '',
    result_text TEXT NOT NULL DEFAULT '',
    summary TEXT NOT NULL DEFAULT '',
    sort_order INTEGER NOT NULL DEFAULT 0,
    assistant_message_ordinal INTEGER NOT NULL DEFAULT 0,
    agent_task_id TEXT,
    agent_description TEXT,
    agent_last_tool_name TEXT,
    agent_tool_use_count INTEGER,
    agent_status TEXT,
    agent_tool_calls_json TEXT NOT NULL DEFAULT '[]',
    agent_thinking_blocks_json TEXT NOT NULL DEFAULT '[]',
    agent_result_text TEXT,
    workflow_progress_json TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL DEFAULT 'ok'
);

INSERT INTO turn_tool_activities_v2 (
    id, checkpoint_id, user_message_id, tool_use_id, tool_name,
    input_json, result_text, summary, sort_order, assistant_message_ordinal,
    agent_task_id, agent_description, agent_last_tool_name,
    agent_tool_use_count, agent_status, agent_tool_calls_json,
    agent_thinking_blocks_json, agent_result_text, workflow_progress_json,
    status
)
SELECT
    ta.id,
    ta.checkpoint_id,
    (
        SELECT m.id
          FROM chat_messages m
          JOIN conversation_checkpoints cp ON cp.id = ta.checkpoint_id
          JOIN chat_messages anchor ON anchor.id = cp.message_id
         WHERE m.chat_session_id = cp.chat_session_id
           AND m.role = 'user'
           AND (m.created_at, m.rowid) <= (anchor.created_at, anchor.rowid)
         ORDER BY m.created_at DESC, m.rowid DESC
         LIMIT 1
    ),
    ta.tool_use_id,
    ta.tool_name,
    ta.input_json,
    ta.result_text,
    ta.summary,
    ta.sort_order,
    ta.assistant_message_ordinal,
    ta.agent_task_id,
    ta.agent_description,
    ta.agent_last_tool_name,
    ta.agent_tool_use_count,
    ta.agent_status,
    ta.agent_tool_calls_json,
    ta.agent_thinking_blocks_json,
    ta.agent_result_text,
    ta.workflow_progress_json,
    CASE WHEN TRIM(ta.result_text) = '' THEN 'running' ELSE 'ok' END
  FROM turn_tool_activities ta
 WHERE (
        SELECT m.id
          FROM chat_messages m
          JOIN conversation_checkpoints cp ON cp.id = ta.checkpoint_id
          JOIN chat_messages anchor ON anchor.id = cp.message_id
         WHERE m.chat_session_id = cp.chat_session_id
           AND m.role = 'user'
           AND (m.created_at, m.rowid) <= (anchor.created_at, anchor.rowid)
         ORDER BY m.created_at DESC, m.rowid DESC
         LIMIT 1
       ) IS NOT NULL;

DROP TABLE turn_tool_activities;
ALTER TABLE turn_tool_activities_v2 RENAME TO turn_tool_activities;

CREATE UNIQUE INDEX idx_turn_tool_activities_user_tool
    ON turn_tool_activities(user_message_id, tool_use_id);
CREATE INDEX idx_turn_tool_activities_checkpoint
    ON turn_tool_activities(checkpoint_id, sort_order);
CREATE INDEX idx_chat_messages_parent
    ON chat_messages(parent_message_id);
