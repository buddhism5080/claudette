use std::path::{Path, PathBuf};

use crate::model::{Repository, Workspace};

const MAX_ALLOCATION_ATTEMPTS: usize = 10_000;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkspaceAllocation {
    pub name: String,
    pub branch_name: String,
    pub worktree_path: PathBuf,
}

#[derive(Debug)]
pub enum WorkspaceAllocationError {
    Git(crate::git::GitError),
    Exhausted,
}

impl std::fmt::Display for WorkspaceAllocationError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Git(err) => write!(f, "{err}"),
            Self::Exhausted => write!(f, "Could not allocate a unique workspace name"),
        }
    }
}

impl std::error::Error for WorkspaceAllocationError {}

impl From<crate::git::GitError> for WorkspaceAllocationError {
    fn from(err: crate::git::GitError) -> Self {
        Self::Git(err)
    }
}

/// Validate a workspace name: ASCII alphanumeric + hyphens, no leading/trailing hyphens.
pub fn is_valid_workspace_name(name: &str) -> bool {
    !name.is_empty()
        && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
        && !name.starts_with('-')
        && !name.ends_with('-')
}

/// Longest folder-derived workspace name we will store. Folder basenames are
/// kept verbatim (spaces and non-ASCII included); this only rejects names
/// that cannot be a single path segment.
const MAX_FOLDER_WORKSPACE_NAME_CHARS: usize = 200;
const MAX_FOLDER_NAME_ATTEMPTS: usize = 10_000;

/// Display name for a folder the user dropped onto the workspace list.
///
/// The basename is kept as-is — including spaces and non-ASCII — so the
/// sidebar row matches the folder. [`is_valid_workspace_name`] is intentionally
/// not applied: that check exists so *generated* names are safe git branch
/// names, and adopting a folder does not create a branch from the name.
///
/// When `taken` already contains the basename, `-2`, `-3`, … is appended.
pub fn workspace_name_for_folder(
    folder_name: &str,
    taken: &std::collections::HashSet<String>,
) -> Result<String, String> {
    let base = folder_name.trim();
    let unsafe_name = base.is_empty()
        || base == "."
        || base == ".."
        || base
            .chars()
            .any(|c| c.is_control() || c == '/' || c == '\\')
        || base.chars().count() > MAX_FOLDER_WORKSPACE_NAME_CHARS;
    if unsafe_name {
        return Err(format!(
            "Cannot use folder name {folder_name:?} as a workspace name"
        ));
    }
    if !taken.contains(base) {
        return Ok(base.to_string());
    }
    for n in 2..MAX_FOLDER_NAME_ATTEMPTS {
        let candidate = format!("{base}-{n}");
        if candidate.chars().count() > MAX_FOLDER_WORKSPACE_NAME_CHARS {
            break;
        }
        if !taken.contains(&candidate) {
            return Ok(candidate);
        }
    }
    Err("Could not allocate a unique workspace name".into())
}

pub async fn allocate_workspace_name(
    repo: &Repository,
    workspaces: &[Workspace],
    requested_name: &str,
    branch_prefix: &str,
    worktree_base: &Path,
) -> Result<WorkspaceAllocation, WorkspaceAllocationError> {
    let existing_workspace_names: std::collections::HashSet<String> = workspaces
        .iter()
        .filter(|w| w.repository_id == repo.id)
        .map(|w| w.name.clone())
        .collect();
    let existing_workspace_branches: std::collections::HashSet<String> = workspaces
        .iter()
        .filter(|w| w.repository_id == repo.id)
        .map(|w| w.branch_name.clone())
        .collect();
    let existing_workspace_paths: std::collections::HashSet<String> = workspaces
        .iter()
        .filter(|w| w.repository_id == repo.id)
        .filter_map(|w| w.worktree_path.as_deref())
        .map(path_key)
        .collect();

    let existing_git_branches: std::collections::HashSet<String> =
        crate::git::list_branches(&repo.path)
            .await?
            .into_iter()
            .collect();
    let existing_git_worktree_paths: std::collections::HashSet<String> =
        crate::git::list_worktrees(&repo.path)
            .await?
            .into_iter()
            .map(|wt| path_key(&wt.path))
            .collect();

    for attempt in 0..MAX_ALLOCATION_ATTEMPTS {
        let name = if attempt == 0 {
            requested_name.to_string()
        } else {
            format!("{requested_name}-{}", attempt + 1)
        };
        let branch_name = format!("{branch_prefix}{name}");
        let worktree_path = worktree_base.join(&repo.path_slug).join(&name);
        let worktree_key = path_key(&worktree_path);

        if existing_workspace_names.contains(&name)
            || existing_workspace_branches.contains(&branch_name)
            || existing_workspace_paths.contains(&worktree_key)
            || existing_git_branches.contains(&branch_name)
            || existing_git_worktree_paths.contains(&worktree_key)
            || worktree_path.exists()
        {
            continue;
        }

        return Ok(WorkspaceAllocation {
            name,
            branch_name,
            worktree_path,
        });
    }

    Err(WorkspaceAllocationError::Exhausted)
}

