use napi::bindgen_prelude::*;
use napi_derive::napi;
use std::env;
use std::ffi::OsString;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const DEFAULT_TIMEOUT_MS: u64 = 60_000;
const DEFAULT_THUMBNAIL_SIZE: u32 = 640;
static OFFICE_PREVIEW_QUEUE: Mutex<()> = Mutex::new(());

#[derive(Clone, Debug)]
#[napi(object)]
pub struct OfficePreviewRequest {
    pub source_path: String,
    pub cache_root: String,
    pub libre_office_path: Option<String>,
    pub quick_look_path: Option<String>,
    pub thumbnailer_path: Option<String>,
    pub timeout_ms: Option<u32>,
    pub thumbnail_size: Option<u32>,
}

#[derive(Clone, Debug)]
#[napi(object)]
pub struct OfficePreviewResult {
    pub cache_key: String,
    pub preview_kind: String,
    pub preview_path: String,
    pub pdf_path: Option<String>,
    pub thumbnail_path: Option<String>,
    pub source_mtime_ms: f64,
    pub source_size: f64,
    pub converter_version: String,
    pub cache_hit: bool,
}

#[derive(Clone, Debug)]
pub struct OfficePreviewFingerprint {
    pub cache_key: String,
    pub source_mtime_ms: f64,
    pub source_size: u64,
}

pub struct PrepareOfficePreviewTask {
    request: OfficePreviewRequest,
}

impl Task for PrepareOfficePreviewTask {
    type Output = OfficePreviewResult;
    type JsValue = OfficePreviewResult;

    fn compute(&mut self) -> Result<Self::Output> {
        prepare_office_preview(self.request.clone())
            .map_err(|msg| Error::new(Status::GenericFailure, msg))
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output)
    }
}

#[napi(ts_return_type = "Promise<OfficePreviewResult>")]
pub fn prepare_office_preview_native(
    request: OfficePreviewRequest,
) -> AsyncTask<PrepareOfficePreviewTask> {
    AsyncTask::new(PrepareOfficePreviewTask { request })
}

