use rayon::prelude::*;
use std::io;
use std::path::PathBuf;
use std::time::UNIX_EPOCH;

/// 单层目录扫描得到的一个条目元数据（在 lib.rs 中转换为 napi 对象）。
///
/// 刻意只暴露 stat 得到的原始事实，过滤（shouldIgnore）、扩展名计算、
/// 路径拼接与 mtime 转换都留在 TS 端（参见
/// `src/main/utils/incremental-scanner.ts` 的 scanDirectory）：
/// - `is_directory` 取自 dirent 类型，**不跟随符号链接**
///   （与 Node `Dirent.isDirectory()` 一致）
/// - `size` / `mtime_ms` 取自 `std::fs::metadata`，**跟随符号链接**
///   （与 Node `stat()` 一致）
#[derive(Debug)]
pub struct DirEntry {
    pub name: String,
    pub is_directory: bool,
    pub size: u64,
    pub mtime_ms: f64,
}

/// 将 io 错误映射为带方括号的标签，匹配 renderer 的 FS_ERROR_TAG 约定。
fn tag_io_error(err: &io::Error, path: &str) -> String {
    match err.kind() {
        io::ErrorKind::NotFound => format!("[FS_NOT_FOUND] {}", path),
        io::ErrorKind::PermissionDenied => format!("[FS_PERMISSION_DENIED] {}", path),
        _ => err.to_string(),
    }
}

/// 单层（非递归）扫描 `dir`，并行 stat 每个条目，返回其元数据。
///
/// 行为复刻 TS `scanDirectory`：
/// - `read_dir` 打开失败（不存在/无权限）返回带标签的错误
/// - `is_directory` 取自 dirent 类型（不跟随软链）
/// - `size` / `mtime_ms` 取自 `std::fs::metadata`（跟随软链）；
///   单个条目 stat 失败则跳过，与 TS 的 per-entry try/catch 一致
/// - 不做任何 ignore 过滤，过滤交给 TS
pub fn scan_dir_level(dir: &str) -> Result<Vec<DirEntry>, String> {
    let read_dir = std::fs::read_dir(dir).map_err(|e| tag_io_error(&e, dir))?;

    // 先顺序收集条目（read_dir 本身廉价），昂贵的 stat 留给并行阶段。
    // dirent 类型在此阶段确定，确保 is_directory 不跟随符号链接。
    let raw: Vec<(String, PathBuf, bool)> = read_dir
        .filter_map(|entry| {
            let entry = entry.ok()?;
            let name = entry.file_name().to_string_lossy().into_owned();
            let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
            Some((name, entry.path(), is_dir))
        })
        .collect();

    // 并行 stat：跟随软链取真实 size/mtime；无法 stat 的条目（如断链）跳过。
    let entries: Vec<DirEntry> = raw
        .into_par_iter()
        .filter_map(|(name, path, is_directory)| {
            let meta = std::fs::metadata(&path).ok()?;
            let mtime_ms = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                // 复刻 Node 的 stats.mtimeMs 公式 sec*1000 + nsec/1e6。
                // 不能用 as_nanos()/1e6——纳秒整数(~1.7e18)超过 f64 精确整数
                // 上限 2^53,会丢失精度，导致与 Node 写入的旧缓存不可比。
                .map(|d| d.as_secs() as f64 * 1_000.0 + d.subsec_nanos() as f64 / 1_000_000.0)
                .unwrap_or(0.0);
            Some(DirEntry {
                name,
                is_directory,
                size: meta.len(),
                mtime_ms,
            })
        })
        .collect();

    Ok(entries)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    fn find<'a>(v: &'a [DirEntry], name: &str) -> Option<&'a DirEntry> {
        v.iter().find(|e| e.name == name)
    }

    #[test]
    fn returns_files_with_size_and_dir_flag() {
        let dir = tempdir().unwrap();
        let root = dir.path();
        fs::write(root.join("a.txt"), b"hello").unwrap(); // 5
        fs::create_dir(root.join("sub")).unwrap();

        let entries = scan_dir_level(root.to_str().unwrap()).unwrap();
        assert_eq!(entries.len(), 2);

        let a = find(&entries, "a.txt").expect("a.txt present");
        assert!(!a.is_directory);
        assert_eq!(a.size, 5);

        let sub = find(&entries, "sub").expect("sub present");
        assert!(sub.is_directory);
    }

    #[test]
    fn is_single_level_not_recursive() {
        let dir = tempdir().unwrap();
        let root = dir.path();
        fs::create_dir(root.join("sub")).unwrap();
        fs::write(root.join("sub").join("deep.txt"), b"x").unwrap();

        let entries = scan_dir_level(root.to_str().unwrap()).unwrap();
        // 只应看到 sub，不应递归看到 deep.txt
        assert_eq!(entries.len(), 1);
        assert!(find(&entries, "deep.txt").is_none());
    }

    #[test]
    fn does_not_apply_ignore_filtering() {
        // 过滤是 TS 的职责;native 应原样返回 node_modules 等条目。
        let dir = tempdir().unwrap();
        let root = dir.path();
        fs::create_dir(root.join("node_modules")).unwrap();
        fs::write(root.join(".hidden"), b"h").unwrap();

        let entries = scan_dir_level(root.to_str().unwrap()).unwrap();
        assert!(find(&entries, "node_modules").is_some());
        assert!(find(&entries, ".hidden").is_some());
    }

    #[test]
    fn mtime_is_populated() {
        let dir = tempdir().unwrap();
        let root = dir.path();
        fs::write(root.join("f.bin"), b"data").unwrap();

        let entries = scan_dir_level(root.to_str().unwrap()).unwrap();
        let f = find(&entries, "f.bin").unwrap();
        assert!(f.mtime_ms > 0.0, "mtime_ms should be populated, got {}", f.mtime_ms);
    }

    #[test]
    fn missing_dir_returns_tagged_error() {
        let err = scan_dir_level("/no/such/path/xyz").unwrap_err();
        assert!(err.starts_with("[FS_NOT_FOUND]"), "got: {}", err);
    }
}
