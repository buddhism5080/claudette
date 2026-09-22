//! Register an existing folder as a workspace without creating a git worktree.
//!
//! The "+" button allocates a new branch and runs `git worktree add`. Dropping
//! a folder onto the workspace list is the opposite: the directory the user
//! already has becomes the workspace cwd, and git is only asked what branch
//! that directory is already on.

use std::collections::HashSet;
use std::path::Path;

use serde::Serialize;

use crate::db::Database;
use crate::git;
use crate::model::{AgentStatus, Repository, Workspace, WorkspaceStatus};
use crate::workspace_alloc::workspace_name_for_folder;

use super::{NotificationEvent, OpsError, OpsHooks, WorkspaceChangeKind};

/// Result of [`adopt_folder_as_workspace`].
///
/// `created_workspace` is false when a workspace already pointed at this
/// folder — the call is idempotent and does not insert a second row.
/// `created_repository` is false when the folder's git root was already in
/// Claudette.
#[derive(Debug, Clone, Serialize)]
pub struct AdoptFolderOutput {
    pub workspace: Workspace,
    pub repository: Repository,
    pub default_session_id: String,
    pub created_repository: bool,
    pub created_workspace: bool,
}

/// Open `folder` as a workspace named after the folder.
///
/// Does not call `git worktree add` and does not create a branch. The
/// workspace's `worktree_path` is the folder itself, and `branch_name` is
/// whatever that checkout is already on. Detached HEAD is rejected rather
/// than papered over with a new branch.
///
/// The folder must sit inside a non-bare git checkout. If that checkout's
/// primary repository is not registered yet, a repository row is inserted
/// for it (same idea as Add Repository, without the worktree-import dialog).
pub async fn adopt_folder_as_workspace(
    db: &mut Database,
    hooks: &dyn OpsHooks,
    folder: &Path,
) -> Result<AdoptFolderOutput, OpsError> {
    if !folder.exists() {
        return Err(OpsError::Validation(format!(
            "Folder not found: {}",
            folder.display()
        )));
    }
    if !folder.is_dir() {
        return Err(OpsError::Validation(
            "Drop a folder, not a file".to_string(),
        ));
    }

    let folder_canon = canon_string(folder)?;
    let main_path = git::main_repository_path(&folder_canon)
        .await
        .map_err(not_a_repo)?;
    let branch = git::current_branch(&folder_canon).await.map_err(|err| {
        let msg = err.to_string();
        if msg.contains("detached HEAD") {
            OpsError::Validation(
                "This folder is in detached HEAD state. Check out a branch before opening it as a workspace.".into(),
            )
        } else {
            OpsError::Git(err)
        }
    })?;

    if let Some(existing) = workspace_at_path(db, &folder_canon)? {
        let repository = db
            .get_repository(&existing.repository_id)?
            .ok_or_else(|| OpsError::NotFound("Repository not found".into()))?;
        let default_session_id = db
            .default_session_id_for_workspace(&existing.id)?
            .ok_or_else(|| {
                OpsError::Other("Workspace is missing its default chat session".to_string())
            })?;
        return Ok(AdoptFolderOutput {
            workspace: existing,
            repository,
            default_session_id,
            created_repository: false,
            created_workspace: false,
        });
    }

    let (repository, created_repository) = ensure_repository(db, &main_path).await?;

    let taken: HashSet<String> = db
        .list_workspaces()?
        .into_iter()
        .filter(|ws| ws.repository_id == repository.id)
        .map(|ws| ws.name)
        .collect();
    let folder_name = Path::new(&folder_canon)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();
    let name = workspace_name_for_folder(&folder_name, &taken).map_err(OpsError::Validation)?;

    let mut workspace = Workspace {
        id: uuid::Uuid::new_v4().to_string(),
        repository_id: repository.id.clone(),
        name,
        branch_name: branch,
        worktree_path: Some(folder_canon),
        status: WorkspaceStatus::Active,
        agent_status: AgentStatus::Idle,
        status_line: String::new(),
        created_at: now_iso(),
        sort_order: 0,
        input_values: None,
    };
    db.insert_workspace(&workspace)?;
    if let Ok(Some(order)) = db.lookup_workspace_sort_order(&workspace.id) {
        workspace.sort_order = order;
    }
    // The folder already has a branch. Don't let the first prompt rename it
    // (or the workspace) the way a freshly generated worktree would.
    db.claim_branch_auto_rename(&workspace.id)?;

    let default_session_id = db
        .default_session_id_for_workspace(&workspace.id)?
        .ok_or_else(|| {
            OpsError::Other("Workspace insert did not create a default chat session".to_string())
        })?;

    hooks.workspace_changed(&workspace.id, WorkspaceChangeKind::Created);
    hooks.notification(NotificationEvent::SessionStart);

    Ok(AdoptFolderOutput {
        workspace,
        repository,
        default_session_id,
        created_repository,
        created_workspace: true,
    })
}

