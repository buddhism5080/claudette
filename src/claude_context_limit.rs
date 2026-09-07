//! Context-window cap for the chat meter.
//!
//! Claude Code stores the override in `settings.json` under `env`
//! (`CLAUDE_CODE_CONTEXT_LIMIT` or `CLAUDE_CODE_MAX_CONTEXT_TOKENS`).
//! Claudette's process environment does not inherit that block, so the
//! meter must read the files itself. Settings win over a matching shell
//! variable, matching Claude Code.

use serde_json::Value;
use std::path::{Path, PathBuf};

const CONTEXT_LIMIT_KEY: &str = "CLAUDE_CODE_CONTEXT_LIMIT";
const MAX_CONTEXT_TOKENS_KEY: &str = "CLAUDE_CODE_MAX_CONTEXT_TOKENS";

/// Parse a positive token count. Accepts plain digits, `_` separators, and
/// scientific notation (`1e6`).
pub fn parse_positive_token_count(raw: &str) -> Option<u64> {
    let s = raw.trim().replace('_', "");
    if s.is_empty() {
        return None;
    }
    if let Ok(n) = s.parse::<u64>() {
        return (n > 0).then_some(n);
    }
    let f: f64 = s.parse().ok()?;
    if !f.is_finite() || f <= 0.0 || f != f.trunc() || f > u64::MAX as f64 {
        return None;
    }
    Some(f as u64)
}

pub fn parse_context_limit_from_vars(
    context_limit: Option<&str>,
    max_context_tokens: Option<&str>,
) -> Option<u64> {
    context_limit
        .and_then(parse_positive_token_count)
        .or_else(|| max_context_tokens.and_then(parse_positive_token_count))
}

fn json_to_limit(value: &Value) -> Option<u64> {
    match value {
        Value::String(s) => parse_positive_token_count(s),
        Value::Number(n) => n
            .as_u64()
            .or_else(|| {
                n.as_f64().and_then(|f| {
                    if f.is_finite() && f > 0.0 && f == f.trunc() && f <= u64::MAX as f64 {
                        Some(f as u64)
                    } else {
                        None
                    }
                })
            })
            .filter(|n| *n > 0),
        _ => None,
    }
}

fn settings_env_value<'a>(doc: &'a Value, key: &str) -> Option<&'a Value> {
    doc.get("env")
        .and_then(Value::as_object)
        .and_then(|env| env.get(key))
        .or_else(|| doc.get(key))
}

/// Token cap from one settings.json document (`env` block, then top-level).
pub fn context_limit_from_settings_doc(doc: &Value) -> Option<u64> {
    settings_env_value(doc, CONTEXT_LIMIT_KEY)
        .and_then(json_to_limit)
        .or_else(|| settings_env_value(doc, MAX_CONTEXT_TOKENS_KEY).and_then(json_to_limit))
}

/// Settings-file value wins over the process environment, same as Claude Code.
pub fn resolve_context_limit_tokens(
    process_context_limit: Option<&str>,
    process_max_context: Option<&str>,
    settings_limit: Option<u64>,
) -> Option<u64> {
    settings_limit
        .or_else(|| parse_context_limit_from_vars(process_context_limit, process_max_context))
}

pub fn claude_config_dir() -> Option<PathBuf> {
    if let Some(dir) = std::env::var_os("CLAUDE_CONFIG_DIR") {
        return Some(PathBuf::from(dir));
    }
    dirs::home_dir().map(|home| home.join(".claude"))
}

fn read_json_value(path: &Path) -> Value {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|contents| serde_json::from_str(&contents).ok())
        .unwrap_or(Value::Object(Default::default()))
}