fn path_key(path: impl AsRef<Path>) -> String {
    let path = path.as_ref();
    path.canonicalize()
        .unwrap_or_else(|_| path.to_path_buf())
        .to_string_lossy()
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Database;
    use crate::model::{AgentStatus, Repository, Workspace, WorkspaceStatus};

    fn make_repo(id: &str, path: &str) -> Repository {
        Repository {
            id: id.into(),
            path: path.into(),
            name: id.into(),
            path_slug: id.into(),
            icon: None,
            created_at: String::new(),
            setup_script: None,
            custom_instructions: None,
            sort_order: 0,
            branch_rename_preferences: None,
            setup_script_auto_run: false,
            archive_script: None,
            archive_script_auto_run: false,
            base_branch: None,
            default_remote: None,
            required_inputs: None,
            path_valid: true,
        }
    }

    fn make_workspace(id: &str, repo: &str, name: &str, branch: &str, path: &Path) -> Workspace {
        Workspace {
            id: id.into(),
            repository_id: repo.into(),
            name: name.into(),
            branch_name: branch.into(),
            worktree_path: Some(path.to_string_lossy().to_string()),
            status: WorkspaceStatus::Active,
            agent_status: AgentStatus::Idle,
            status_line: String::new(),
            created_at: String::new(),
            sort_order: 0,
            input_values: None,
        }
    }

    fn git(repo: &Path, args: &[&str]) {
        let status = crate::process::std_command(crate::git::resolve_git_path_blocking())
            .arg("-C")
            .arg(repo)
            .args(args)
            .status()
            .unwrap();
        assert!(status.success(), "git command failed: {args:?}");
    }

    fn setup_repo() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        let repo = dir.path();
        let status = crate::process::std_command(crate::git::resolve_git_path_blocking())
            .arg("-C")
            .arg(repo)
            .args(["init", "-b", "main"])
            .status()
            .unwrap();
        assert!(status.success());
        git(repo, &["config", "user.email", "test@test.com"]);
        git(repo, &["config", "user.name", "Test"]);
        std::fs::write(repo.join("README.md"), "# test").unwrap();
        git(repo, &["add", "-A"]);
        git(repo, &["commit", "-m", "initial"]);
        dir
    }

    #[tokio::test]
    async fn allocation_uses_base_name_when_available() {
        let repo_dir = setup_repo();
        let db = Database::open_in_memory().unwrap();
        let repo = make_repo("repo1", repo_dir.path().to_str().unwrap());
        db.insert_repository(&repo).unwrap();
        let base = tempfile::tempdir().unwrap();

        let allocation = allocate_workspace_name(
            &repo,
            &db.list_workspaces().unwrap(),
            "dusty-dandelion",
            "user/",
            base.path(),
        )
        .await
        .unwrap();

        assert_eq!(allocation.name, "dusty-dandelion");
        assert_eq!(allocation.branch_name, "user/dusty-dandelion");
        assert_eq!(
            allocation.worktree_path,
            base.path().join("repo1").join("dusty-dandelion")
        );
    }

    #[tokio::test]
    async fn allocation_suffixes_existing_workspace_name() {
        let repo_dir = setup_repo();
        let db = Database::open_in_memory().unwrap();
        let repo = make_repo("repo1", repo_dir.path().to_str().unwrap());
        db.insert_repository(&repo).unwrap();
        let base = tempfile::tempdir().unwrap();
        db.insert_workspace(&make_workspace(
            "w1",
            "repo1",
            "dusty-dandelion",
            "user/dusty-dandelion",
            &base.path().join("repo1").join("dusty-dandelion"),
        ))
        .unwrap();

        let allocation = allocate_workspace_name(
            &repo,
            &db.list_workspaces().unwrap(),
            "dusty-dandelion",
            "user/",
            base.path(),
        )
        .await
        .unwrap();

        assert_eq!(allocation.name, "dusty-dandelion-2");
        assert_eq!(allocation.branch_name, "user/dusty-dandelion-2");
    }

    #[tokio::test]
    async fn allocation_suffixes_existing_git_branch() {
        let repo_dir = setup_repo();
        git(repo_dir.path(), &["branch", "user/dusty-dandelion"]);
        let db = Database::open_in_memory().unwrap();
        let repo = make_repo("repo1", repo_dir.path().to_str().unwrap());
        db.insert_repository(&repo).unwrap();
        let base = tempfile::tempdir().unwrap();

        let allocation = allocate_workspace_name(
            &repo,
            &db.list_workspaces().unwrap(),
            "dusty-dandelion",
            "user/",
            base.path(),
        )
        .await
        .unwrap();

        assert_eq!(allocation.name, "dusty-dandelion-2");
        assert_eq!(allocation.branch_name, "user/dusty-dandelion-2");
    }

    #[tokio::test]
    async fn allocation_suffixes_existing_worktree_path_on_disk() {
        let repo_dir = setup_repo();
        let db = Database::open_in_memory().unwrap();
        let repo = make_repo("repo1", repo_dir.path().to_str().unwrap());
        db.insert_repository(&repo).unwrap();
        let base = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(base.path().join("repo1").join("dusty-dandelion")).unwrap();

        let allocation = allocate_workspace_name(
            &repo,
            &db.list_workspaces().unwrap(),
            "dusty-dandelion",
            "user/",
            base.path(),
        )
        .await
        .unwrap();

        assert_eq!(allocation.name, "dusty-dandelion-2");
        assert_eq!(allocation.branch_name, "user/dusty-dandelion-2");
    }

    #[tokio::test]
    async fn allocation_ignores_same_name_in_other_repo() {
        let repo_dir = setup_repo();
        let other_repo_dir = setup_repo();
        let db = Database::open_in_memory().unwrap();
        let repo = make_repo("repo1", repo_dir.path().to_str().unwrap());
        let other = make_repo("repo2", other_repo_dir.path().to_str().unwrap());
        db.insert_repository(&repo).unwrap();
        db.insert_repository(&other).unwrap();
        let base = tempfile::tempdir().unwrap();
        db.insert_workspace(&make_workspace(
            "w1",
            "repo2",
            "dusty-dandelion",
            "user/dusty-dandelion",
            &base.path().join("repo2").join("dusty-dandelion"),
        ))
        .unwrap();

        let allocation = allocate_workspace_name(
            &repo,
            &db.list_workspaces().unwrap(),
            "dusty-dandelion",
            "user/",
            base.path(),
        )
        .await
        .unwrap();

        assert_eq!(allocation.name, "dusty-dandelion");
        assert_eq!(allocation.branch_name, "user/dusty-dandelion");
    }

    #[test]
    fn folder_name_keeps_spaces_and_non_ascii() {
        let taken = std::collections::HashSet::new();
        assert_eq!(
            workspace_name_for_folder("My Project", &taken).unwrap(),
            "My Project"
        );
        assert_eq!(
            workspace_name_for_folder("我的项目", &taken).unwrap(),
            "我的项目"
        );
        assert_eq!(
            workspace_name_for_folder("demo-repo", &taken).unwrap(),
            "demo-repo"
        );
    }

    #[test]
    fn folder_name_suffixes_when_taken() {
        let taken = ["pkg".to_string(), "pkg-2".to_string()]
            .into_iter()
            .collect();
        assert_eq!(workspace_name_for_folder("pkg", &taken).unwrap(), "pkg-3");
    }

    #[test]
    fn folder_name_rejects_path_segments() {
        let taken = std::collections::HashSet::new();
        assert!(workspace_name_for_folder("", &taken).is_err());
        assert!(workspace_name_for_folder(".", &taken).is_err());
        assert!(workspace_name_for_folder("..", &taken).is_err());
        assert!(workspace_name_for_folder("a/b", &taken).is_err());
    }
}
