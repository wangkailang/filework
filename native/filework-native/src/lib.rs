mod dedup;
mod scan;
mod search;
mod stats;
mod walker;

use napi::bindgen_prelude::*;
use napi_derive::napi;
use std::collections::HashMap;

#[napi(object)]
pub struct FileEntry {
    pub path: String,
    pub size: f64,
}

#[napi(object)]
pub struct DuplicateResult {
    pub scanned: u32,
    pub skipped: u32,
    pub duplicate_groups: u32,
    pub total_wasted_bytes: f64,
    pub groups: Vec<Vec<FileEntry>>,
}

impl From<dedup::DedupOutput> for DuplicateResult {
    fn from(o: dedup::DedupOutput) -> Self {
        let groups = o
            .groups
            .into_iter()
            .map(|g| {
                g.into_iter()
                    .map(|(path, size)| FileEntry {
                        path,
                        size: size as f64,
                    })
                    .collect()
            })
            .collect();
        DuplicateResult {
            scanned: o.scanned,
            skipped: o.skipped,
            duplicate_groups: o.duplicate_groups,
            total_wasted_bytes: o.total_wasted_bytes,
            groups,
        }
    }
}

pub struct FindDuplicatesTask {
    root: String,
    extensions: Option<Vec<String>>,
}

impl Task for FindDuplicatesTask {
    type Output = dedup::DedupOutput;
    type JsValue = DuplicateResult;

    fn compute(&mut self) -> Result<Self::Output> {
        dedup::find_duplicates(&self.root, self.extensions.as_deref())
            .map_err(|msg| Error::new(Status::GenericFailure, msg))
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output.into())
    }
}

#[napi(ts_return_type = "Promise<DuplicateResult>")]
pub fn find_duplicates(
    root_path: String,
    extensions: Option<Vec<String>>,
) -> AsyncTask<FindDuplicatesTask> {
    AsyncTask::new(FindDuplicatesTask {
        root: root_path,
        extensions,
    })
}

#[napi(object)]
pub struct DirectoryStats {
    pub total_files: u32,
    pub total_dirs: u32,
    pub total_size: f64,
    pub extensions: HashMap<String, u32>,
}

impl From<stats::DirStats> for DirectoryStats {
    fn from(s: stats::DirStats) -> Self {
        DirectoryStats {
            total_files: s.total_files,
            total_dirs: s.total_dirs,
            total_size: s.total_size as f64,
            extensions: s.extensions,
        }
    }
}

pub struct DirectoryStatsTask {
    root: String,
}

impl Task for DirectoryStatsTask {
    type Output = stats::DirStats;
    type JsValue = DirectoryStats;

    fn compute(&mut self) -> Result<Self::Output> {
        stats::compute_dir_stats(&self.root)
            .map_err(|msg| Error::new(Status::GenericFailure, msg))
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output.into())
    }
}

#[napi(ts_return_type = "Promise<DirectoryStats>")]
pub fn directory_stats(root_path: String) -> AsyncTask<DirectoryStatsTask> {
    AsyncTask::new(DirectoryStatsTask { root: root_path })
}

#[napi(object)]
pub struct DirEntryInfo {
    pub name: String,
    pub is_directory: bool,
    pub size: f64,
    pub mtime_ms: f64,
}

impl From<scan::DirEntry> for DirEntryInfo {
    fn from(e: scan::DirEntry) -> Self {
        DirEntryInfo {
            name: e.name,
            is_directory: e.is_directory,
            size: e.size as f64,
            mtime_ms: e.mtime_ms,
        }
    }
}

pub struct ScanDirLevelTask {
    dir: String,
}

impl Task for ScanDirLevelTask {
    type Output = Vec<scan::DirEntry>;
    type JsValue = Vec<DirEntryInfo>;

    fn compute(&mut self) -> Result<Self::Output> {
        scan::scan_dir_level(&self.dir).map_err(|msg| Error::new(Status::GenericFailure, msg))
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output.into_iter().map(Into::into).collect())
    }
}

#[napi(ts_return_type = "Promise<Array<DirEntryInfo>>")]
pub fn scan_directory_level(dir_path: String) -> AsyncTask<ScanDirLevelTask> {
    AsyncTask::new(ScanDirLevelTask { dir: dir_path })
}

#[napi(object)]
pub struct SearchOptions {
    /// 扩展名白名单(带或不带前导点均可,转小写比较,如 "pdf" / ".pdf")。
    pub extensions: Option<Vec<String>>,
    pub min_size: Option<f64>,
    pub max_size: Option<f64>,
    pub modified_after_ms: Option<f64>,
    pub modified_before_ms: Option<f64>,
    /// 返回上限,默认 100。
    pub limit: Option<u32>,
}

#[napi(object)]
pub struct SearchHitInfo {
    pub name: String,
    /// 相对于搜索根的 POSIX 风格相对路径。
    pub rel_path: String,
    pub size: f64,
    pub mtime_ms: f64,
    pub score: f64,
}

#[napi(object)]
pub struct SearchResult {
    pub hits: Vec<SearchHitInfo>,
    pub total_matched: u32,
    pub truncated: bool,
}

impl From<search::SearchHit> for SearchHitInfo {
    fn from(h: search::SearchHit) -> Self {
        SearchHitInfo {
            name: h.name,
            rel_path: h.rel_path,
            size: h.size as f64,
            mtime_ms: h.mtime_ms,
            score: h.score,
        }
    }
}

impl From<search::SearchOutput> for SearchResult {
    fn from(o: search::SearchOutput) -> Self {
        SearchResult {
            hits: o.hits.into_iter().map(Into::into).collect(),
            total_matched: o.total_matched,
            truncated: o.truncated,
        }
    }
}

pub struct SearchFilesTask {
    root: String,
    query: String,
    options: Option<SearchOptions>,
}

impl Task for SearchFilesTask {
    type Output = search::SearchOutput;
    type JsValue = SearchResult;

    fn compute(&mut self) -> Result<Self::Output> {
        let opts = self.options.take();
        let filters = search::SearchFilters {
            extensions: opts.as_ref().and_then(|o| o.extensions.clone()),
            min_size: opts.as_ref().and_then(|o| o.min_size).map(|v| v as u64),
            max_size: opts.as_ref().and_then(|o| o.max_size).map(|v| v as u64),
            modified_after_ms: opts.as_ref().and_then(|o| o.modified_after_ms),
            modified_before_ms: opts.as_ref().and_then(|o| o.modified_before_ms),
        };
        let limit = opts.as_ref().and_then(|o| o.limit).unwrap_or(100) as usize;
        Ok(search::search_files(&self.root, &self.query, &filters, limit))
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output.into())
    }
}

#[napi(ts_return_type = "Promise<SearchResult>")]
pub fn search_files(
    root_path: String,
    query: String,
    options: Option<SearchOptions>,
) -> AsyncTask<SearchFilesTask> {
    AsyncTask::new(SearchFilesTask {
        root: root_path,
        query,
        options,
    })
}
