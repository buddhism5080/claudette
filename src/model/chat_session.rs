use serde::Serialize;

use crate::model::workspace::AgentStatus;

#[derive(Debug, Clone, PartialEq, Serialize)]
pub enum SessionStatus {
    Active,
    Archived,
}

impl SessionStatus {
    pub fn as_str(&self) -> &str {
        match self {
            Self::Active => "active",
            Self::Archived => "archived",
        }
    }
}

/// Returned when a string doesn't correspond to any known [`SessionStatus`].
/// Surfacing the unknown value (instead of silently coercing) lets callers
/// detect corrupted DB rows or values written by a forward-version of the app.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParseSessionStatusError(pub String);

impl std::fmt::Display for ParseSessionStatusError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "unknown SessionStatus value: {:?}", self.0)
    }
}

impl std::error::Error for ParseSessionStatusError {}

impl std::str::FromStr for SessionStatus {
    type Err = ParseSessionStatusError;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "active" => Ok(Self::Active),
            "archived" => Ok(Self::Archived),
            other => Err(ParseSessionStatusError(other.to_string())),
        }
    }
}

/// Kind of input the agent is waiting for. Mirrors `AttentionKind` in
/// `src-tauri/src/state.rs` but as an owned string so the lib crate stays
/// free of Tauri deps.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub enum AttentionKind {
    Ask,
    Plan,
}

impl AttentionKind {
    pub fn as_str(&self) -> &str {
        match self {
            Self::Ask => "ask",
            Self::Plan => "plan",
        }
    }
}

/// Maximum length of a session name in characters. Matches the cap the
/// Haiku auto-namer applies so user-entered names and auto-generated names
/// share the same bound.
pub const SESSION_NAME_MAX_CHARS: usize = 60;

/// Default tab title written when a chat session is created. The Haiku
/// auto-namer (and the local prompt fallback) replace this on the first
/// turn unless the user already renamed the tab.
pub const DEFAULT_SESSION_NAME: &str = "New chat";

/// `true` when the tab still has the placeholder title (or is blank).
pub fn is_placeholder_session_name(name: &str) -> bool {
    let trimmed = name.trim();
    trimmed.is_empty() || trimmed == DEFAULT_SESSION_NAME
}

/// Whether Claudette should still try to auto-name this tab.
///
/// Independent of `turn_count`: a first-turn abort used to consume the
/// one-shot (`turn_count` already 2 on retry) and leave the tab stuck on
/// `New chat` forever. Keep retrying until the user edits the name or a
/// generated title lands.
pub fn should_attempt_session_auto_name(name_edited: bool, name: &str) -> bool {
    !name_edited && is_placeholder_session_name(name)
}

/// Local fallback when Haiku is unavailable. Collapses whitespace and
/// caps at [`SESSION_NAME_MAX_CHARS`] so the tab is identifiable even if
/// the background `claude --print` naming call fails.
pub fn fallback_session_name(prompt: &str) -> String {
    let collapsed = prompt.split_whitespace().collect::<Vec<_>>().join(" ");
    if collapsed.is_empty() {
        return DEFAULT_SESSION_NAME.to_string();
    }
    collapsed.chars().take(SESSION_NAME_MAX_CHARS).collect()
}

/// Name to write when a placeholder tab receives its first prompt.
/// `None` means leave the current title alone (user already renamed, or
/// the tab is not a placeholder).
pub fn prompt_fallback_session_name(
    name_edited: bool,
    current_name: &str,
    prompt: &str,
) -> Option<String> {
    if !should_attempt_session_auto_name(name_edited, current_name) {
        return None;
    }
    let fallback = fallback_session_name(prompt);
    if fallback == current_name {
        return None;
    }
    Some(fallback)
}

/// Normalize a user-supplied session name. Trims surrounding whitespace,
/// rejects the empty string, and caps at `SESSION_NAME_MAX_CHARS`
/// characters (not bytes) so we can't split a multi-byte codepoint.
pub fn validate_session_name(name: &str) -> Result<String, &'static str> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err("Name cannot be empty");
    }
    Ok(trimmed.chars().take(SESSION_NAME_MAX_CHARS).collect())
}

/// A conversation within a workspace. Each session has its own Claude CLI
/// subprocess, its own message history, and its own checkpoint timeline.
/// A workspace always has at least one active session.
#[derive(Debug, Clone, Serialize)]
pub struct ChatSession {
    pub id: String,
    pub workspace_id: String,
    /// Claude CLI `--resume` UUID. `None` until the first turn completes.
    pub session_id: Option<String>,
    pub name: String,
    /// `true` once the user renames the session — Haiku auto-naming never
    /// overwrites a user-edited name.
    pub name_edited: bool,
    pub turn_count: u32,
    pub sort_order: i32,
    pub status: SessionStatus,
    pub created_at: String,
    pub archived_at: Option<String>,
    /// Redacted, shell-quoted `claude` invocation captured the first time
    /// the agent process spawns for this session. `None` for sessions that
    /// pre-date this feature, or whose first spawn raced with a write
    /// failure. UI renders a banner only when `Some`.
    pub cli_invocation: Option<String>,
    /// Runtime agent status — defaults to `Idle` when loaded from DB; the
    /// command layer overlays the live `AppState.agents` view on top.
    pub agent_status: AgentStatus,
    /// Runtime attention flag — defaults to `false` from DB.
    pub needs_attention: bool,
    /// Runtime attention kind — defaults to `None` from DB.
    pub attention_kind: Option<AttentionKind>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn placeholder_name_matches_default_and_blank() {
        assert!(is_placeholder_session_name("New chat"));
        assert!(is_placeholder_session_name("  New chat  "));
        assert!(is_placeholder_session_name(""));
        assert!(is_placeholder_session_name("   "));
        assert!(!is_placeholder_session_name("Auth flow refactor"));
    }

    #[test]
    fn auto_name_retries_placeholder_even_after_later_turns() {
        assert!(should_attempt_session_auto_name(false, "New chat"));
        assert!(!should_attempt_session_auto_name(true, "New chat"));
        assert!(!should_attempt_session_auto_name(
            false,
            "Auth flow refactor"
        ));
    }

    #[test]
    fn fallback_session_name_collapses_whitespace_and_caps() {
        assert_eq!(fallback_session_name("  look   this\nup  "), "look this up");
        assert_eq!(fallback_session_name("   \n"), DEFAULT_SESSION_NAME);
        let long = "x".repeat(SESSION_NAME_MAX_CHARS + 10);
        assert_eq!(
            fallback_session_name(&long).chars().count(),
            SESSION_NAME_MAX_CHARS
        );
    }

    #[test]
    fn prompt_fallback_renames_new_chat_from_first_prompt() {
        assert_eq!(
            prompt_fallback_session_name(false, "New chat", "fix the login timeout"),
            Some("fix the login timeout".into())
        );
    }

    #[test]
    fn prompt_fallback_skips_when_user_already_named_the_tab() {
        assert_eq!(
            prompt_fallback_session_name(true, "New chat", "fix the login timeout"),
            None
        );
        assert_eq!(
            prompt_fallback_session_name(false, "Auth flow", "fix the login timeout"),
            None
        );
    }
}
