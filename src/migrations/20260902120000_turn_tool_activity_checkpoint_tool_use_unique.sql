-- Completed tools persist as they finish, not only at turn-end checkpoint
-- dump. The same (checkpoint, tool_use) pair can be written from the
-- stream (tool_result) and again from the webview dump — keep one row.
DELETE FROM turn_tool_activities
 WHERE rowid NOT IN (
     SELECT MIN(rowid)
       FROM turn_tool_activities
      GROUP BY checkpoint_id, tool_use_id
 );

CREATE UNIQUE INDEX IF NOT EXISTS idx_turn_tool_activities_checkpoint_tool_use
    ON turn_tool_activities(checkpoint_id, tool_use_id);