fn not_a_repo(err: git::GitError) -> OpsError {
    match &err {
        git::GitError::NotAGitRepo => OpsError::Validation(
            "This folder is not inside a git repository, so it can't be opened as a workspace."
                .into(),
        ),
        git::GitError::CommandFailed(msg) if msg.contains("Bare repositories") => {
            OpsError::Validation(msg.clone())
        }
        _ => OpsError::Git(err),
    }
}

async fn ensure_repository(db: &Database, main_path: &str) -> Result<(Repository, bool), OpsError> {
    if let Some(existing) = repository_for_path(db, main_path)? {
        return Ok((existing, false));
    }

    let name = Path::new(main_path)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .filter(|n| !n.is_empty())
        .unwrap_or_else(|| "repo".to_string());
    let remotes = git::list_remotes(main_path).await.unwrap_or_default();
    let branches = git::list_remote_tracking_branches(main_path)
        .await
        .unwrap_or_default();
    let default_remote = pick_default_remote(&remotes);
    let base_branch = pick_default_branch(&branches, default_remote.as_deref());

    let repo = Repository {
        id: uuid::Uuid::new_v4().to_string(),
        path: main_path.to_string(),
        name: name.clone(),
        path_slug: name,
        icon: None,
        created_at: now_iso(),
        setup_script: None,
        custom_instructions: None,
        sort_order: 0,
        branch_rename_preferences: None,
        setup_script_auto_run: false,
        archive_script: None,
        archive_script_auto_run: false,
        base_branch,
        default_remote,
        required_inputs: None,
        path_valid: true,
    };
    db.insert_repository(&repo)?;
    let stored = db
        .get_repository(&repo.id)?
        .ok_or_else(|| OpsError::Other("Repository insert did not persist".into()))?;
    Ok((stored, true))
}

/// Same defaults as `commands::repository::resolve_default_remote`. Kept
/// here so the lib op doesn't depend on the Tauri crate.
fn pick_default_remote(remotes: &[String]) -> Option<String> {
    match remotes.len() {
        0 => None,
        1 => Some(remotes[0].clone()),
        _ => {
            if remotes.iter().any(|r| r == "origin") {
                Some("origin".to_string())
            } else {
                Some(remotes[0].clone())
            }
        }
    }
}

fn pick_default_branch(branches: &[String], default_remote: Option<&str>) -> Option<String> {
    if branches.is_empty() {
        return None;
    }
    if branches.len() == 1 {
        return Some(branches[0].clone());
    }
    let remote = default_remote.unwrap_or("origin");
    let main = format!("{remote}/main");
    if branches.iter().any(|b| b == &main) {
        return Some(main);
    }
    let master = format!("{remote}/master");
    if branches.iter().any(|b| b == &master) {
        return Some(master);
    }
    Some(branches[0].clone())
}

fn repository_for_path(db: &Database, main_path: &str) -> Result<Option<Repository>, OpsError> {
    let want = canon_key(Path::new(main_path));
    for repo in db.list_repositories()? {
        if canon_key(Path::new(&repo.path)) == want || repo.path == main_path {
            return Ok(Some(repo));
        }
    }
    Ok(None)
}

fn workspace_at_path(db: &Database, folder_canon: &str) -> Result<Option<Workspace>, OpsError> {
    let want = canon_key(Path::new(folder_canon));
    for ws in db.list_workspaces()? {
        let Some(path) = ws.worktree_path.as_deref() else {
            continue;
        };
        if canon_key(Path::new(path)) == want || path == folder_canon {
            return Ok(Some(ws));
        }
    }
    Ok(None)
}

fn canon_string(path: &Path) -> Result<String, OpsError> {
    let abs = std::fs::canonicalize(path)
        .map_err(|e| OpsError::Validation(format!("Invalid path {}: {e}", path.display())))?;
    Ok(crate::path::strip_verbatim_prefix(&abs.to_string_lossy()).to_string())
}

fn canon_key(path: &Path) -> String {
    std::fs::canonicalize(path)
        .unwrap_or_else(|_| path.to_path_buf())
        .to_string_lossy()
        .to_string()
}

