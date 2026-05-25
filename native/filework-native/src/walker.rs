use jwalk::WalkDir;
use std::path::Path;

/// 遍历器发现的一个文件，附带其字节大小。
pub struct Walked {
    pub path: String,
    pub size: u64,
}

/// 递归遍历 `root`，返回通过过滤条件的常规文件，
/// 以及因遍历/元数据错误而跳过的条目数。
///
/// 应用的过滤规则：
/// - 跳过文件名以 `.` 开头的文件。注意：隐藏*目录*仍会被深入遍历，
///   其中非隐藏的文件仍会被返回。这是为了刻意保持与被替换的 TS
///   duplicate-finder 行为一致。
/// - 跳过路径中包含 `/.filework/` 或 `/node_modules/` 的条目
/// - 若 `extensions` 为 `Some` 且非空，仅保留扩展名匹配的文件
///   （转小写后比较，带前导点，例如 `.jpg`）
pub fn walk_files(root: &str, extensions: Option<&[String]>) -> (Vec<Walked>, u32) {
    let mut files = Vec::new();
    let mut skipped: u32 = 0;

    let exts_lower: Option<Vec<String>> = extensions.map(|list| {
        list.iter()
            .filter(|e| !e.is_empty())
            .map(|e| e.to_lowercase())
            .collect()
    });

    for entry in WalkDir::new(root).skip_hidden(false) {
        let entry = match entry {
            Ok(e) => e,
            Err(_) => {
                skipped += 1;
                continue;
            }
        };

        if !entry.file_type().is_file() {
            continue;
        }

        if entry.file_name().to_string_lossy().starts_with('.') {
            continue;
        }

        let path = entry.path();

        // 扩展名过滤只需要路径的扩展名，因此在分配完整路径字符串之前先做，
        // 这样被这里拒绝的文件就不必承担下面 `to_string_lossy` 的分配开销。
        if let Some(ref exts) = exts_lower {
            if !exts.is_empty() && !match_extension(&path, exts) {
                continue;
            }
        }

        let path_str = path.to_string_lossy().into_owned();
        if path_str.contains("/.filework/") || path_str.contains("/node_modules/") {
            continue;
        }

        let size = match entry.metadata() {
            Ok(m) => m.len(),
            Err(_) => {
                skipped += 1;
                continue;
            }
        };

        files.push(Walked { path: path_str, size });
    }

    (files, skipped)
}

fn match_extension(path: &Path, exts_lower: &[String]) -> bool {
    match path.extension().and_then(|e| e.to_str()) {
        Some(ext) => {
            let with_dot = format!(".{}", ext.to_lowercase());
            exts_lower.iter().any(|e| *e == with_dot)
        }
        None => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    #[test]
    fn skips_hidden_files_and_ignored_dirs() {
        let dir = tempdir().unwrap();
        let root = dir.path();
        fs::write(root.join("a.txt"), b"hello").unwrap();
        fs::write(root.join(".hidden"), b"secret").unwrap();
        fs::create_dir(root.join("node_modules")).unwrap();
        fs::write(root.join("node_modules").join("pkg.txt"), b"x").unwrap();

        let (files, skipped) = walk_files(root.to_str().unwrap(), None);
        let names: Vec<&str> = files.iter().map(|f| f.path.as_str()).collect();
        assert_eq!(files.len(), 1, "only a.txt should pass, got {:?}", names);
        assert!(files[0].path.ends_with("a.txt"));
        assert_eq!(files[0].size, 5);
        assert_eq!(skipped, 0, "clean tree should skip nothing");
    }

    #[test]
    fn filters_by_extension() {
        let dir = tempdir().unwrap();
        let root = dir.path();
        fs::write(root.join("photo.JPG"), b"img").unwrap();
        fs::write(root.join("notes.txt"), b"text").unwrap();

        let exts = vec![".jpg".to_string()];
        let (files, _) = walk_files(root.to_str().unwrap(), Some(&exts));
        assert_eq!(files.len(), 1);
        assert!(files[0].path.ends_with("photo.JPG"));
    }
}