/// Merge Claude Code settings like the CLI: local > project > user.
pub fn load_context_limit_from_claude_settings(repo_path: Option<&Path>) -> Option<u64> {
    let user = claude_config_dir()
        .map(|home| read_json_value(&home.join("settings.json")))
        .unwrap_or(Value::Object(Default::default()));
    let project = repo_path.map(|repo| read_json_value(&repo.join(".claude/settings.json")));
    let local = repo_path.map(|repo| read_json_value(&repo.join(".claude/settings.local.json")));
    local
        .as_ref()
        .and_then(context_limit_from_settings_doc)
        .or_else(|| project.as_ref().and_then(context_limit_from_settings_doc))
        .or_else(|| context_limit_from_settings_doc(&user))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::Mutex;

    static ENV_LOCK: Mutex<()> = Mutex::new(());

    #[test]
    fn parse_positive_token_count_accepts_digits_underscores_and_scientific() {
        assert_eq!(parse_positive_token_count("200000"), Some(200_000));
        assert_eq!(parse_positive_token_count("200_000"), Some(200_000));
        assert_eq!(parse_positive_token_count(" 1e6 "), Some(1_000_000));
        assert_eq!(parse_positive_token_count("500000"), Some(500_000));
        assert_eq!(parse_positive_token_count("0"), None);
        assert_eq!(parse_positive_token_count(""), None);
        assert_eq!(parse_positive_token_count("nope"), None);
    }

    #[test]
    fn settings_env_context_limit_string() {
        let doc = json!({
            "env": {
                "CLAUDE_CODE_CONTEXT_LIMIT": "500000",
                "CLAUDE_CODE_MAX_CONTEXT_TOKENS": "500000"
            }
        });
        assert_eq!(context_limit_from_settings_doc(&doc), Some(500_000));
    }

    #[test]
    fn settings_env_max_context_tokens_when_limit_absent() {
        let doc = json!({
            "env": { "CLAUDE_CODE_MAX_CONTEXT_TOKENS": "200000" }
        });
        assert_eq!(context_limit_from_settings_doc(&doc), Some(200_000));
    }

    #[test]
    fn settings_env_prefers_context_limit_over_max_tokens() {
        let doc = json!({
            "env": {
                "CLAUDE_CODE_CONTEXT_LIMIT": "500000",
                "CLAUDE_CODE_MAX_CONTEXT_TOKENS": "1000000"
            }
        });
        assert_eq!(context_limit_from_settings_doc(&doc), Some(500_000));
    }

    #[test]
    fn settings_env_accepts_numeric_values() {
        let doc = json!({
            "env": { "CLAUDE_CODE_CONTEXT_LIMIT": 500000 }
        });
        assert_eq!(context_limit_from_settings_doc(&doc), Some(500_000));
    }

    #[test]
    fn settings_top_level_keys_without_env_block() {
        let doc = json!({ "CLAUDE_CODE_CONTEXT_LIMIT": "500000" });
        assert_eq!(context_limit_from_settings_doc(&doc), Some(500_000));
    }

    #[test]
    fn settings_empty_doc_is_none() {
        assert_eq!(context_limit_from_settings_doc(&json!({})), None);
    }

    #[test]
    fn resolve_prefers_settings_over_process_env() {
        assert_eq!(
            resolve_context_limit_tokens(Some("1000000"), Some("1000000"), Some(500_000)),
            Some(500_000)
        );
        assert_eq!(
            resolve_context_limit_tokens(Some("1000000"), None, None),
            Some(1_000_000)
        );
    }

    #[test]
    fn load_reads_user_settings_json_from_claude_config_dir() {
        let _lock = ENV_LOCK.lock().unwrap();
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("settings.json"),
            r#"{
              "env": {
                "CLAUDE_CODE_CONTEXT_LIMIT": "500000",
                "CLAUDE_CODE_MAX_CONTEXT_TOKENS": "500000"
              }
            }"#,
        )
        .unwrap();
        let previous = std::env::var_os("CLAUDE_CONFIG_DIR");
        unsafe { std::env::set_var("CLAUDE_CONFIG_DIR", dir.path()) };
        let loaded = load_context_limit_from_claude_settings(None);
        match previous {
            Some(value) => unsafe { std::env::set_var("CLAUDE_CONFIG_DIR", value) },
            None => unsafe { std::env::remove_var("CLAUDE_CONFIG_DIR") },
        }
        assert_eq!(loaded, Some(500_000));
    }

    #[test]
    fn load_prefers_project_local_over_user() {
        let _lock = ENV_LOCK.lock().unwrap();
        let user_dir = tempfile::tempdir().unwrap();
        let repo = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(repo.path().join(".claude")).unwrap();
        std::fs::write(
            user_dir.path().join("settings.json"),
            r#"{"env":{"CLAUDE_CODE_CONTEXT_LIMIT":"200000"}}"#,
        )
        .unwrap();
        std::fs::write(
            repo.path().join(".claude/settings.local.json"),
            r#"{"env":{"CLAUDE_CODE_CONTEXT_LIMIT":"500000"}}"#,
        )
        .unwrap();
        let previous = std::env::var_os("CLAUDE_CONFIG_DIR");
        unsafe { std::env::set_var("CLAUDE_CONFIG_DIR", user_dir.path()) };
        let loaded = load_context_limit_from_claude_settings(Some(repo.path()));
        match previous {
            Some(value) => unsafe { std::env::set_var("CLAUDE_CONFIG_DIR", value) },
            None => unsafe { std::env::remove_var("CLAUDE_CONFIG_DIR") },
        }
        assert_eq!(loaded, Some(500_000));
    }
}
