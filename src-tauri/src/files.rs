//! All storage paths are derived from validated opaque IDs, never renderer paths.
use crate::error::{AppError, Result};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File},
    io::{Read, Write},
    path::{Path, PathBuf},
};

pub const MAX_ASSET_BYTES: u64 = 64 * 1024 * 1024;
pub const MAX_EXPORT_BYTES: u64 = 256 * 1024 * 1024;
pub const MAX_DATABASE_BYTES: u64 = 512 * 1024 * 1024;
pub const MAX_BACKUP_BYTES: u64 = 8 * 1024 * 1024 * 1024;

pub fn validate_id(id: &str) -> Result<()> {
    // Lowercase only avoids aliases/collisions on Windows and common macOS volumes.
    if id.is_empty()
        || id.len() > 100
        || !id
            .bytes()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-' || c == b'_')
        || matches!(id, "con" | "prn" | "aux" | "nul")
        || (id.len() == 4
            && (id.starts_with("com") || id.starts_with("lpt"))
            && id.as_bytes()[3].is_ascii_digit())
    {
        return Err(AppError::invalid("id", "IDs must be lowercase ASCII letters, numbers, hyphens or underscores, at most 100 characters, and not reserved filenames."));
    }
    Ok(())
}
pub fn validate_hash(hash: &str) -> Result<()> {
    if hash.len() != 64
        || !hash
            .bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
    {
        return Err(AppError::invalid(
            "assetId",
            "An asset ID must be a SHA-256 digest.",
        ));
    }
    Ok(())
}
pub fn validate_filename(name: &str) -> Result<()> {
    if name.is_empty()
        || name.len() > 240
        || name.trim() != name
        || name.ends_with('.')
        || name
            .chars()
            .any(|c| c.is_control() || "/\\:<>\"|?*".contains(c))
        || name == "."
        || name == ".."
    {
        return Err(AppError::invalid(
            "filename",
            "Provide a plain filename without paths or control characters.",
        ));
    }
    let stem = name.split('.').next().unwrap_or("").to_ascii_lowercase();
    if matches!(stem.as_str(), "con" | "prn" | "aux" | "nul")
        || (stem.len() == 4
            && (stem.starts_with("com") || stem.starts_with("lpt"))
            && stem.as_bytes()[3].is_ascii_digit())
    {
        return Err(AppError::invalid(
            "filename",
            "This filename is reserved by the operating system.",
        ));
    }
    Ok(())
}
pub fn validate_mime(mime: &str) -> Result<()> {
    if mime.len() > 150
        || !mime.contains('/')
        || !mime
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"/+.-_".contains(&c))
    {
        return Err(AppError::invalid(
            "mimeType",
            "Provide a plain MIME type without parameters.",
        ));
    }
    Ok(())
}
pub fn hash_bytes(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

pub fn check_path(path: &Path, directory: bool) -> Result<()> {
    let meta = fs::symlink_metadata(path)?;
    if meta.file_type().is_symlink()
        || (directory && !meta.is_dir())
        || (!directory && !meta.is_file())
    {
        return Err(AppError::new(
            "PATH_SCOPE",
            "Storage paths must be regular files or directories, never links or special files.",
        ));
    }
    // Windows reparse points also include junctions that are not necessarily symlinks.
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if meta.file_attributes() & 0x400 != 0 {
            return Err(AppError::new(
                "PATH_SCOPE",
                "Reparse points are not allowed in storage.",
            ));
        }
    }
    Ok(())
}
pub fn child_dir(parent: &Path, name: &str, create: bool) -> Result<PathBuf> {
    check_path(parent, true)?;
    let path = parent.join(name);
    if create && !path.try_exists()? {
        fs::create_dir(&path)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&path, fs::Permissions::from_mode(0o700))?;
        }
        sync_dir(parent)?;
    }
    check_path(&path, true)?;
    if path.canonicalize()?.parent() != Some(parent.canonicalize()?.as_path()) {
        return Err(AppError::new(
            "PATH_SCOPE",
            "Storage directory escaped its parent.",
        ));
    }
    Ok(path)
}
pub fn check_optional_file(path: &Path) -> Result<()> {
    match fs::symlink_metadata(path) {
        Ok(_) => check_path(path, false),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.into()),
    }
}
pub fn read_bounded(path: &Path, limit: u64) -> Result<Vec<u8>> {
    check_path(path, false)?;
    let file = File::open(path)?;
    if file.metadata()?.len() > limit {
        return Err(AppError::new(
            "LIMIT_EXCEEDED",
            "The file exceeds the supported size limit.",
        ));
    }
    let mut bytes = Vec::new();
    file.take(limit + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > limit {
        return Err(AppError::new(
            "LIMIT_EXCEEDED",
            "The file exceeds the supported size limit.",
        ));
    }
    Ok(bytes)
}
pub fn read_verified(path: &Path, hash: &str, size: u64) -> Result<Vec<u8>> {
    validate_hash(hash)?;
    if size > MAX_ASSET_BYTES {
        return Err(AppError::integrity());
    }
    let bytes = read_bounded(path, MAX_ASSET_BYTES)?;
    if bytes.len() as u64 != size || hash_bytes(&bytes) != hash {
        return Err(AppError::integrity());
    }
    Ok(bytes)
}
pub fn sync_file(path: &Path) -> Result<()> {
    check_path(path, false)?;
    // Windows FlushFileBuffers requires a writable handle. Opening without
    // create/truncate preserves the SQLite snapshot while flushing it.
    std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(path)?
        .sync_all()?;
    Ok(())
}
pub fn sync_dir(path: &Path) -> Result<()> {
    #[cfg(unix)]
    {
        File::open(path)?.sync_all()?;
    }
    // Windows has no supported std directory FlushFileBuffers. Files are flushed before replacement.
    #[cfg(not(unix))]
    {
        let _ = path;
    }
    Ok(())
}
pub fn atomic_write(path: &Path, bytes: &[u8], overwrite: bool) -> Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| AppError::new("PATH_SCOPE", "No destination directory."))?;
    check_path(parent, true)?;
    check_optional_file(path)?;
    let mut staged = tempfile::NamedTempFile::new_in(parent)?;
    staged.write_all(bytes)?;
    staged.as_file().sync_all()?;
    if overwrite {
        staged.persist(path).map_err(|e| AppError::from(e.error))?;
    } else {
        staged
            .persist_noclobber(path)
            .map_err(|e| AppError::from(e.error))?;
    }
    sync_dir(parent)
}
pub fn publish_dir(stage: tempfile::TempDir, destination: &Path) -> Result<()> {
    if fs::symlink_metadata(destination).is_ok() {
        return Err(AppError::conflict());
    }
    sync_dir(stage.path())?;
    fs::rename(stage.path(), destination)?;
    sync_dir(destination.parent().ok_or_else(AppError::integrity)?)?;
    // TempDir now refers to the absent staging path, never the published path.
    Ok(())
}
pub fn directory_size(path: &Path) -> Result<u64> {
    check_path(path, true)?;
    let mut size = 0u64;
    for entry in fs::read_dir(path)? {
        let path = entry?.path();
        let meta = fs::symlink_metadata(&path)?;
        if meta.is_dir() {
            size = size
                .checked_add(directory_size(&path)?)
                .ok_or_else(AppError::integrity)?;
        } else {
            check_path(&path, false)?;
            size = size
                .checked_add(meta.len())
                .ok_or_else(AppError::integrity)?;
        }
    }
    Ok(size)
}
