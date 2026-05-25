use crate::walker::walk_files;
use rayon::prelude::*;
use std::collections::HashMap;
use std::io;
use std::sync::atomic::{AtomicU32, Ordering};

const MAX_FILE_BYTES: u64 = 100 * 1024 * 1024; // 100 MB
const MAX_GROUPS: usize = 50;

/// Plain-Rust dedup result (converted to a napi object in lib.rs).
#[derive(Debug)]
pub struct DedupOutput {
    pub scanned: u32,
    pub skipped: u32,
    pub duplicate_groups: u32,
    pub total_wasted_bytes: f64,
    /// Each group is a list of (path, size), groups sorted by wasted space desc.
    pub groups: Vec<Vec<(String, u64)>>,
}

/// Map an io error to a tagged message matching the renderer's FS_ERROR_TAG.
fn tag_io_error(err: &io::Error, path: &str) -> String {
    match err.kind() {
        io::ErrorKind::NotFound => format!("FS_NOT_FOUND {}", path),
        io::ErrorKind::PermissionDenied => format!("FS_PERMISSION_DENIED {}", path),
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
    // Fail fast if the root is unusable.
    let meta = std::fs::metadata(root).map_err(|e| tag_io_error(&e, root))?;
    if !meta.is_dir() {
        return Err(format!("FS_NOT_FOUND {} (not a directory)", root));
    }

    let (walked, walk_skipped) = walk_files(root, extensions);
    let skipped = AtomicU32::new(walk_skipped);

    // Candidates: non-empty, <= 100 MB. Oversized files count as skipped.
    let mut candidates: Vec<(String, u64)> = Vec::new();
    for w in walked {
        if w.size == 0 {
            continue; // ignored, matches old behavior
        }
        if w.size > MAX_FILE_BYTES {
            skipped.fetch_add(1, Ordering::Relaxed);
            continue;
        }
        candidates.push((w.path, w.size));
    }
    let scanned = candidates.len() as u32;

    // Bucket by size; only sizes with >1 file can contain duplicates.
    let mut by_size: HashMap<u64, Vec<String>> = HashMap::new();
    for (path, size) in candidates {
        by_size.entry(size).or_default().push(path);
    }
    let to_hash: Vec<(String, u64)> = by_size
        .into_iter()
        .filter(|(_, paths)| paths.len() > 1)
        .flat_map(|(size, paths)| paths.into_iter().map(move |p| (p, size)))
        .collect();

    // Hash candidates in parallel; read errors count as skipped.
    let hashed: Vec<(blake3::Hash, String, u64)> = to_hash
        .par_iter()
        .filter_map(|(path, size)| match hash_file(path) {
            Ok(h) => Some((h, path.clone(), *size)),
            Err(_) => {
                skipped.fetch_add(1, Ordering::Relaxed);
                None
            }
        })
        .collect();

    // Group by hash.
    let mut by_hash: HashMap<blake3::Hash, Vec<(String, u64)>> = HashMap::new();
    for (h, path, size) in hashed {
        by_hash.entry(h).or_default().push((path, size));
    }

    let mut groups: Vec<Vec<(String, u64)>> = by_hash
        .into_values()
        .filter(|g| g.len() > 1)
        .collect();

    // Sort by wasted space (size * count) descending.
    groups.sort_by(|a, b| {
        let wa = a[0].1 as u128 * a.len() as u128;
        let wb = b[0].1 as u128 * b.len() as u128;
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
        // Two identical files (same content + size) => one duplicate group.
        fs::write(root.join("a.bin"), b"DUPLICATE").unwrap();
        fs::write(root.join("b.bin"), b"DUPLICATE").unwrap();
        // A unique file.
        fs::write(root.join("c.bin"), b"unique-content").unwrap();
        // Empty file is ignored.
        fs::write(root.join("empty.bin"), b"").unwrap();

        let out = find_duplicates(root.to_str().unwrap(), None).unwrap();
        assert_eq!(out.duplicate_groups, 1);
        assert_eq!(out.groups[0].len(), 2);
        assert_eq!(out.total_wasted_bytes, "DUPLICATE".len() as f64);
        // scanned = a, b, c (empty ignored).
        assert_eq!(out.scanned, 3);
    }

    #[test]
    fn same_size_different_content_is_not_a_duplicate() {
        let dir = tempdir().unwrap();
        let root = dir.path();
        fs::write(root.join("x.bin"), b"AAAA").unwrap();
        fs::write(root.join("y.bin"), b"BBBB").unwrap(); // same size, different bytes
        let out = find_duplicates(root.to_str().unwrap(), None).unwrap();
        assert_eq!(out.duplicate_groups, 0);
    }

    #[test]
    fn missing_root_returns_tagged_error() {
        let err = find_duplicates("/no/such/path/xyz", None).unwrap_err();
        assert!(err.starts_with("FS_NOT_FOUND"), "got: {}", err);
    }
}
