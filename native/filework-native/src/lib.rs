mod dedup;
mod walker;

use napi::bindgen_prelude::*;
use napi_derive::napi;

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
