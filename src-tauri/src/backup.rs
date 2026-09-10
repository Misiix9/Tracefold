use crate::{
    error::{AppError, Result},
    files::*,
    model::*,
    schema,
    store::{sequence, Workspace},
};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    fs::{self, File},
    io::{Read, Write},
    path::Path,
    time::Duration,
};

const MAGIC: &[u8; 8] = b"TFBK\r\n\x1a\n";
const MAX_HEADER: u64 = 16 * 1024 * 1024;

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PortableHeader {
    kind: String,
    version: u32,
    database_size: u64,
    manifest: Manifest,
}

impl PortableHeader {
    fn validate(&self) -> Result<u64> {
        let m = &self.manifest;
        if self.kind != "tracefold-backup"
            || self.version != 1
            || m.version != 1
            || self.database_size == 0
            || self.database_size > MAX_DATABASE_BYTES
            || m.assets.len() > 100_000
        {
            return Err(AppError::integrity());
        }
        validate_id(&m.info.id)?;
        validate_id(&m.info.project_id)?;
        validate_hash(&m.database_hash)?;
        let mut total = self.database_size;
        let mut ids = HashSet::new();
        for asset in &m.assets {
            validate_hash(&asset.id)?;
            validate_hash(&asset.hash)?;
            validate_filename(&asset.filename)?;
            validate_mime(&asset.mime_type)?;
            if asset.id != asset.hash || asset.size > MAX_ASSET_BYTES || !ids.insert(&asset.id) {
                return Err(AppError::integrity());
            }
            total = total
                .checked_add(asset.size)
                .ok_or_else(AppError::integrity)?;
        }
        if total > MAX_BACKUP_BYTES || total != m.info.size {
            return Err(AppError::integrity());
        }
        Ok(total)
    }
}

/// Copy one bounded frame with constant memory. The caller owns its staging destination.
fn copy_frame(
    reader: &mut impl Read,
    writer: &mut impl Write,
    size: u64,
    hash: &str,
) -> Result<()> {
    let mut remaining = size;
    let mut buffer = [0u8; 64 * 1024];
    let mut digest = Sha256::new();
    while remaining > 0 {
        let count = remaining.min(buffer.len() as u64) as usize;
        reader.read_exact(&mut buffer[..count])?;
        digest.update(&buffer[..count]);
        writer.write_all(&buffer[..count])?;
        remaining -= count as u64;
    }
    if format!("{:x}", digest.finalize()) != hash {
        return Err(AppError::integrity());
    }
    Ok(())
}

fn copy_file(path: &Path, writer: &mut impl Write, size: u64, hash: &str) -> Result<()> {
    check_path(path, false)?;
    let mut input = File::open(path)?;
    if input.metadata()?.len() != size {
        return Err(AppError::integrity());
    }
    copy_frame(&mut input, writer, size, hash)?;
    let mut tail = [0u8; 1];
    if input.read(&mut tail)? != 0 {
        return Err(AppError::integrity());
    }
    Ok(())
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Manifest {
    version: u32,
    info: BackupInfo,
    database_hash: String,
    assets: Vec<Asset>,
    #[serde(default)]
    origin: BackupOrigin,
}

#[derive(Clone, Copy, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum BackupOrigin {
    #[default]
    Manual,
    Automatic,
}

