use jwalk::WalkDir;
use std::path::Path;

/// A file discovered by the walker, with its size in bytes.
pub struct Walked {
    pub path: String,
    pub size: u64,
}

/// Walk `root` recursively, returning regular files that pass the filters,
/// plus a count of entries skipped due to traversal/metadata errors.
///
/// Filters applied:
/// - skip entries whose name starts with `.`
/// - skip any path containing `/.filework/` or `/node_modules/`
/// - if `extensions` is `Some` and non-empty, keep only matching extensions
///   (compared lowercase, with leading dot, e.g. `.jpg`)
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

        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') {
            continue;
        }

        let path = entry.path();
        let path_str = path.to_string_lossy().to_string();
        if path_str.contains("/.filework/") || path_str.contains("/node_modules/") {
            continue;
        }

        if let Some(ref exts) = exts_lower {
            if !exts.is_empty() && !match_extension(&path, exts) {
                continue;
            }
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

        let (files, _skipped) = walk_files(root.to_str().unwrap(), None);
        let names: Vec<&str> = files.iter().map(|f| f.path.as_str()).collect();
        assert_eq!(files.len(), 1, "only a.txt should pass, got {:?}", names);
        assert!(files[0].path.ends_with("a.txt"));
        assert_eq!(files[0].size, 5);
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