pub fn prepare_office_preview(
    request: OfficePreviewRequest,
) -> std::result::Result<OfficePreviewResult, String> {
    let source_path = PathBuf::from(&request.source_path);
    let cache_root = PathBuf::from(&request.cache_root);
    let timeout_ms = u64::from(request.timeout_ms.unwrap_or(DEFAULT_TIMEOUT_MS as u32));
    let thumbnail_size = request.thumbnail_size.unwrap_or(DEFAULT_THUMBNAIL_SIZE);
    fs::create_dir_all(&cache_root)
        .map_err(|e| format!("Failed to create Office preview cache root: {}", e))?;

    let (converter_path, converter_version) =
        match resolve_libre_office_path(request.libre_office_path.as_deref())
            .and_then(|path| read_converter_version(&path).map(|version| (path, version)))
        {
            Ok(resolved) => resolved,
            Err(converter_error) => {
                return prepare_quick_look_preview(
                    &request,
                    &source_path,
                    &cache_root,
                    timeout_ms,
                    thumbnail_size,
                )
                .map_err(|fallback_error| {
                    format!("{converter_error}. Quick Look fallback failed: {fallback_error}")
                });
            }
        };
    let fingerprint = build_office_preview_fingerprint(&source_path, &converter_version)?;
    let cache_dir = cache_root.join(&fingerprint.cache_key);
    let pdf_path = cache_dir.join("preview.pdf");
    let thumbnail_path = cache_dir.join("thumbnail.png");

    if pdf_path.is_file() {
        let thumbnail = ensure_thumbnail(
            &thumbnail_path,
            &pdf_path,
            request.thumbnailer_path.as_deref(),
            thumbnail_size,
            timeout_ms,
        )?;
        return Ok(result_from_paths(
            fingerprint,
            pdf_path,
            thumbnail,
            converter_version,
            true,
        ));
    }

    let queue_guard = OFFICE_PREVIEW_QUEUE
        .lock()
        .map_err(|_| "Office preview conversion queue is poisoned".to_string())?;

    if pdf_path.is_file() {
        let thumbnail = ensure_thumbnail(
            &thumbnail_path,
            &pdf_path,
            request.thumbnailer_path.as_deref(),
            thumbnail_size,
            timeout_ms,
        )?;
        return Ok(result_from_paths(
            fingerprint,
            pdf_path,
            thumbnail,
            converter_version,
            true,
        ));
    }

    fs::create_dir_all(&cache_dir)
        .map_err(|e| format!("Failed to create Office preview cache dir: {}", e))?;

    let job_dir = make_job_dir(&cache_root, &fingerprint.cache_key)?;
    let convert_result = convert_with_libreoffice(
        &converter_path,
        &source_path,
        &job_dir,
        &pdf_path,
        timeout_ms,
    );
    let cleanup_result = fs::remove_dir_all(&job_dir);
    if let Err(err) = convert_result {
        let _ = cleanup_result;
        drop(queue_guard);
        return prepare_quick_look_preview(
            &request,
            &source_path,
            &cache_root,
            timeout_ms,
            thumbnail_size,
        )
        .map_err(|fallback_error| format!("{err}. Quick Look fallback failed: {fallback_error}"));
    }
    if let Err(err) = cleanup_result {
        return Err(format!("Failed to clean Office preview temp dir: {}", err));
    }

    let thumbnail = ensure_thumbnail(
        &thumbnail_path,
        &pdf_path,
        request.thumbnailer_path.as_deref(),
        thumbnail_size,
        timeout_ms,
    )?;

    Ok(result_from_paths(
        fingerprint,
        pdf_path,
        thumbnail,
        converter_version,
        false,
    ))
}

fn prepare_quick_look_preview(
    request: &OfficePreviewRequest,
    source_path: &Path,
    cache_root: &Path,
    timeout_ms: u64,
    thumbnail_size: u32,
) -> std::result::Result<OfficePreviewResult, String> {
    let qlmanage = resolve_quick_look_path(request.quick_look_path.as_deref())?;
    let converter_version = "Quick Look thumbnail".to_string();
    let fingerprint = build_office_preview_fingerprint(source_path, &converter_version)?;
    let cache_dir = cache_root.join(&fingerprint.cache_key);
    let thumbnail_path = cache_dir.join("thumbnail.png");

    if thumbnail_path.is_file() {
        return Ok(result_from_image_path(
            fingerprint,
            thumbnail_path,
            converter_version,
            true,
        ));
    }

    let _queue_guard = OFFICE_PREVIEW_QUEUE
        .lock()
        .map_err(|_| "Office preview conversion queue is poisoned".to_string())?;

    if thumbnail_path.is_file() {
        return Ok(result_from_image_path(
            fingerprint,
            thumbnail_path,
            converter_version,
            true,
        ));
    }

    fs::create_dir_all(&cache_dir)
        .map_err(|e| format!("Failed to create Office preview cache dir: {}", e))?;
    generate_quick_look_thumbnail(
        &qlmanage,
        source_path,
        &thumbnail_path,
        thumbnail_size,
        timeout_ms,
    )?;

    Ok(result_from_image_path(
        fingerprint,
        thumbnail_path,
        converter_version,
        false,
    ))
}