/// Keep the union of ten recent intervals, seven daily points and four ISO weeks.
/// Manual and legacy snapshots are outside automatic retention and never expire.
fn retained_automatic(manifests: &[Manifest]) -> HashSet<String> {
    let mut ordered: Vec<_> = manifests.iter().filter(|m| m.origin == BackupOrigin::Automatic).collect();
    ordered.sort_by(|a, b| b.info.created_at.cmp(&a.info.created_at));
    let mut keep = HashSet::new();
    let mut days = HashSet::new();
    let mut weeks = HashSet::new();
    for (index, manifest) in ordered.iter().enumerate() {
        let Ok(at) = chrono::DateTime::parse_from_rfc3339(&manifest.info.created_at) else {
            keep.insert(manifest.info.id.clone());
            continue;
        };
        let at = at.with_timezone(&chrono::Utc);
        let day = at.format("%Y-%m-%d").to_string();
        let week = at.format("%G-%V").to_string();
        let daily = days.len() < 7 && days.insert(day);
        let weekly = weeks.len() < 4 && weeks.insert(week);
        if index < 10 || daily || weekly { keep.insert(manifest.info.id.clone()); }
    }
    keep
}

impl Workspace {
    pub fn export_backup_file(&self, id: &str, project_id: &str, destination: &Path) -> Result<()> {
        let (dir, manifest) = self.backup_manifest(id, project_id)?;
        let database = dir.join("workspace.sqlite");
        check_path(&database, false)?;
        let header = PortableHeader {
            kind: "tracefold-backup".into(),
            version: 1,
            database_size: database.metadata()?.len(),
            manifest,
        };
        header.validate()?;
        let json = serde_json::to_vec(&header)?;
        if json.len() as u64 > MAX_HEADER {
            return Err(AppError::integrity());
        }
        let parent = destination.parent().ok_or_else(AppError::integrity)?;
        check_path(parent, true)?;
        check_optional_file(destination)?;
        let mut stage = tempfile::NamedTempFile::new_in(parent)?;
        stage.write_all(MAGIC)?;
        stage.write_all(&1u32.to_le_bytes())?;
        stage.write_all(&(json.len() as u32).to_le_bytes())?;
        stage.write_all(&json)?;
        copy_file(
            &database,
            &mut stage,
            header.database_size,
            &header.manifest.database_hash,
        )?;
        let blobs = child_dir(&self.root, "backup-blobs", false)?;
        for asset in &header.manifest.assets {
            copy_file(&blobs.join(&asset.id), &mut stage, asset.size, &asset.hash)?;
        }
        stage.as_file().sync_all()?;
        stage
            .persist(destination)
            .map_err(|error| AppError::from(error.error))?;
        sync_dir(parent)
    }

