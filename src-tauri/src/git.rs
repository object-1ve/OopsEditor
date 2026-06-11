use std::process::{Command, Output};
use serde::{Serialize, Deserialize};

#[derive(Debug, Serialize, Deserialize)]
pub struct GitStatus {
    pub branch: String,
    pub staged: Vec<String>,
    pub unstaged: Vec<String>,
    pub untracked: Vec<String>,
}

fn run_git(path: &str, args: &[&str]) -> Result<Output, String> {
    Command::new("git")
        .args(args)
        .current_dir(path)
        .output()
        .map_err(|e| format!("执行 git 命令失败: {}", e))
}

fn git_stdout(path: &str, args: &[&str], action: &str) -> Result<String, String> {
    let output = run_git(path, args)?;
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        Err(if stderr.is_empty() {
            format!("{}失败", action)
        } else {
            stderr
        })
    }
}

fn resolve_repo_root(path: &str) -> Result<Option<String>, String> {
    let output = run_git(path, &["rev-parse", "--show-toplevel"])?;
    if output.status.success() {
        let root = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if root.is_empty() {
            Ok(None)
        } else {
            Ok(Some(root))
        }
    } else {
        Ok(None)
    }
}

#[tauri::command]
pub fn git_check_repo(path: String) -> bool {
    resolve_repo_root(&path).ok().flatten().is_some()
}

#[tauri::command]
pub fn git_resolve_repo_root(path: String) -> Result<Option<String>, String> {
    resolve_repo_root(&path)
}

#[tauri::command]
pub fn git_init(path: String) -> Result<(), String> {
    let output = run_git(&path, &["init"])?;

    if output.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).to_string())
    }
}

#[tauri::command]
pub fn git_get_status(path: String) -> Result<GitStatus, String> {
    let repo_root = resolve_repo_root(&path)?.ok_or_else(|| "当前路径不在 Git 仓库中".to_string())?;

    // 获取当前分支
    let branch_output = run_git(&repo_root, &["rev-parse", "--abbrev-ref", "HEAD"])?;

    let branch = if branch_output.status.success() {
        String::from_utf8_lossy(&branch_output.stdout).trim().to_string()
    } else {
        // 如果 HEAD 不存在（新仓库），尝试获取默认分支名
        let default_branch_output = run_git(&repo_root, &["symbolic-ref", "--short", "HEAD"]);
        
        match default_branch_output {
            Ok(out) if out.status.success() => {
                String::from_utf8_lossy(&out.stdout).trim().to_string()
            },
            _ => "main (initial)".to_string()
        }
    };

    // 获取文件状态
    let status_output = run_git(&repo_root, &["status", "--porcelain"])?;
    if !status_output.status.success() {
        let stderr = String::from_utf8_lossy(&status_output.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            "获取 Git 状态失败".to_string()
        } else {
            stderr
        });
    }

    let status_str = String::from_utf8_lossy(&status_output.stdout);
    let mut staged = Vec::new();
    let mut unstaged = Vec::new();
    let mut untracked = Vec::new();

    for line in status_str.lines() {
        if line.len() < 3 { continue; }
        let (code, file) = line.split_at(2);
        let file = file.trim().to_string();

        match code {
            "??" => untracked.push(file),
            c if c.starts_with(' ') => unstaged.push(file),
            _ => staged.push(file),
        }
    }

    Ok(GitStatus {
        branch,
        staged,
        unstaged,
        untracked,
    })
}

#[tauri::command]
pub fn git_add(path: String, files: Vec<String>) -> Result<(), String> {
    let repo_root = resolve_repo_root(&path)?.ok_or_else(|| "当前路径不在 Git 仓库中".to_string())?;
    let mut cmd = Command::new("git");
    cmd.arg("add").current_dir(&repo_root);
    
    if files.is_empty() {
        cmd.arg(".");
    } else {
        for file in files {
            cmd.arg(file);
        }
    }

    let output = cmd.output().map_err(|e| format!("执行 git add 失败: {}", e))?;

    if output.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).to_string())
    }
}

#[tauri::command]
pub fn git_commit(path: String, message: String) -> Result<(), String> {
    let repo_root = resolve_repo_root(&path)?.ok_or_else(|| "当前路径不在 Git 仓库中".to_string())?;
    let output = Command::new("git")
        .args(["commit", "-m", &message])
        .current_dir(&repo_root)
        .output()
        .map_err(|e| format!("执行 git commit 失败: {}", e))?;

    if output.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).to_string())
    }
}

#[tauri::command]
pub fn git_push(path: String) -> Result<(), String> {
    let repo_root = resolve_repo_root(&path)?.ok_or_else(|| "当前路径不在 Git 仓库中".to_string())?;
    let output = Command::new("git")
        .arg("push")
        .current_dir(&repo_root)
        .output()
        .map_err(|e| format!("执行 git push 失败: {}", e))?;

    if output.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).to_string())
    }
}

#[tauri::command]
pub fn git_pull(path: String) -> Result<(), String> {
    let repo_root = resolve_repo_root(&path)?.ok_or_else(|| "当前路径不在 Git 仓库中".to_string())?;
    let output = Command::new("git")
        .arg("pull")
        .current_dir(&repo_root)
        .output()
        .map_err(|e| format!("执行 git pull 失败: {}", e))?;

    if output.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).to_string())
    }
}

#[tauri::command]
pub fn git_remote_add(path: String, url: String) -> Result<(), String> {
    let repo_root = resolve_repo_root(&path)?.ok_or_else(|| "当前路径不在 Git 仓库中".to_string())?;
    let output = Command::new("git")
        .args(["remote", "add", "origin", &url])
        .current_dir(&repo_root)
        .output()
        .map_err(|e| format!("添加远程仓库失败: {}", e))?;

    if output.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).to_string())
    }
}

#[tauri::command]
pub fn git_remote_get(path: String) -> Result<Option<String>, String> {
    let Some(repo_root) = resolve_repo_root(&path)? else {
        return Ok(None);
    };
    let output = Command::new("git")
        .args(["remote", "get-url", "origin"])
        .current_dir(&repo_root)
        .output()
        .map_err(|e| format!("获取远程仓库地址失败: {}", e))?;

    if output.status.success() {
        Ok(Some(String::from_utf8_lossy(&output.stdout).trim().to_string()))
    } else {
        Ok(None)
    }
}

#[derive(Debug, Serialize, Deserialize)]
pub struct GitUser {
    pub name: Option<String>,
    pub email: Option<String>,
}

#[tauri::command]
pub fn git_get_user(path: String) -> Result<GitUser, String> {
    let repo_root = resolve_repo_root(&path)?.unwrap_or(path);
    let name = git_stdout(&repo_root, &["config", "--get", "user.name"], "获取用户名")
        .ok()
        .filter(|value| !value.is_empty());
    let email = git_stdout(&repo_root, &["config", "--get", "user.email"], "获取用户邮箱")
        .ok()
        .filter(|value| !value.is_empty());

    Ok(GitUser { name, email })
}