pub fn build_office_preview_fingerprint(
    source_path: &Path,
    converter_version: &str,
) -> std::result::Result<OfficePreviewFingerprint, String> {
    let metadata = fs::metadata(source_path).map_err(|e| tag_io_error(&e, source_path))?;
    if !metadata.is_file() {
        return Err(format!(
            "Office preview source is not a file: {}",
            source_path.display()
        ));
    }
    let source_size = metadata.len();
    let source_mtime_ms = metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| {
            duration.as_secs() as f64 * 1_000.0 + duration.subsec_nanos() as f64 / 1_000_000.0
        })
        .unwrap_or(0.0);
    let file_hash = hash_file_hex(source_path)?;
    let canonical_path = fs::canonicalize(source_path)
        .unwrap_or_else(|_| source_path.to_path_buf())
        .to_string_lossy()
        .into_owned();
    let material = format!(
        "office-preview-v1\0{}\0{}\0{}\0{}\0{}",
        canonical_path, source_mtime_ms, source_size, file_hash, converter_version
    );
    let cache_key = blake3::hash(material.as_bytes()).to_hex().to_string();

    Ok(OfficePreviewFingerprint {
        cache_key,
        source_mtime_ms,
        source_size,
    })
}

fn tag_io_error(err: &io::Error, path: &Path) -> String {
    match err.kind() {
        io::ErrorKind::NotFound => format!("[FS_NOT_FOUND] {}", path.display()),
        io::ErrorKind::PermissionDenied => format!("[FS_PERMISSION_DENIED] {}", path.display()),
        _ => err.to_string(),
    }
}

fn hash_file_hex(path: &Path) -> std::result::Result<String, String> {
    let mut hasher = blake3::Hasher::new();
    let mut file = fs::File::open(path).map_err(|e| tag_io_error(&e, path))?;
    io::copy(&mut file, &mut hasher).map_err(|e| tag_io_error(&e, path))?;
    Ok(hasher.finalize().to_hex().to_string())
}

fn resolve_libre_office_path(explicit: Option<&str>) -> std::result::Result<PathBuf, String> {
    if let Some(path) = explicit {
        return Ok(PathBuf::from(path));
    }
    if let Ok(path) = env::var("FILEWORK_LIBREOFFICE_PATH") {
        if !path.trim().is_empty() {
            return Ok(PathBuf::from(path));
        }
    }
    for candidate in ["soffice", "libreoffice"] {
        if let Some(path) = find_on_path(candidate) {
            return Ok(path);
        }
    }
    let macos_default = PathBuf::from("/Applications/LibreOffice.app/Contents/MacOS/soffice");
    if macos_default.exists() {
        return Ok(macos_default);
    }
    Err(
        "LibreOffice headless converter not found. Install LibreOffice or set FILEWORK_LIBREOFFICE_PATH."
            .to_string(),
    )
}

fn resolve_quick_look_path(explicit: Option<&str>) -> std::result::Result<PathBuf, String> {
    if let Some(path) = explicit {
        return Ok(PathBuf::from(path));
    }
    if let Ok(path) = env::var("FILEWORK_QUICKLOOK_PATH") {
        if !path.trim().is_empty() {
            return Ok(PathBuf::from(path));
        }
    }
    let macos_default = PathBuf::from("/usr/bin/qlmanage");
    if macos_default.is_file() {
        return Ok(macos_default);
    }
    Err("Quick Look thumbnail generator not found at /usr/bin/qlmanage.".to_string())
}

fn find_on_path(command: &str) -> Option<PathBuf> {
    let path_var = env::var_os("PATH")?;
    env::split_paths(&path_var)
        .map(|dir| dir.join(command))
        .find(|path| path.is_file())
}

fn read_converter_version(path: &Path) -> std::result::Result<String, String> {
    let output = Command::new(path)
        .arg("--version")
        .stdin(Stdio::null())
        .output()
        .map_err(|e| format!("Failed to run LibreOffice version check: {}", e))?;
    if !output.status.success() {
        return Err(format!(
            "LibreOffice version check failed with status {}",
            output.status
        ));
    }
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if !stdout.is_empty() {
        return Ok(stdout);
    }
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    if !stderr.is_empty() {
        return Ok(stderr);
    }
    Ok("LibreOffice unknown".to_string())
}