    pub fn restore_backup_file(&self, source: &Path) -> Result<Project> {
        check_path(source, false)?;
        let mut input = File::open(source)?;
        let length = input.metadata()?.len();
        if length > MAX_BACKUP_BYTES + MAX_HEADER + 16 || length < 16 {
            return Err(AppError::integrity());
        }
        let mut prefix = [0u8; 16];
        input.read_exact(&mut prefix)?;
        let version = u32::from_le_bytes(prefix[8..12].try_into().unwrap());
        let header_size = u32::from_le_bytes(prefix[12..16].try_into().unwrap()) as u64;
        if &prefix[..8] != MAGIC || version != 1 || header_size == 0 || header_size > MAX_HEADER {
            return Err(AppError::integrity());
        }
        let mut json = vec![0u8; header_size as usize];
        input.read_exact(&mut json)?;
        let header: PortableHeader = serde_json::from_slice(&json)?;
        if header.validate()? + header_size + 16 != length {
            return Err(AppError::integrity());
        }
        let stage = tempfile::Builder::new()
            .prefix(".backup-import-")
            .tempdir_in(self.projects_dir()?)?;
        let database = stage.path().join("workspace.sqlite");
        let mut output = File::create(&database)?;
        copy_frame(
            &mut input,
            &mut output,
            header.database_size,
            &header.manifest.database_hash,
        )?;
        output.sync_all()?;
        drop(output);
        let assets = child_dir(stage.path(), "assets", true)?;
        for asset in &header.manifest.assets {
            let mut output = File::create(assets.join(&asset.id))?;
            copy_frame(&mut input, &mut output, asset.size, &asset.hash)?;
            output.sync_all()?;
        }
        let mut tail = [0u8; 1];
        if input.read(&mut tail)? != 0 {
            return Err(AppError::integrity());
        }
        let m = &header.manifest;
        self.restore_snapshot(&m.info.id, &m.info.project_id, stage.path(), m, &assets)
    }
    pub(crate) fn before_write(&self, project_id: &str) -> Result<()> {
        if !self.get_settings()?.backup_enabled {
            return Ok(());
        }
        let conn = self.project_db(project_id)?;
        let seq = sequence(&conn)?;
        use rusqlite::OptionalExtension;
        let last: Option<(String, u64)> = self
            .catalog
            .query_row(
                "SELECT last_at,sequence FROM backup_state WHERE project_id=?1",
                [project_id],
                |r| Ok((r.get(0)?, r.get::<_, i64>(1)? as u64)),
            )
            .optional()?;
        let due = match last {
            None => true,
            Some((at, previous)) => {
                let current = chrono::Utc::now();
                let elapsed = chrono::DateTime::parse_from_rfc3339(&at)
                    .map(|then| current.signed_duration_since(then).num_minutes())
                    .unwrap_or(30);
                seq != previous && (elapsed >= 30 || at.get(..10) != now().get(..10))
            }
        };
        if due {
            self.create_backup_with_origin(project_id, BackupOrigin::Automatic)?;
        }
        Ok(())
    }
    pub fn create_backup(&self, project_id: &str) -> Result<BackupInfo> {
        self.create_backup_with_origin(project_id, BackupOrigin::Manual)
    }
    fn create_backup_with_origin(&self, project_id: &str, origin: BackupOrigin) -> Result<BackupInfo> {
        let source = self.project_db(project_id)?;
        let project = Self::owned_project(&source, project_id)?;
        let root = child_dir(&self.root, "backups", false)?;
        let stage = tempfile::Builder::new()
            .prefix(".backup-")
            .tempdir_in(&root)?;
        let path = stage.path().join("workspace.sqlite");
        let mut copy = Connection::open(&path)?;
        {
            let backup = rusqlite::backup::Backup::new(&source, &mut copy)?;
            backup.run_to_completion(128, Duration::from_millis(5), None)?;
        }
        schema::integrity(&copy)?;
        let sequence = sequence(&copy)?;
        let payloads = copy
            .prepare("SELECT payload FROM assets ORDER BY id")?
            .query_map([], |r| r.get::<_, String>(0))?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        let assets = payloads
            .iter()
            .map(|p| serde_json::from_str::<Asset>(p))
            .collect::<std::result::Result<Vec<_>, _>>()?;
        let blobs = child_dir(&self.root, "backup-blobs", false)?;
        let source_assets = child_dir(&self.project_dir(project_id)?, "assets", false)?;
        let mut size = path.metadata()?.len();
        for asset in &assets {
            let bytes = read_verified(&source_assets.join(&asset.id), &asset.hash, asset.size)?;
            size = size
                .checked_add(asset.size)
                .ok_or_else(AppError::integrity)?;
            if size > MAX_BACKUP_BYTES {
                return Err(AppError::new(
                    "LIMIT_EXCEEDED",
                    "Backup exceeds the supported size.",
                ));
            }
            let destination = blobs.join(&asset.id);
            if destination.try_exists()? {
                read_verified(&destination, &asset.hash, asset.size)?;
            } else {
                atomic_write(&destination, &bytes, false)?;
            }
        }
        drop(copy);
        File::open(&path)?.sync_all()?;
        let database_hash = hash_bytes(&read_bounded(&path, MAX_DATABASE_BYTES)?);
        let info = BackupInfo {
            id: new_id(),
            project_id: project_id.into(),
            name: project.name,
            created_at: now(),
            size,
            valid: true,
        };
        atomic_write(
            &stage.path().join("manifest.json"),
            &serde_json::to_vec(&Manifest {
                version: 1,
                info: info.clone(),
                database_hash,
                assets,
                origin,
            })?,
            false,
        )?;
        publish_dir(stage, &root.join(&info.id))?;
        self.catalog.execute("INSERT INTO backup_state(project_id,last_at,daily_date,sequence) VALUES(?1,?2,?3,?4) ON CONFLICT(project_id) DO UPDATE SET last_at=excluded.last_at,daily_date=excluded.daily_date,sequence=excluded.sequence",params![project_id,info.created_at,&info.created_at[..10],sequence as i64])?;
        self.prune_automatic_backups(project_id)?;
        Ok(info)
    }
    fn prune_automatic_backups(&self, project_id: &str) -> Result<()> {
        let root = child_dir(&self.root, "backups", false)?;
        let mut manifests = Vec::new();
        for entry in fs::read_dir(&root)? {
            let id = entry?.file_name().to_string_lossy().into_owned();
            // Unknown, damaged and legacy files are not deletion candidates.
            if validate_id(&id).is_err() { continue; }
            if let Ok((dir, m)) = self.backup_manifest(&id, project_id) {
                let database = dir.join("workspace.sqlite");
                if let Ok(meta) = fs::metadata(&database) {
                    if meta.len() <= MAX_DATABASE_BYTES && copy_file(&database, &mut std::io::sink(), meta.len(), &m.database_hash).is_ok() {
                        manifests.push(m);
                    }
                }
            }
        }
        let keep = retained_automatic(&manifests);
        for manifest in manifests {
            if manifest.origin == BackupOrigin::Automatic && !keep.contains(&manifest.info.id) {
                let dir = child_dir(&root, &manifest.info.id, false)?;
                // Snapshot directories contain just these two files. Never recursively remove
                // unknown content or any shared blob; history and manual backups may need it.
                let names = fs::read_dir(&dir)?.map(|e| e.map(|e| e.file_name())).collect::<std::io::Result<Vec<_>>>()?;
                if names.len() != 2 || !names.iter().all(|n| n == "manifest.json" || n == "workspace.sqlite") { continue; }
                check_path(&dir.join("manifest.json"), false)?;
                check_path(&dir.join("workspace.sqlite"), false)?;
                let retired = root.join(format!(".retired-{}", manifest.info.id));
                if fs::symlink_metadata(&retired).is_ok() { continue; }
                fs::rename(&dir, &retired)?;
                sync_dir(&root)?;
                fs::remove_file(retired.join("workspace.sqlite"))?;
                fs::remove_file(retired.join("manifest.json"))?;
                fs::remove_dir(retired)?;
            }
        }
        sync_dir(&root)
    }
    fn backup_manifest(
        &self,
        id: &str,
        project_id: &str,
    ) -> Result<(std::path::PathBuf, Manifest)> {
        validate_id(id)?;
        validate_id(project_id)?;
        let dir = child_dir(&child_dir(&self.root, "backups", false)?, id, false)?;
        let m: Manifest =
            serde_json::from_slice(&read_bounded(&dir.join("manifest.json"), 16 * 1024 * 1024)?)?;
        if m.version != 1 || m.info.id != id || m.info.project_id != project_id {
            return Err(AppError::integrity());
        }
        Ok((dir, m))
    }
    pub fn list_backups(&self, project_id: &str) -> Result<Vec<BackupInfo>> {
        self.project_db(project_id)?;
        let mut result = vec![];
        for entry in fs::read_dir(child_dir(&self.root, "backups", false)?)? {
            let id = entry?.file_name().to_string_lossy().into_owned();
            if id.starts_with('.') {
                continue;
            }
            validate_id(&id)?;
            let dir = child_dir(&child_dir(&self.root, "backups", false)?, &id, false)?;
            let m: Manifest = serde_json::from_slice(&read_bounded(
                &dir.join("manifest.json"),
                16 * 1024 * 1024,
            )?)?;
            if m.info.project_id == project_id {
                let mut info = m.info;
                info.valid = read_bounded(&dir.join("workspace.sqlite"), MAX_DATABASE_BYTES)
                    .map(|b| hash_bytes(&b) == m.database_hash)
                    .unwrap_or(false);
                result.push(info);
            }
        }
        result.sort_by(|a, b| b.created_at.cmp(&a.created_at));
        Ok(result)
    }
    pub fn restore_backup(&self, id: &str, project_id: &str) -> Result<Project> {
        let (dir, m) = self.backup_manifest(id, project_id)?;
        let blobs = child_dir(&self.root, "backup-blobs", false)?;
        self.restore_snapshot(id, project_id, &dir, &m, &blobs)
    }
    fn restore_snapshot(
        &self,
        id: &str,
        project_id: &str,
        dir: &std::path::Path,
        m: &Manifest,
        blobs: &std::path::Path,
    ) -> Result<Project> {
        let source = dir.join("workspace.sqlite");
        check_path(&source, false)?;
        let size = source.metadata()?.len();
        if size > MAX_DATABASE_BYTES {
            return Err(AppError::integrity());
        }
        let header = PortableHeader {
            kind: "tracefold-backup".into(),
            version: 1,
            database_size: size,
            manifest: m.clone(),
        };
        header.validate()?;
        let stage = tempfile::Builder::new()
            .prefix(".restore-")
            .tempdir_in(self.projects_dir()?)?;
        let path = stage.path().join("workspace.sqlite");
        let mut output = File::create(&path)?;
        copy_file(&source, &mut output, size, &m.database_hash)?;
        output.sync_all()?;
        drop(output);
        let snapshot = schema::open_snapshot(&path)?;
        schema::validate_snapshot_schema(&snapshot)?;
        schema::integrity(&snapshot)?;
        let stored_assets = snapshot
            .prepare("SELECT payload FROM assets ORDER BY id")?
            .query_map([], |row| row.get::<_, String>(0))?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        let mut expected = m.assets.clone();
        expected.sort_by(|a, b| a.id.cmp(&b.id));
        let actual = stored_assets
            .iter()
            .map(|value| serde_json::from_str::<Asset>(value))
            .collect::<std::result::Result<Vec<_>, _>>()?;
        if actual != expected {
            return Err(AppError::integrity());
        }
        drop(snapshot);
        let assets_dir = child_dir(stage.path(), "assets", true)?;
        for asset in &m.assets {
            let mut output = File::create(assets_dir.join(&asset.id))?;
            copy_file(&blobs.join(&asset.id), &mut output, asset.size, &asset.hash)?;
            output.sync_all()?;
        }
        let mut conn = schema::open(&path, false)?;
        schema::integrity(&conn)?;
        let mut project = Self::owned_project(&conn, project_id)?;
        project.id = new_id();
        project.name = format!("{} — {}", project.name, if self.get_settings()?.language == "hu" { "visszaállítva" } else { "restored" });
        project.updated_at = now();
        project.revision += 1;
        let tx = conn.transaction()?;
        tx.execute(
            "UPDATE project SET id=?1,payload=?2 WHERE singleton=1",
            params![project.id, serde_json::to_string(&project)?],
        )?;
        // UUIDs remain stable within this independent project; project scope prevents aliases.
        // Only the typed projectId field is changed; user text is never searched/replaced.
        tx.execute(
            "UPDATE records SET payload=json_set(payload,'$.projectId',?1)",
            [&project.id],
        )?;
        tx.execute(
            "UPDATE revisions SET payload=json_set(payload,'$.projectId',?1)",
            [&project.id],
        )?;
        tx.execute(
            "UPDATE project_revisions SET payload=json_set(payload,'$.id',?1)",
            [&project.id],
        )?;
        tx.execute(
            "INSERT INTO provenance(source_project_id,backup_id,restored_at) VALUES(?1,?2,?3)",
            params![project_id, id, project.updated_at],
        )?;
        self.project_history(&tx, &project, "restore")?;
        tx.commit()?;
        schema::integrity(&conn)?;
        let records = conn
            .prepare("SELECT payload FROM records")?
            .query_map([], |r| r.get::<_, String>(0))?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        for record in records {
            let e: Entity = serde_json::from_str(&record)?;
            for id in crate::store::asset_refs(&e)? {
                let a = m
                    .assets
                    .iter()
                    .find(|a| a.id == id)
                    .ok_or_else(AppError::integrity)?;
                read_verified(&assets_dir.join(&id), &a.hash, a.size)?;
            }
        }
        conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode=DELETE;")?;
        drop(conn);
        File::open(path)?.sync_all()?;
        publish_dir(stage, &self.projects_dir()?.join(&project.id))?;
        Ok(project)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn manifest(id: &str, at: &str, origin: BackupOrigin) -> Manifest {
        Manifest { version: 1, info: BackupInfo { id: id.into(), project_id: "project".into(), name: "Fixture".into(), created_at: at.into(), size: 1, valid: true }, database_hash: "0".repeat(64), assets: vec![], origin }
    }
    #[test]
    fn retention_keeps_interval_daily_and_weekly_recovery_points() {
        let mut snapshots = Vec::new();
        for day in 1..=35 {
            for hour in 0..12 {
                let at = chrono::DateTime::parse_from_rfc3339("2026-08-01T00:00:00Z").unwrap() + chrono::Duration::days(day) + chrono::Duration::hours(hour);
                snapshots.push(manifest(&format!("d{day}-h{hour}"), &at.to_rfc3339(), BackupOrigin::Automatic));
            }
        }
        snapshots.push(manifest("manual", "2026-10-01T00:00:00Z", BackupOrigin::Manual));
        let retained = retained_automatic(&snapshots);
        for hour in 2..12 { assert!(retained.contains(&format!("d35-h{hour}"))); }
        for day in 29..=35 { assert!(retained.contains(&format!("d{day}-h11"))); }
        for day in [29,22,15] { assert!(retained.contains(&format!("d{day}-h11"))); }
        assert!(!retained.contains("d35-h0"));
        assert!(!retained.contains("d1-h11"));
        assert!(!retained.contains("manual"));
        let legacy = serde_json::to_value(manifest("legacy", "2026-01-01T00:00:00Z", BackupOrigin::Manual)).unwrap();
        let mut legacy = legacy.as_object().unwrap().clone(); legacy.remove("origin");
        assert!(serde_json::from_value::<Manifest>(legacy.into()).unwrap().origin == BackupOrigin::Manual);
    }
    #[test]
    fn portable_header_rejects_duplicate_assets_and_unbounded_or_unsafe_metadata() {
        let bytes = b"fixture";
        let hash = hash_bytes(bytes);
        let asset = Asset { id: hash.clone(), hash, size: bytes.len() as u64, filename: "a.txt".into(), mime_type: "text/plain".into(), width: None, height: None };
        let mut m = manifest("backup", "2026-01-01T00:00:00Z", BackupOrigin::Manual);
        m.assets.push(asset.clone()); m.info.size = 1 + asset.size;
        let mut header = PortableHeader { kind: "tracefold-backup".into(), version: 1, database_size: 1, manifest: m };
        assert!(header.validate().is_ok());
        header.manifest.assets.push(asset); header.manifest.info.size += bytes.len() as u64;
        assert!(header.validate().is_err());
        header.manifest.assets.pop(); header.manifest.info.size -= bytes.len() as u64;
        header.manifest.assets[0].filename = "../escape".into();
        assert!(header.validate().is_err());
        header.manifest.assets[0].filename = "a.txt".into();
        header.database_size = MAX_DATABASE_BYTES + 1;
        assert!(header.validate().is_err());
    }
}
