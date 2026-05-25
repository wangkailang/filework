use crate::walker::is_ignored_path;
use jwalk::WalkDir;
use std::collections::HashMap;
use std::io;
use std::path::Path;

/// 目录统计的纯 Rust 结果（在 lib.rs 中转换为 napi 对象）。
///
/// 字段语义刻意与被替换的 TS `fs:directoryStats` 保持一致
/// （参见 `src/main/ipc/file-handlers.ts`）：
/// - `total_files` / `total_dirs`：递归遍历下通过过滤的文件数 / 目录数
/// - `total_size`：所有计入文件的字节大小之和
/// - `extensions`：扩展名直方图，**区分大小写**（如 `.JPG`），
///   无扩展名记为 `(no ext)`
#[derive(Debug)]
pub struct DirStats {
    pub total_files: u32,
    pub total_dirs: u32,
    pub total_size: u64,
    pub extensions: HashMap<String, u32>,
}

/// 将 io 错误映射为带方括号的标签，匹配 renderer 的 FS_ERROR_TAG
/// 约定（参见 `src/main/ipc/file-handlers.ts`）。
fn tag_io_error(err: &io::Error, path: &str) -> String {
    match err.kind() {
        io::ErrorKind::NotFound => format!("[FS_NOT_FOUND] {}", path),
        io::ErrorKind::PermissionDenied => format!("[FS_PERMISSION_DENIED] {}", path),
        _ => err.to_string(),
    }
}

/// 取扩展名（保留原始大小写、带前导点），无扩展名时返回 `(no ext)`，
/// 复刻 TS 的 `extname(name) || "(no ext)"`。
fn extension_key(path: &Path) -> String {
    match path.extension().and_then(|e| e.to_str()) {
        Some(ext) if !ext.is_empty() => format!(".{}", ext),
        _ => "(no ext)".to_string(),
    }
}