fn make_job_dir(cache_root: &Path, cache_key: &str) -> std::result::Result<PathBuf, String> {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let job_dir = cache_root.join(format!(
        ".tmp-{}-{}-{}",
        cache_key,
        std::process::id(),
        nonce
    ));
    fs::create_dir_all(&job_dir)
        .map_err(|e| format!("Failed to create Office preview temp dir: {}", e))?;
    Ok(job_dir)
}

fn convert_with_libreoffice(
    converter_path: &Path,
    source_path: &Path,
    job_dir: &Path,
    pdf_path: &Path,
    timeout_ms: u64,
) -> std::result::Result<(), String> {
    let work_dir = job_dir.join("work");
    let profile_dir = job_dir.join("profile");
    fs::create_dir_all(&work_dir)
        .map_err(|e| format!("Failed to create Office preview work dir: {}", e))?;
    fs::create_dir_all(&profile_dir)
        .map_err(|e| format!("Failed to create Office preview profile dir: {}", e))?;

    let profile_arg = format!("-env:UserInstallation={}", file_url(&profile_dir));
    let args = vec![
        OsString::from("--headless"),
        OsString::from("--nologo"),
        OsString::from("--nolockcheck"),
        OsString::from("--nodefault"),
        OsString::from("--nofirststartwizard"),
        OsString::from("--norestore"),
        OsString::from(profile_arg),
        OsString::from("--convert-to"),
        OsString::from("pdf"),
        OsString::from("--outdir"),
        work_dir.as_os_str().to_os_string(),
        source_path.as_os_str().to_os_string(),
    ];
    run_command_with_timeout(
        converter_path,
        &args,
        timeout_ms,
        "Office preview conversion",
    )?;

    let expected_pdf = work_dir.join(format!(
        "{}.pdf",
        source_path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("preview")
    ));
    let converted_pdf = if expected_pdf.is_file() {
        expected_pdf
    } else {
        first_pdf_in_dir(&work_dir).ok_or_else(|| {
            format!(
                "LibreOffice conversion finished but did not produce a PDF in {}",
                work_dir.display()
            )
        })?
    };
    fs::rename(&converted_pdf, pdf_path)
        .or_else(|_| {
            fs::copy(&converted_pdf, pdf_path)?;
            fs::remove_file(&converted_pdf)
        })
        .map_err(|e| format!("Failed to publish Office preview PDF: {}", e))
}

fn file_url(path: &Path) -> String {
    let raw = path.to_string_lossy();
    let escaped = raw
        .replace('%', "%25")
        .replace(' ', "%20")
        .replace('#', "%23")
        .replace('?', "%3F");
    format!("file://{}", escaped)
}

fn first_pdf_in_dir(dir: &Path) -> Option<PathBuf> {
    fs::read_dir(dir)
        .ok()?
        .filter_map(|entry| entry.ok())
        .find_map(|entry| {
            let path = entry.path();
            let is_pdf = path
                .extension()
                .and_then(|ext| ext.to_str())
                .map(|ext| ext.eq_ignore_ascii_case("pdf"))
                .unwrap_or(false);
            if is_pdf {
                Some(path)
            } else {
                None
            }
        })
}

fn ensure_thumbnail(
    thumbnail_path: &Path,
    pdf_path: &Path,
    explicit_thumbnailer: Option<&str>,
    thumbnail_size: u32,
    timeout_ms: u64,
) -> std::result::Result<Option<PathBuf>, String> {
    if thumbnail_path.is_file() {
        return Ok(Some(thumbnail_path.to_path_buf()));
    }
    if let Some(thumbnailer) = explicit_thumbnailer {
        let args = vec![
            pdf_path.as_os_str().to_os_string(),
            thumbnail_path.as_os_str().to_os_string(),
            OsString::from(thumbnail_size.to_string()),
        ];
        run_command_with_timeout(
            Path::new(thumbnailer),
            &args,
            timeout_ms,
            "Office preview thumbnail generation",
        )?;
        return if thumbnail_path.is_file() {
            Ok(Some(thumbnail_path.to_path_buf()))
        } else {
            Err("Office preview thumbnailer finished without producing thumbnail.png".to_string())
        };
    }
    if try_qlmanage_thumbnail(pdf_path, thumbnail_path, thumbnail_size, timeout_ms) {
        return Ok(Some(thumbnail_path.to_path_buf()));
    }
    if try_pdftoppm_thumbnail(pdf_path, thumbnail_path, thumbnail_size, timeout_ms) {
        return Ok(Some(thumbnail_path.to_path_buf()));
    }
    Ok(None)
}

