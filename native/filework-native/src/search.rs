use crate::walker::is_ignored_path;
use jwalk::WalkDir;
use std::path::Path;
use std::time::UNIX_EPOCH;

/// 搜索命中的一个文件条目。路径为相对于搜索根的 POSIX 风格相对路径,
/// 与 listDirectory 返回的 WorkspaceEntry.path 语义一致。
#[derive(Debug)]
pub struct SearchHit {
    pub name: String,
    pub rel_path: String,
    pub size: u64,
    pub mtime_ms: f64,
    /// 相关度评分,越大越靠前;纯过滤(空 query)时为 0。
    pub score: f64,
}

/// 搜索过滤条件。全部可选;为 None 表示该维度不过滤。
#[derive(Default)]
pub struct SearchFilters {
    /// 扩展名白名单(带前导点、转小写后比较,如 ".pdf")。
    pub extensions: Option<Vec<String>>,
    pub min_size: Option<u64>,
    pub max_size: Option<u64>,
    pub modified_after_ms: Option<f64>,
    pub modified_before_ms: Option<f64>,
}

pub struct SearchOutput {
    pub hits: Vec<SearchHit>,
    /// 过滤/匹配后的总命中数(可能多于 hits.len(),因为 hits 受 limit 截断)。
    pub total_matched: u32,
    pub truncated: bool,
}

/// 在 `root` 下递归搜索文件。`query` 为空时退化为纯元数据过滤(按扩展名/
/// 大小/修改时间),非空时按空白拆分为词元,要求每个词元都出现在相对路径
/// (含文件名)中,并据"命中文件名 > 仅命中路径"打分。结果按评分降序、
/// 同分按路径升序返回,截断到 `limit`。
///
/// 过滤规则复刻 walker:跳过以 `.` 开头的文件,跳过 `.filework` /
/// `node_modules` 目录内部条目。
pub fn search_files(
    root: &str,
    query: &str,
    filters: &SearchFilters,
    limit: usize,
) -> SearchOutput {
    let query_lower = query.trim().to_lowercase();
    let tokens: Vec<&str> = query_lower.split_whitespace().collect();
    let first_token = tokens.first().copied();

    let exts_lower: Option<Vec<String>> = filters.extensions.as_ref().map(|list| {
        list.iter()
            .filter(|e| !e.is_empty())
            .map(|e| {
                let l = e.to_lowercase();
                if l.starts_with('.') {
                    l
                } else {
                    format!(".{}", l)
                }
            })
            .collect()
    });

    let root_path = Path::new(root);
    let mut hits: Vec<SearchHit> = Vec::new();

    for entry in WalkDir::new(root).skip_hidden(false) {
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue,
        };
        if !entry.file_type().is_file() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') {
            continue;
        }

        let abs = entry.path();
        let abs_str = abs.to_string_lossy();
        if is_ignored_path(&abs_str) {
            continue;
        }

        // 扩展名过滤(在 stat 之前,省去不匹配文件的元数据开销)。
        if let Some(ref exts) = exts_lower {
            if !exts.is_empty() && !match_ext(&name, exts) {
                continue;
            }
        }

        let meta = match entry.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        let size = meta.len();
        if let Some(min) = filters.min_size {
            if size < min {
                continue;
            }
        }
        if let Some(max) = filters.max_size {
            if size > max {
                continue;
            }
        }

        let mtime_ms = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_secs() as f64 * 1_000.0 + d.subsec_nanos() as f64 / 1_000_000.0)
            .unwrap_or(0.0);
        if let Some(after) = filters.modified_after_ms {
            if mtime_ms < after {
                continue;
            }
        }
        if let Some(before) = filters.modified_before_ms {
            if mtime_ms > before {
                continue;
            }
        }

        // 相对路径(POSIX 风格),与 WorkspaceEntry.path 对齐。
        let rel_path = abs
            .strip_prefix(root_path)
            .unwrap_or(&abs)
            .to_string_lossy()
            .replace('\\', "/");

        // 文本匹配 + 打分。空 query 退化为纯过滤(全部命中,评分 0)。
        let score = if tokens.is_empty() {
            0.0
        } else {
            match score_match(&name, &rel_path, &tokens, &query_lower, first_token) {
                Some(s) => s,
                None => continue,
            }
        };

        hits.push(SearchHit {
            name,
            rel_path,
            size,
            mtime_ms,
            score,
        });
    }

    let total_matched = hits.len() as u32;

    // 评分降序;同分按相对路径升序,保证结果稳定。
    hits.sort_by(|a, b| {
        b.score
            .partial_cmp(&a.score)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| a.rel_path.cmp(&b.rel_path))
    });

    let truncated = hits.len() > limit;
    if truncated {
        hits.truncate(limit);
    }

    SearchOutput {
        hits,
        total_matched,
        truncated,
    }
}