fn now_iso() -> String {
    let dur = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    format!("{}", dur.as_secs())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    #[derive(Default)]
    struct RecordingHooks {
        changes: Mutex<Vec<(String, WorkspaceChangeKind)>>,
    }

    impl OpsHooks for RecordingHooks {
        fn workspace_changed(&self, workspace_id: &str, kind: WorkspaceChangeKind) {
            self.changes
                .lock()
                .unwrap()
                .push((workspace_id.to_string(), kind));
        }
    }

    async fn run_git(repo: &Path, args: &[&str]) {
        let status = crate::process::command("git")
            .args(args)
            .current_dir(repo)
            .status()
            .await
            .unwrap();
        assert!(
            status.success(),
            "git {args:?} failed in {}",
            repo.display()
        );
    }

    async fn init_repo(path: &Path) {
        std::fs::create_dir_all(path).unwrap();
        run_git(path, &["init", "-b", "main"]).await;
        run_git(path, &["config", "user.email", "test@test.com"]).await;
        run_git(path, &["config", "user.name", "Test"]).await;
        std::fs::write(path.join("README.md"), "# test").unwrap();
        run_git(path, &["add", "-A"]).await;
        run_git(path, &["commit", "-m", "initial"]).await;
    }

    fn worktree_paths(list: &[git::WorktreeInfo]) -> Vec<String> {
        list.iter().map(|wt| wt.path.clone()).collect()
    }

    #[tokio::test]
    async fn adopt_repo_root_uses_the_folder_and_does_not_create_a_worktree() {
        let parent = tempfile::tempdir().unwrap();
        let repo = parent.path().join("demo-repo");
        init_repo(&repo).await;
        let before = git::list_worktrees(repo.to_str().unwrap()).await.unwrap();
        let branches_before = git::list_branches(repo.to_str().unwrap()).await.unwrap();

        let db_dir = tempfile::tempdir().unwrap();
        let mut db = Database::open(&db_dir.path().join("test.db")).unwrap();
        let hooks = RecordingHooks::default();

        let out = adopt_folder_as_workspace(&mut db, &hooks, &repo)
            .await
            .unwrap();

        assert!(out.created_repository);
        assert!(out.created_workspace);
        assert_eq!(out.workspace.name, "demo-repo");
        assert_eq!(out.workspace.branch_name, "main");
        assert_eq!(
            canon_key(Path::new(out.workspace.worktree_path.as_deref().unwrap())),
            canon_key(&repo)
        );
        assert_eq!(canon_key(Path::new(&out.repository.path)), canon_key(&repo));
        assert!(db.is_branch_auto_rename_claimed(&out.workspace.id).unwrap());
        assert_eq!(hooks.changes.lock().unwrap().len(), 1);
        assert_eq!(
            hooks.changes.lock().unwrap()[0].1,
            WorkspaceChangeKind::Created
        );

        let after = git::list_worktrees(repo.to_str().unwrap()).await.unwrap();
        let branches_after = git::list_branches(repo.to_str().unwrap()).await.unwrap();
        assert_eq!(worktree_paths(&before), worktree_paths(&after));
        assert_eq!(branches_before, branches_after);
        assert_eq!(db.list_workspaces().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn adopt_same_folder_twice_does_not_insert_another_workspace() {
        let parent = tempfile::tempdir().unwrap();
        let repo = parent.path().join("demo-repo");
        init_repo(&repo).await;
        let db_dir = tempfile::tempdir().unwrap();
        let mut db = Database::open(&db_dir.path().join("test.db")).unwrap();
        let hooks = RecordingHooks::default();

        let first = adopt_folder_as_workspace(&mut db, &hooks, &repo)
            .await
            .unwrap();
        let second = adopt_folder_as_workspace(&mut db, &hooks, &repo)
            .await
            .unwrap();

        assert!(!second.created_workspace);
        assert!(!second.created_repository);
        assert_eq!(first.workspace.id, second.workspace.id);
        assert_eq!(db.list_workspaces().unwrap().len(), 1);
        assert_eq!(hooks.changes.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn adopt_subdirectory_names_the_workspace_after_that_folder() {
        let parent = tempfile::tempdir().unwrap();
        let repo = parent.path().join("demo-repo");
        init_repo(&repo).await;
        let pkg = repo.join("我的项目");
        std::fs::create_dir(&pkg).unwrap();
        let before = git::list_worktrees(repo.to_str().unwrap()).await.unwrap();

        let db_dir = tempfile::tempdir().unwrap();
        let mut db = Database::open(&db_dir.path().join("test.db")).unwrap();
        let hooks = RecordingHooks::default();

        let out = adopt_folder_as_workspace(&mut db, &hooks, &pkg)
            .await
            .unwrap();

        assert_eq!(out.workspace.name, "我的项目");
        assert_eq!(out.workspace.branch_name, "main");
        assert_eq!(
            canon_key(Path::new(out.workspace.worktree_path.as_deref().unwrap())),
            canon_key(&pkg)
        );
        assert_eq!(canon_key(Path::new(&out.repository.path)), canon_key(&repo));
        let after = git::list_worktrees(repo.to_str().unwrap()).await.unwrap();
        assert_eq!(worktree_paths(&before), worktree_paths(&after));
    }

    #[tokio::test]
    async fn adopt_suffixes_the_name_when_the_folder_name_is_taken() {
        let parent = tempfile::tempdir().unwrap();
        let repo = parent.path().join("demo-repo");
        init_repo(&repo).await;
        let pkg = repo.join("pkg");
        std::fs::create_dir(&pkg).unwrap();

        let db_dir = tempfile::tempdir().unwrap();
        let mut db = Database::open(&db_dir.path().join("test.db")).unwrap();
        let hooks = RecordingHooks::default();
        let first = adopt_folder_as_workspace(&mut db, &hooks, &repo)
            .await
            .unwrap();
        db.update_workspace_name(&first.workspace.id, "pkg")
            .unwrap();

        let out = adopt_folder_as_workspace(&mut db, &hooks, &pkg)
            .await
            .unwrap();
        assert_eq!(out.workspace.name, "pkg-2");
        assert!(!out.created_repository);
        let after = git::list_worktrees(repo.to_str().unwrap()).await.unwrap();
        assert_eq!(after.len(), 1);
    }

    #[tokio::test]
    async fn adopt_linked_worktree_does_not_add_another_worktree() {
        let parent = tempfile::tempdir().unwrap();
        let repo = parent.path().join("demo-repo");
        init_repo(&repo).await;
        let wt = parent.path().join("feature-checkout");
        run_git(
            &repo,
            &["worktree", "add", "-b", "feature", wt.to_str().unwrap()],
        )
        .await;
        let before = git::list_worktrees(repo.to_str().unwrap()).await.unwrap();
        assert_eq!(before.len(), 2);
        let branches_before = git::list_branches(repo.to_str().unwrap()).await.unwrap();

        let db_dir = tempfile::tempdir().unwrap();
        let mut db = Database::open(&db_dir.path().join("test.db")).unwrap();
        let hooks = RecordingHooks::default();
        let out = adopt_folder_as_workspace(&mut db, &hooks, &wt)
            .await
            .unwrap();

        assert_eq!(out.workspace.name, "feature-checkout");
        assert_eq!(out.workspace.branch_name, "feature");
        assert_eq!(canon_key(Path::new(&out.repository.path)), canon_key(&repo));
        assert_eq!(
            canon_key(Path::new(out.workspace.worktree_path.as_deref().unwrap())),
            canon_key(&wt)
        );
        let after = git::list_worktrees(repo.to_str().unwrap()).await.unwrap();
        let branches_after = git::list_branches(repo.to_str().unwrap()).await.unwrap();
        assert_eq!(worktree_paths(&before), worktree_paths(&after));
        assert_eq!(branches_before, branches_after);
    }

    #[tokio::test]
    async fn adopt_rejects_a_file_and_a_non_git_directory() {
        let parent = tempfile::tempdir().unwrap();
        let file = parent.path().join("notes.txt");
        std::fs::write(&file, "hi").unwrap();
        let plain = parent.path().join("plain");
        std::fs::create_dir(&plain).unwrap();

        let db_dir = tempfile::tempdir().unwrap();
        let mut db = Database::open(&db_dir.path().join("test.db")).unwrap();
        let hooks = RecordingHooks::default();

        let file_err = adopt_folder_as_workspace(&mut db, &hooks, &file)
            .await
            .unwrap_err();
        assert!(file_err.to_string().contains("folder"), "{file_err}");

        let dir_err = adopt_folder_as_workspace(&mut db, &hooks, &plain)
            .await
            .unwrap_err();
        assert!(dir_err.to_string().contains("git repository"), "{dir_err}");
        assert!(db.list_repositories().unwrap().is_empty());
        assert!(db.list_workspaces().unwrap().is_empty());
    }

    #[tokio::test]
    async fn adopt_rejects_detached_head_without_creating_a_branch() {
        let parent = tempfile::tempdir().unwrap();
        let repo = parent.path().join("demo-repo");
        init_repo(&repo).await;
        run_git(&repo, &["checkout", "--detach"]).await;
        let branches_before = git::list_branches(repo.to_str().unwrap()).await.unwrap();

        let db_dir = tempfile::tempdir().unwrap();
        let mut db = Database::open(&db_dir.path().join("test.db")).unwrap();
        let hooks = RecordingHooks::default();
        let err = adopt_folder_as_workspace(&mut db, &hooks, &repo)
            .await
            .unwrap_err();
        assert!(err.to_string().contains("detached HEAD"), "{err}");
        assert!(db.list_workspaces().unwrap().is_empty());
        let branches_after = git::list_branches(repo.to_str().unwrap()).await.unwrap();
        assert_eq!(branches_before, branches_after);
    }
}