fn try_qlmanage_thumbnail(
    pdf_path: &Path,
    thumbnail_path: &Path,
    thumbnail_size: u32,
    timeout_ms: u64,
) -> bool {
    let qlmanage = PathBuf::from("/usr/bin/qlmanage");
    if !qlmanage.is_file() {
        return false;
    }
    generate_quick_look_thumbnail(
        &qlmanage,
        pdf_path,
        thumbnail_path,
        thumbnail_size,
        timeout_ms,
    )
    .is_ok()
}

fn generate_quick_look_thumbnail(
    qlmanage: &Path,
    source_path: &Path,
    thumbnail_path: &Path,
    thumbnail_size: u32,
    timeout_ms: u64,
) -> std::result::Result<(), String> {
    let Some(out_dir) = thumbnail_path.parent() else {
        return Err("Office preview thumbnail path has no parent directory".to_string());
    };
    let ql_dir = out_dir.join(".ql-thumbnail");
    fs::create_dir_all(&ql_dir)
        .map_err(|e| format!("Failed to create Quick Look thumbnail dir: {}", e))?;
    let args = vec![
        OsString::from("-t"),
        OsString::from("-s"),
        OsString::from(thumbnail_size.to_string()),
        OsString::from("-o"),
        ql_dir.as_os_str().to_os_string(),
        source_path.as_os_str().to_os_string(),
    ];
    if let Err(err) = run_command_with_timeout(qlmanage, &args, timeout_ms, "Quick Look thumbnail")
    {
        let _ = fs::remove_dir_all(&ql_dir);
        return Err(err);
    }
    let generated = fs::read_dir(&ql_dir).ok().and_then(|entries| {
        entries.filter_map(|entry| entry.ok()).find_map(|entry| {
            let path = entry.path();
            if path.extension().and_then(|ext| ext.to_str()) == Some("png") {
                Some(path)
            } else {
                None
            }
        })
    });
    let Some(generated) = generated else {
        let _ = fs::remove_dir_all(&ql_dir);
        return Err("Quick Look finished without producing a PNG thumbnail".to_string());
    };
    fs::rename(&generated, thumbnail_path)
        .or_else(|_| {
            fs::copy(&generated, thumbnail_path)?;
            fs::remove_file(&generated)
        })
        .map_err(|e| format!("Failed to publish Quick Look thumbnail: {}", e))?;
    let _ = fs::remove_dir_all(&ql_dir);
    if thumbnail_path.is_file() {
        Ok(())
    } else {
        Err("Quick Look thumbnail was not written".to_string())
    }
}

fn try_pdftoppm_thumbnail(
    pdf_path: &Path,
    thumbnail_path: &Path,
    thumbnail_size: u32,
    timeout_ms: u64,
) -> bool {
    let Some(pdftoppm) = find_on_path("pdftoppm") else {
        return false;
    };
    let Some(out_dir) = thumbnail_path.parent() else {
        return false;
    };
    let prefix = out_dir.join("thumbnail-work");
    let generated = out_dir.join("thumbnail-work.png");
    let args = vec![
        OsString::from("-f"),
        OsString::from("1"),
        OsString::from("-singlefile"),
        OsString::from("-png"),
        OsString::from("-scale-to"),
        OsString::from(thumbnail_size.to_string()),
        pdf_path.as_os_str().to_os_string(),
        prefix.as_os_str().to_os_string(),
    ];
    if run_command_with_timeout(&pdftoppm, &args, timeout_ms, "pdftoppm thumbnail").is_err() {
        return false;
    }
    fs::rename(&generated, thumbnail_path).is_ok() && thumbnail_path.is_file()
}