fn match_ext(name: &str, exts_lower: &[String]) -> bool {
    match Path::new(name).extension().and_then(|e| e.to_str()) {
        Some(ext) => {
            let with_dot = format!(".{}", ext.to_lowercase());
            exts_lower.iter().any(|e| *e == with_dot)
        }
        None => false,
    }
}

/// 要求每个词元都出现在文件名或相对路径中(AND 语义);命中文件名权重高于
/// 仅命中路径。返回 None 表示未全部命中,该文件被排除。
fn score_match(
    name: &str,
    rel_path: &str,
    tokens: &[&str],
    query_lower: &str,
    first_token: Option<&str>,
) -> Option<f64> {
    let name_lower = name.to_lowercase();
    let rel_lower = rel_path.to_lowercase();
    let mut score = 0.0;
    for t in tokens {
        if name_lower.contains(t) {
            score += 2.0;
        } else if rel_lower.contains(t) {
            score += 1.0;
        } else {
            return None;
        }
    }
    if name_lower == query_lower {
        score += 5.0;
    }
    if let Some(first) = first_token {
        if name_lower.starts_with(first) {
            score += 1.0;
        }
    }
    Some(score)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    fn names(out: &SearchOutput) -> Vec<&str> {
        out.hits.iter().map(|h| h.name.as_str()).collect()
    }

    #[test]
    fn matches_by_name_and_ranks_name_over_path() {
        let dir = tempdir().unwrap();
        let root = dir.path();
        fs::create_dir(root.join("report")).unwrap();
        fs::write(root.join("report").join("notes.txt"), b"x").unwrap(); // path 命中 "report"
        fs::write(root.join("report.txt"), b"x").unwrap(); // name 命中 "report"

        let out = search_files(
            root.to_str().unwrap(),
            "report",
            &SearchFilters::default(),
            100,
        );
        assert_eq!(out.total_matched, 2);
        // report.txt(命中文件名)应排在 notes.txt(仅命中路径)之前。
        assert_eq!(names(&out)[0], "report.txt");
    }

    #[test]
    fn empty_query_is_pure_filter() {
        let dir = tempdir().unwrap();
        let root = dir.path();
        fs::write(root.join("a.pdf"), b"x").unwrap();
        fs::write(root.join("b.txt"), b"x").unwrap();

        let filters = SearchFilters {
            extensions: Some(vec![".pdf".to_string()]),
            ..Default::default()
        };
        let out = search_files(root.to_str().unwrap(), "", &filters, 100);
        assert_eq!(out.total_matched, 1);
        assert_eq!(names(&out)[0], "a.pdf");
    }

    #[test]
    fn all_tokens_must_match() {
        let dir = tempdir().unwrap();
        let root = dir.path();
        fs::write(root.join("annual-report.txt"), b"x").unwrap();
        fs::write(root.join("report.txt"), b"x").unwrap();

        let out = search_files(
            root.to_str().unwrap(),
            "annual report",
            &SearchFilters::default(),
            100,
        );
        assert_eq!(out.total_matched, 1);
        assert_eq!(names(&out)[0], "annual-report.txt");
    }

    #[test]
    fn skips_hidden_and_ignored() {
        let dir = tempdir().unwrap();
        let root = dir.path();
        fs::write(root.join("keep.txt"), b"x").unwrap();
        fs::write(root.join(".hidden.txt"), b"x").unwrap();
        fs::create_dir(root.join("node_modules")).unwrap();
        fs::write(root.join("node_modules").join("dep.txt"), b"x").unwrap();

        let out = search_files(root.to_str().unwrap(), "", &SearchFilters::default(), 100);
        assert_eq!(out.total_matched, 1);
        assert_eq!(names(&out)[0], "keep.txt");
    }

    #[test]
    fn truncates_to_limit() {
        let dir = tempdir().unwrap();
        let root = dir.path();
        for i in 0..10 {
            fs::write(root.join(format!("f{i}.txt")), b"x").unwrap();
        }
        let out = search_files(root.to_str().unwrap(), "", &SearchFilters::default(), 3);
        assert_eq!(out.total_matched, 10);
        assert!(out.truncated);
        assert_eq!(out.hits.len(), 3);
    }
}