/// 单次遍历 `root`，统计文件数、目录数、总字节数与扩展名直方图。
/// 过滤规则与被替换的 TS `fs:directoryStats` 一致：
/// - 跳过基名以 `.` 开头的条目（文件与目录皆然），但仍深入隐藏目录，
///   其中的非隐藏条目照常计入
/// - 跳过路径落在 `/.filework/` 或 `/node_modules/` 内部的条目；
///   这两个目录**自身**仍会被计入 `total_dirs`
pub fn compute_dir_stats(root: &str) -> Result<DirStats, String> {
    // 若根目录不可用则快速失败，并返回带标签的错误。
    let meta = std::fs::metadata(root).map_err(|e| tag_io_error(&e, root))?;
    if !meta.is_dir() {
        return Err(format!("[FS_NOT_FOUND] {} (not a directory)", root));
    }

    let mut total_files: u32 = 0;
    let mut total_dirs: u32 = 0;
    let mut total_size: u64 = 0;
    let mut extensions: HashMap<String, u32> = HashMap::new();

    // skip_hidden(false)：自行处理隐藏判定，使隐藏目录的非隐藏内容仍被遍历。
    // WalkDir 默认包含 root 自身条目，需排除以免把根目录计入 total_dirs。
    for entry in WalkDir::new(root).skip_hidden(false) {
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue, // 无法读取的条目直接跳过，与 TS 的 try/catch 一致
        };

        let path = entry.path();
        if path.as_os_str() == Path::new(root).as_os_str() {
            continue; // 跳过 root 自身
        }

        // 基名隐藏判定（文件与目录都适用）。
        if entry.file_name().to_string_lossy().starts_with('.') {
            continue;
        }

        let path_str = path.to_string_lossy();
        if is_ignored_path(&path_str) {
            continue;
        }

        let file_type = entry.file_type();
        if file_type.is_dir() {
            total_dirs += 1;
        } else if file_type.is_file() {
            // 跟随符号链接语义无关：常规文件用 metadata 取真实大小。
            let size = match entry.metadata() {
                Ok(m) => m.len(),
                Err(_) => continue, // 无法 stat 的文件跳过，与 TS catch 一致
            };
            total_files += 1;
            total_size += size;
            *extensions.entry(extension_key(&path)).or_insert(0) += 1;
        }
        // 其他类型（符号链接等）忽略。
    }

    Ok(DirStats {
        total_files,
        total_dirs,
        total_size,
        extensions,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    #[test]
    fn counts_files_dirs_size_and_extensions() {
        let dir = tempdir().unwrap();
        let root = dir.path();
        fs::write(root.join("a.txt"), b"hello").unwrap(); // 5
        fs::write(root.join("b.txt"), b"hey").unwrap(); // 3
        fs::create_dir(root.join("sub")).unwrap();
        fs::write(root.join("sub").join("c.md"), b"docs").unwrap(); // 4

        let s = compute_dir_stats(root.to_str().unwrap()).unwrap();
        assert_eq!(s.total_files, 3);
        assert_eq!(s.total_dirs, 1);
        assert_eq!(s.total_size, 12);
        assert_eq!(s.extensions.get(".txt"), Some(&2));
        assert_eq!(s.extensions.get(".md"), Some(&1));
    }

    #[test]
    fn hidden_dir_not_counted_but_children_counted() {
        let dir = tempdir().unwrap();
        let root = dir.path();
        fs::create_dir(root.join(".git")).unwrap();
        fs::write(root.join(".git").join("config"), b"x").unwrap();
        fs::write(root.join("visible.txt"), b"yy").unwrap();

        let s = compute_dir_stats(root.to_str().unwrap()).unwrap();
        // .git 目录名以 . 开头 -> 不计入 total_dirs
        assert_eq!(s.total_dirs, 0);
        // 但其中非隐藏文件仍被计入：config (no ext) + visible.txt
        assert_eq!(s.total_files, 2);
        assert_eq!(s.extensions.get("(no ext)"), Some(&1));
        assert_eq!(s.extensions.get(".txt"), Some(&1));
    }

    #[test]
    fn node_modules_dir_counted_but_contents_skipped() {
        let dir = tempdir().unwrap();
        let root = dir.path();
        fs::create_dir(root.join("node_modules")).unwrap();
        fs::write(root.join("node_modules").join("pkg.js"), b"code").unwrap();

        let s = compute_dir_stats(root.to_str().unwrap()).unwrap();
        // node_modules 目录本身路径不含 "/node_modules/" -> 计入目录
        assert_eq!(s.total_dirs, 1);
        // 其内容路径含 "/node_modules/" -> 跳过
        assert_eq!(s.total_files, 0);
    }

    #[test]
    fn filework_contents_skipped() {
        let dir = tempdir().unwrap();
        let root = dir.path();
        fs::create_dir(root.join(".filework")).unwrap();
        fs::write(root.join(".filework").join("data.bin"), b"zzzz").unwrap();
        fs::write(root.join("keep.log"), b"k").unwrap();

        let s = compute_dir_stats(root.to_str().unwrap()).unwrap();
        // .filework 目录名隐藏 -> 不计;其内容路径含 "/.filework/" -> 跳过
        assert_eq!(s.total_dirs, 0);
        assert_eq!(s.total_files, 1);
        assert_eq!(s.extensions.get(".log"), Some(&1));
    }

    #[test]
    fn extension_case_preserved_and_no_ext() {
        let dir = tempdir().unwrap();
        let root = dir.path();
        // 基名不同、扩展名大小写不同：验证直方图区分大小写。
        // （注意：macOS 默认大小写不敏感，不能只靠大小写区分文件名。）
        fs::write(root.join("alpha.JPG"), b"i").unwrap();
        fs::write(root.join("beta.jpg"), b"i").unwrap();
        fs::write(root.join("README"), b"r").unwrap();
        fs::write(root.join("archive.tar.gz"), b"g").unwrap();

        let s = compute_dir_stats(root.to_str().unwrap()).unwrap();
        assert_eq!(s.total_files, 4);
        assert_eq!(s.extensions.get(".JPG"), Some(&1));
        assert_eq!(s.extensions.get(".jpg"), Some(&1));
        assert_eq!(s.extensions.get("(no ext)"), Some(&1));
        assert_eq!(s.extensions.get(".gz"), Some(&1));
    }

    #[test]
    fn missing_root_returns_tagged_error() {
        let err = compute_dir_stats("/no/such/path/xyz").unwrap_err();
        assert!(err.starts_with("[FS_NOT_FOUND]"), "got: {}", err);
    }
}