fn run_command_with_timeout(
    program: &Path,
    args: &[OsString],
    timeout_ms: u64,
    label: &str,
) -> std::result::Result<(), String> {
    let mut child = Command::new(program)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("Failed to start {}: {}", label, e))?;
    let deadline = Instant::now() + Duration::from_millis(timeout_ms);
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                return if status.success() {
                    Ok(())
                } else {
                    Err(format!("{} failed with status {}", label, status))
                };
            }
            Ok(None) => {
                if Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(format!("{} timed out after {}ms", label, timeout_ms));
                }
                thread::sleep(Duration::from_millis(20));
            }
            Err(err) => return Err(format!("Failed while waiting for {}: {}", label, err)),
        }
    }
}

fn result_from_paths(
    fingerprint: OfficePreviewFingerprint,
    pdf_path: PathBuf,
    thumbnail_path: Option<PathBuf>,
    converter_version: String,
    cache_hit: bool,
) -> OfficePreviewResult {
    let pdf_path = pdf_path.to_string_lossy().into_owned();
    OfficePreviewResult {
        cache_key: fingerprint.cache_key,
        preview_kind: "pdf".to_string(),
        preview_path: pdf_path.clone(),
        pdf_path: Some(pdf_path),
        thumbnail_path: thumbnail_path.map(|p| p.to_string_lossy().into_owned()),
        source_mtime_ms: fingerprint.source_mtime_ms,
        source_size: fingerprint.source_size as f64,
        converter_version,
        cache_hit,
    }
}

