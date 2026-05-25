use crate::walker::walk_files;
use rayon::prelude::*;
use std::collections::HashMap;
use std::io;
use std::sync::atomic::{AtomicU32, Ordering};

const MAX_FILE_BYTES: u64 = 100 * 1024 * 1024; // 100 MB
const MAX_GROUPS: usize = 50;

/// 纯 Rust 的去重结果（在 lib.rs 中转换为 napi 对象）。
///
/// `scanned`、`skipped`、`duplicate_groups` 和 `total_wasted_bytes` 是整次
/// 扫描的全局总计。`groups` 出于展示考虑被限制为最多 `MAX_GROUPS` 个，
/// 因此 `groups.len()` 可能小于 `duplicate_groups`，且在大规模语料下
/// `groups` 中的大小之和不会等于 `total_wasted_bytes`。
#[derive(Debug)]
pub struct DedupOutput {
    pub scanned: u32,
    pub skipped: u32,
    pub duplicate_groups: u32,
    pub total_wasted_bytes: f64,
    /// 重复文件分组 (path, size)，按可回收字节数降序排列。
    pub groups: Vec<Vec<(String, u64)>>,
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

fn hash_file(path: &str) -> io::Result<blake3::Hash> {
    let mut hasher = blake3::Hasher::new();
    let mut file = std::fs::File::open(path)?;
    io::copy(&mut file, &mut hasher)?;
    Ok(hasher.finalize())
}

pub fn find_duplicates(
    root: &str,
    extensions: Option<&[String]>,
) -> Result<DedupOutput, String> {
    // 若根目录不可用则快速失败。
    let meta = std::fs::metadata(root).map_err(|e| tag_io_error(&e, root))?;
    if !meta.is_dir() {
        return Err(format!("[FS_NOT_FOUND] {} (not a directory)", root));
    }

    let (walked, walk_skipped) = walk_files(root, extensions);
    let skipped = AtomicU32::new(walk_skipped);

    // 候选文件：非空且 <= 100 MB。超大文件计入 skipped。
    let mut candidates: Vec<(String, u64)> = Vec::new();
    for w in walked {
        if w.size == 0 {
            continue; // 忽略，与旧行为保持一致
        }
        if w.size > MAX_FILE_BYTES {
            skipped.fetch_add(1, Ordering::Relaxed);
            continue;
        }
        candidates.push((w.path, w.size));
    }
    let scanned = candidates.len() as u32;

    // 按大小分桶；只有同一大小下多于 1 个文件时才可能存在重复。
    let mut by_size: HashMap<u64, Vec<String>> = HashMap::new();
    for (path, size) in candidates {
        by_size.entry(size).or_default().push(path);
    }
    let to_hash: Vec<(String, u64)> = by_size
        .into_iter()
        .filter(|(_, paths)| paths.len() > 1)
        .flat_map(|(size, paths)| paths.into_iter().map(move |p| (p, size)))
        .collect();

    // 并行哈希候选文件；读取错误计入 skipped。
    let hashed: Vec<(blake3::Hash, String, u64)> = to_hash
        .into_par_iter()
        .filter_map(|(path, size)| match hash_file(&path) {
            Ok(h) => Some((h, path, size)),
            Err(_) => {
                skipped.fetch_add(1, Ordering::Relaxed);
                None
            }
        })
        .collect();

    // 按哈希分组。
    let mut by_hash: HashMap<blake3::Hash, Vec<(String, u64)>> = HashMap::new();
    for (h, path, size) in hashed {
        by_hash.entry(h).or_default().push((path, size));
    }

    let mut groups: Vec<Vec<(String, u64)>> = by_hash
        .into_values()
        .filter(|g| g.len() > 1)
        .collect();

    // 按可回收字节数 (size * (count - 1)) 降序排序，
    // 以便 MAX_GROUPS 截断后保留真正最浪费空间的分组。
    groups.sort_by(|a, b| {
        let wa = a[0].1 as u128 * (a.len() as u128 - 1);
        let wb = b[0].1 as u128 * (b.len() as u128 - 1);
        wb.cmp(&wa)
    });

    let total_wasted_bytes: f64 = groups
        .iter()
        .map(|g| (g[0].1 as f64) * ((g.len() - 1) as f64))
        .sum();

    let duplicate_groups = groups.len() as u32;
    groups.truncate(MAX_GROUPS);

    Ok(DedupOutput {
        scanned,
        skipped: skipped.load(Ordering::Relaxed),
        duplicate_groups,
        total_wasted_bytes,
        groups,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    #[test]
    fn finds_duplicates_and_ignores_unique_sizes() {
        let dir = tempdir().unwrap();
        let root = dir.path();
        // 两个完全相同的文件（内容与大小一致）=> 一个重复分组。
        fs::write(root.join("a.bin"), b"DUPLICATE").unwrap();
        fs::write(root.join("b.bin"), b"DUPLICATE").unwrap();
        // 一个唯一文件。
        fs::write(root.join("c.bin"), b"unique-content").unwrap();
        // 空文件会被忽略。
        fs::write(root.join("empty.bin"), b"").unwrap();

        let out = find_duplicates(root.to_str().unwrap(), None).unwrap();
        assert_eq!(out.duplicate_groups, 1);
        assert_eq!(out.groups[0].len(), 2);
        assert_eq!(out.total_wasted_bytes, "DUPLICATE".len() as f64);
        // scanned = a、b、c（空文件被忽略）。
        assert_eq!(out.scanned, 3);
    }

    #[test]
    fn same_size_different_content_is_not_a_duplicate() {
        let dir = tempdir().unwrap();
        let root = dir.path();
        fs::write(root.join("x.bin"), b"AAAA").unwrap();
        fs::write(root.join("y.bin"), b"BBBB").unwrap(); // 相同大小，不同内容
        let out = find_duplicates(root.to_str().unwrap(), None).unwrap();
        assert_eq!(out.duplicate_groups, 0);
    }

    #[test]
    fn missing_root_returns_tagged_error() {
        let err = find_duplicates("/no/such/path/xyz", None).unwrap_err();
        assert!(err.starts_with("[FS_NOT_FOUND]"), "got: {}", err);
    }
}
