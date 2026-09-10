//! Clone a Claude CLI JSONL prefix onto a new session id.
//!
//! Rollback cannot `--resume` the original transcript: it still contains
//! turns after the checkpoint. At checkpoint time we record the file's
//! byte length. Rollback copies that prefix to `{newSid}.jsonl` and
//! rewrites `sessionId` only (`uuid` / `parentUuid` stay put).

use std::path::Path;

/// Copy the first `prefix_len` bytes of a Claude JSONL, ending on a complete
/// line, and set every object's `sessionId` / `session_id` to `new_session_id`.
pub fn rebind_jsonl_prefix(source: &[u8], prefix_len: u64, new_session_id: &str) -> Vec<u8> {
    let mut end = (prefix_len as usize).min(source.len());
    if end == 0 {
        return Vec::new();
    }
    if end < source.len() || source[end - 1] != b'\n' {
        match source[..end].iter().rposition(|&b| b == b'\n') {
            Some(i) => end = i + 1,
            None => return Vec::new(),
        }
    }
    let prefix = &source[..end];
    let mut out = Vec::with_capacity(prefix.len() + new_session_id.len());
    for line in prefix.split_inclusive(|&b| b == b'\n') {
        let (body, nl) = if line.ends_with(&[b'\n']) {
            (&line[..line.len() - 1], true)
        } else {
            (line, false)
        };
        if body.is_empty() {
            if nl {
                out.push(b'\n');
            }
            continue;
        }
        let rewritten = rebind_session_id_line(body, new_session_id);
        out.extend_from_slice(&rewritten);
        if nl {
            out.push(b'\n');
        }
    }
    out
}

fn rebind_session_id_line(line: &[u8], new_session_id: &str) -> Vec<u8> {
    let Ok(text) = std::str::from_utf8(line) else {
        return line.to_vec();
    };
    let Ok(serde_json::Value::Object(mut map)) = serde_json::from_str::<serde_json::Value>(text)
    else {
        return line.to_vec();
    };
    let mut changed = false;
    if map.contains_key("sessionId") {
        map.insert(
            "sessionId".into(),
            serde_json::Value::String(new_session_id.to_string()),
        );
        changed = true;
    }
    if map.contains_key("session_id") {
        map.insert(
            "session_id".into(),
            serde_json::Value::String(new_session_id.to_string()),
        );
        changed = true;
    }
    if !changed {
        return line.to_vec();
    }
    serde_json::to_vec(&map).unwrap_or_else(|_| line.to_vec())
}

/// Read `src`, rebind a prefix, write `dest`. Returns bytes written.
pub fn write_rebound_prefix(
    src: &Path,
    dest: &Path,
    prefix_len: u64,
    new_session_id: &str,
) -> Result<u64, String> {
    let source =
        std::fs::read(src).map_err(|e| format!("read Claude transcript {}: {e}", src.display()))?;
    let out = rebind_jsonl_prefix(&source, prefix_len, new_session_id);
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("create Claude projects dir {}: {e}", parent.display()))?;
    }
    std::fs::write(dest, &out)
        .map_err(|e| format!("write Claude transcript {}: {e}", dest.display()))?;
    Ok(out.len() as u64)
}

pub fn remove_transcript(path: &Path) -> Result<(), String> {
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("delete Claude transcript {}: {e}", path.display())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn line(s: &str) -> String {
        format!("{s}\n")
    }

    #[test]
    fn prefix_on_line_boundary_keeps_complete_lines_only() {
        let a = line(r#"{"type":"user","sessionId":"old","uuid":"u1","text":"hi"}"#);
        let b = line(r#"{"type":"assistant","sessionId":"old","uuid":"u2","parentUuid":"u1"}"#);
        let c = line(r#"{"type":"user","sessionId":"old","uuid":"u3","parentUuid":"u2"}"#);
        let src = format!("{a}{b}{c}");
        let cut = a.len() + b.len();
        let out = rebind_jsonl_prefix(src.as_bytes(), cut as u64, "new");
        let text = String::from_utf8(out).unwrap();
        assert!(text.contains("\"sessionId\":\"new\""));
        assert!(!text.contains("\"sessionId\":\"old\""));
        assert!(text.contains("\"uuid\":\"u1\""));
        assert!(text.contains("\"uuid\":\"u2\""));
        assert!(text.contains("\"parentUuid\":\"u1\""));
        assert!(!text.contains("\"uuid\":\"u3\""));
    }

    #[test]
    fn mid_line_cut_drops_the_incomplete_line() {
        let a = line(r#"{"type":"user","sessionId":"old","uuid":"u1"}"#);
        let b = r#"{"type":"assistant","sessionId":"old","uuid":"u2""#; // no newline
        let src = format!("{a}{b}");
        let out = rebind_jsonl_prefix(src.as_bytes(), src.len() as u64, "new");
        let text = String::from_utf8(out).unwrap();
        assert_eq!(text.matches('\n').count(), 1);
        assert!(text.contains("\"uuid\":\"u1\""));
        assert!(!text.contains("\"uuid\":\"u2\""));
    }

    #[test]
    fn does_not_rewrite_session_id_inside_message_text() {
        let a = line(
            r#"{"type":"user","sessionId":"old","uuid":"u1","text":"the sid is old not a field"}"#,
        );
        let out = rebind_jsonl_prefix(a.as_bytes(), a.len() as u64, "new");
        let v: serde_json::Value = serde_json::from_slice(&out[..out.len() - 1]).unwrap();
        assert_eq!(v["sessionId"], "new");
        assert_eq!(v["uuid"], "u1");
        assert_eq!(v["text"], "the sid is old not a field");
    }

    #[test]
    fn empty_or_too_short_prefix_is_empty() {
        let a = b"{\"sessionId\":\"old\"}"; // no newline
        assert!(rebind_jsonl_prefix(a, 3, "new").is_empty());
        assert!(rebind_jsonl_prefix(a, 0, "new").is_empty());
    }

    #[test]
    fn write_then_delete_round_trip() {
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("old.jsonl");
        let dest = dir.path().join("nested").join("new.jsonl");
        let a = line(r#"{"type":"user","sessionId":"old","uuid":"u1"}"#);
        let b = line(r#"{"type":"assistant","sessionId":"old","uuid":"u2"}"#);
        std::fs::write(&src, format!("{a}{b}")).unwrap();
        let n = write_rebound_prefix(&src, &dest, a.len() as u64, "new").unwrap();
        assert!(n > 0);
        let got = std::fs::read_to_string(&dest).unwrap();
        assert!(got.contains("\"sessionId\":\"new\""));
        assert!(!got.contains("\"uuid\":\"u2\""));
        remove_transcript(&src).unwrap();
        assert!(!src.exists());
        remove_transcript(&src).unwrap();
    }
}