fn result_from_image_path(
    fingerprint: OfficePreviewFingerprint,
    image_path: PathBuf,
    converter_version: String,
    cache_hit: bool,
) -> OfficePreviewResult {
    let image_path = image_path.to_string_lossy().into_owned();
    OfficePreviewResult {
        cache_key: fingerprint.cache_key,
        preview_kind: "image".to_string(),
        preview_path: image_path.clone(),
        pdf_path: None,
        thumbnail_path: Some(image_path),
        source_mtime_ms: fingerprint.source_mtime_ms,
        source_size: fingerprint.source_size as f64,
        converter_version,
        cache_hit,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::io;
    use std::path::{Path, PathBuf};
    use std::thread;
    use tempfile::tempdir;

    #[cfg(unix)]
    fn write_executable(path: &Path, body: &str) -> io::Result<()> {
        use std::os::unix::fs::PermissionsExt;

        fs::write(path, body)?;
        let mut perms = fs::metadata(path)?.permissions();
        perms.set_mode(0o755);
        fs::set_permissions(path, perms)
    }

    fn request(
        source_path: PathBuf,
        cache_root: PathBuf,
        office_path: PathBuf,
    ) -> OfficePreviewRequest {
        OfficePreviewRequest {
            source_path: source_path.to_string_lossy().into_owned(),
            cache_root: cache_root.to_string_lossy().into_owned(),
            libre_office_path: Some(office_path.to_string_lossy().into_owned()),
            quick_look_path: None,
            thumbnailer_path: None,
            timeout_ms: Some(3_000),
            thumbnail_size: Some(320),
        }
    }

    #[test]
    fn cache_key_changes_when_converter_version_changes() {
        let dir = tempdir().unwrap();
        let source = dir.path().join("budget.xlsx");
        fs::write(&source, b"sheet-data").unwrap();

        let first = build_office_preview_fingerprint(&source, "LibreOffice 24.2").unwrap();
        let second = build_office_preview_fingerprint(&source, "LibreOffice 25.0").unwrap();

        assert_ne!(first.cache_key, second.cache_key);
        assert_eq!(first.source_size, 10);
        assert!(first.source_mtime_ms > 0.0);
    }

    #[cfg(unix)]
    #[test]
    fn converts_office_to_cached_pdf_and_thumbnail_with_isolated_profile() {
        let dir = tempdir().unwrap();
        let source = dir.path().join("Deck File.pptx");
        let cache = dir.path().join("cache");
        let office = dir.path().join("fake-soffice");
        let thumb = dir.path().join("fake-thumb");
        let args_log = dir.path().join("args.log");
        fs::write(&source, b"slides").unwrap();
        write_executable(
            &office,
            &format!(
                r#"#!/bin/sh
if [ "$1" = "--version" ]; then
  echo "LibreOffice 24.2.1"
  exit 0
fi
printf '%s\n' "$@" > '{}'
outdir=""
input=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--outdir" ]; then
    shift
    outdir="$1"
  else
    input="$1"
  fi
  shift
done
base="$(basename "$input")"
stem="${{base%.*}}"
printf 'PDF:%s' "$input" > "$outdir/$stem.pdf"
"#,
                args_log.display(),
            ),
        )
        .unwrap();
        write_executable(
            &thumb,
            r#"#!/bin/sh
printf 'PNG:%s:%s' "$1" "$3" > "$2"
"#,
        )
        .unwrap();

        let mut req = request(source, cache, office);
        req.thumbnailer_path = Some(thumb.to_string_lossy().into_owned());

        let first = prepare_office_preview(req.clone()).unwrap();
        assert!(!first.cache_hit);
        assert!(Path::new(first.pdf_path.as_ref().unwrap()).exists());
        assert!(Path::new(first.thumbnail_path.as_ref().unwrap()).exists());
        assert_eq!(first.converter_version, "LibreOffice 24.2.1");

        let args = fs::read_to_string(args_log).unwrap();
        assert!(args.contains("--headless"));
        assert!(args.contains("--convert-to"));
        assert!(args.contains("-env:UserInstallation=file://"));

        let second = prepare_office_preview(req).unwrap();
        assert!(second.cache_hit);
        assert_eq!(second.pdf_path, first.pdf_path);
        assert_eq!(second.thumbnail_path, first.thumbnail_path);
    }

    #[cfg(unix)]
    #[test]
    fn falls_back_to_quick_look_image_preview_when_libreoffice_is_unavailable() {
        let dir = tempdir().unwrap();
        let source = dir.path().join("Deck File.pptx");
        let cache = dir.path().join("cache");
        let missing_office = dir.path().join("missing-soffice");
        let qlmanage = dir.path().join("fake-qlmanage");
        fs::write(&source, b"slides").unwrap();
        write_executable(
            &qlmanage,
            r#"#!/bin/sh
outdir=""
input=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "-o" ]; then
    shift
    outdir="$1"
  else
    input="$1"
  fi
  shift
done
base="$(basename "$input")"
printf 'PNG:%s' "$input" > "$outdir/$base.png"
"#,
        )
        .unwrap();

        let mut req = request(source, cache, missing_office);
        req.quick_look_path = Some(qlmanage.to_string_lossy().into_owned());

        let first = prepare_office_preview(req.clone()).unwrap();
        assert!(!first.cache_hit);
        assert_eq!(first.preview_kind, "image");
        assert!(first.pdf_path.is_none());
        assert!(Path::new(&first.preview_path).exists());
        assert_eq!(first.thumbnail_path.as_ref(), Some(&first.preview_path));
        assert_eq!(first.converter_version, "Quick Look thumbnail");

        let second = prepare_office_preview(req).unwrap();
        assert!(second.cache_hit);
        assert_eq!(second.preview_path, first.preview_path);
    }

    #[cfg(unix)]
    #[test]
    fn falls_back_to_quick_look_image_preview_when_libreoffice_conversion_fails() {
        let dir = tempdir().unwrap();
        let source = dir.path().join("Broken Deck.pptx");
        let cache = dir.path().join("cache");
        let office = dir.path().join("failing-soffice");
        let qlmanage = dir.path().join("fake-qlmanage");
        fs::write(&source, b"slides").unwrap();
        write_executable(
            &office,
            r#"#!/bin/sh
if [ "$1" = "--version" ]; then
  echo "LibreOffice 24.2.1"
  exit 0
fi
echo "conversion failed" >&2
exit 2
"#,
        )
        .unwrap();
        write_executable(
            &qlmanage,
            r#"#!/bin/sh
outdir=""
input=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "-o" ]; then
    shift
    outdir="$1"
  else
    input="$1"
  fi
  shift
done
base="$(basename "$input")"
printf 'PNG:%s' "$input" > "$outdir/$base.png"
"#,
        )
        .unwrap();

        let mut req = request(source, cache, office);
        req.quick_look_path = Some(qlmanage.to_string_lossy().into_owned());

        let result = prepare_office_preview(req).unwrap();
        assert_eq!(result.preview_kind, "image");
        assert!(result.pdf_path.is_none());
        assert!(Path::new(&result.preview_path).exists());
        assert_eq!(result.converter_version, "Quick Look thumbnail");
    }

    #[cfg(unix)]
    #[test]
    fn kills_converter_when_timeout_elapses() {
        let dir = tempdir().unwrap();
        let source = dir.path().join("slow.docx");
        let cache = dir.path().join("cache");
        let office = dir.path().join("slow-soffice");
        fs::write(&source, b"document").unwrap();
        write_executable(
            &office,
            r#"#!/bin/sh
if [ "$1" = "--version" ]; then
  echo "LibreOffice slow"
  exit 0
fi
sleep 2
"#,
        )
        .unwrap();

        let mut req = request(source, cache, office);
        req.timeout_ms = Some(100);

        let err = prepare_office_preview(req).unwrap_err();
        assert!(err.contains("timed out"), "got: {err}");
    }

    #[cfg(unix)]
    #[test]
    fn serializes_conversion_cache_misses() {
        let dir = tempdir().unwrap();
        let cache = dir.path().join("cache");
        let office = dir.path().join("queued-soffice");
        let state = dir.path().join("state");
        fs::create_dir(&state).unwrap();
        let collision = state.join("collision");
        let running = state.join("running");
        let source_a = dir.path().join("a.docx");
        let source_b = dir.path().join("b.docx");
        fs::write(&source_a, b"a").unwrap();
        fs::write(&source_b, b"b").unwrap();
        write_executable(
            &office,
            &format!(
                r#"#!/bin/sh
if [ "$1" = "--version" ]; then
  echo "LibreOffice queued"
  exit 0
fi
if [ -e '{}' ]; then
  echo collision > '{}'
  exit 7
fi
touch '{}'
sleep 0.2
outdir=""
input=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--outdir" ]; then
    shift
    outdir="$1"
  else
    input="$1"
  fi
  shift
done
base="$(basename "$input")"
stem="${{base%.*}}"
printf 'PDF:%s' "$input" > "$outdir/$stem.pdf"
rm -f '{}'
"#,
                running.display(),
                collision.display(),
                running.display(),
                running.display(),
            ),
        )
        .unwrap();

        let req_a = request(source_a, cache.clone(), office.clone());
        let req_b = request(source_b, cache, office);
        let a = thread::spawn(move || prepare_office_preview(req_a));
        let b = thread::spawn(move || prepare_office_preview(req_b));

        assert!(a.join().unwrap().is_ok());
        assert!(b.join().unwrap().is_ok());
        assert!(!collision.exists());
    }
}
