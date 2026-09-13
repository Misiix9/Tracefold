use crate::{
    error::{AppError, Result},
    files::*,
    model::*,
    schema,
};
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::BTreeSet,
    fs::{self, File, OpenOptions},
    path::{Path, PathBuf},
};

pub struct Workspace {
    pub(crate) root: PathBuf,
    pub(crate) catalog: Connection,
    pub(crate) device_id: String,
    _lock: File,
}
impl Workspace {
    pub fn open(root: &Path) -> Result<Self> {
        fs::create_dir_all(root)?;
        check_path(root, true)?;
        let root = root.canonicalize()?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&root, fs::Permissions::from_mode(0o700))?;
        }
        let lock_path = root.join("workspace.lock");
        check_optional_file(&lock_path)?;
        let lock = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(lock_path)?;
        lock.try_lock().map_err(|_| {
            AppError::new(
                "WORKSPACE_LOCKED",
                "This workspace is already open in another Tracefold process.",
            )
        })?;
        for name in ["projects", "backups", "backup-blobs"] {
            child_dir(&root, name, true)?;
        }
        let catalog = schema::open(&root.join("settings.sqlite"), true)?;
        let version: i64 = catalog.query_row("PRAGMA user_version", [], |r| r.get(0))?;
        if version == 0 {
            catalog.execute_batch("BEGIN IMMEDIATE; CREATE TABLE settings (id INTEGER PRIMARY KEY CHECK(id=1), payload TEXT NOT NULL CHECK(json_valid(payload))); CREATE TABLE device (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL); CREATE TABLE backup_state (project_id TEXT PRIMARY KEY, last_at TEXT NOT NULL, daily_date TEXT NOT NULL, sequence INTEGER NOT NULL); PRAGMA user_version=1; COMMIT;")?;
        } else {
            schema::check_version(&catalog)?;
        }
        catalog.execute(
            "INSERT OR IGNORE INTO settings(id,payload) VALUES(1,?1)",
            [serde_json::to_string(&AppSettings::default())?],
        )?;
        catalog.execute(
            "INSERT OR IGNORE INTO device(id,value) VALUES(1,?1)",
            [new_id()],
        )?;
        let device_id =
            catalog.query_row("SELECT value FROM device WHERE id=1", [], |r| r.get(0))?;
        sync_dir(&root)?;
        Ok(Self {
            root,
            catalog,
            device_id,
            _lock: lock,
        })
    }
    pub(crate) fn projects_dir(&self) -> Result<PathBuf> {
        child_dir(&self.root, "projects", false)
    }
    pub(crate) fn project_dir(&self, id: &str) -> Result<PathBuf> {
        validate_id(id)?;
        child_dir(&self.projects_dir()?, id, false)
    }
    pub(crate) fn project_db(&self, id: &str) -> Result<Connection> {
        let conn = schema::open(&self.project_dir(id)?.join("workspace.sqlite"), false)?;
        schema::check_version(&conn)?;
        Self::owned_project(&conn, id)?;
        Ok(conn)
    }
    pub(crate) fn owned_project(conn: &Connection, id: &str) -> Result<Project> {
        let (stored_id, payload): (String, String) = conn
            .query_row(
                "SELECT id,payload FROM project WHERE singleton=1",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?
            .ok_or_else(AppError::missing)?;
        let project: Project = serde_json::from_str(&payload)?;
        if stored_id != id || project.id != id {
            return Err(AppError::new(
                "PROJECT_SCOPE",
                "This database does not belong to the requested project.",
            ));
        }
        validate_project(&project)?;
        Ok(project)
    }
    pub fn list_projects(&self) -> Result<Vec<Project>> {
        let mut result = Vec::new();
        for entry in fs::read_dir(self.projects_dir()?)? {
            let entry = entry?;
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.starts_with('.') {
                continue;
            } // unpublished staging directories are never visible
            validate_id(&name)?;
            let conn = self.project_db(&name)?;
            result.push(Self::owned_project(&conn, &name)?);
        }
        result.sort_by(|a, b| b.updated_at.cmp(&a.updated_at).then(a.id.cmp(&b.id)));
        Ok(result)
    }
    pub fn save_project(&self, mut project: Project, expected: u64) -> Result<Project> {
        validate_project(&project)?;
        validate_expected(project.revision, expected)?;
        let destination = self.projects_dir()?.join(&project.id);
        if !destination.try_exists()? {
            if expected != 0 {
                return Err(AppError::conflict());
            }
            let stage = tempfile::Builder::new()
                .prefix(".project-")
                .tempdir_in(self.projects_dir()?)?;
            child_dir(stage.path(), "assets", true)?;
            let mut conn = schema::open(&stage.path().join("workspace.sqlite"), true)?;
            schema::initialize(&conn)?;
            project.revision = 1;
            project.created_at = now();
            project.updated_at = project.created_at.clone();
            let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
            tx.execute(
                "INSERT INTO project(singleton,id,payload) VALUES(1,?1,?2)",
                params![project.id, serde_json::to_string(&project)?],
            )?;
            self.project_history(&tx, &project, "create")?;
            tx.commit()?;
            conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode=DELETE;")?;
            drop(conn);
            sync_file(&stage.path().join("workspace.sqlite"))?;
            publish_dir(stage, &destination)?;
            return Ok(project);
        }
        let mut conn = self.project_db(&project.id)?;
        let old = Self::owned_project(&conn, &project.id)?;
        if old.revision != expected {
            return Err(AppError::conflict());
        }
        self.before_write(&project.id)?;
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        project.revision = expected + 1;
        project.created_at = old.created_at;
        project.updated_at = now();
        tx.execute(
            "UPDATE project SET payload=?1 WHERE singleton=1",
            [serde_json::to_string(&project)?],
        )?;
        self.project_history(&tx, &project, "update")?;
        tx.commit()?;
        Ok(project)
    }
    pub(crate) fn project_history(
        &self,
        conn: &Connection,
        p: &Project,
        operation: &str,
    ) -> Result<()> {
        conn.execute(
            "INSERT INTO project_revisions(revision,payload,at) VALUES(?1,?2,?3)",
            params![p.revision as i64, serde_json::to_string(p)?, p.updated_at],
        )?;
        self.change(
            conn,
            &p.id,
            &p.id,
            "project",
            operation,
            p.revision,
            &p.updated_at,
        )
    }
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn change(
        &self,
        conn: &Connection,
        project: &str,
        id: &str,
        kind: &str,
        operation: &str,
        revision: u64,
        at: &str,
    ) -> Result<()> {
        conn.execute("INSERT INTO changes(id,project_id,entity_id,kind,operation,revision,device_id,actor_id,at) VALUES(?1,?2,?3,?4,?5,?6,?7,'local',?8)", params![new_id(),project,id,kind,operation,revision as i64,self.device_id,at])?;
        Ok(())
    }
    pub fn get_record(&self, id: &str, project_id: &str) -> Result<Option<Entity>> {
        validate_id(id)?;
        let conn = self.project_db(project_id)?;
        record(&conn, id, project_id)
    }
    pub fn save_record(&self, mut entity: Entity, expected: u64) -> Result<Entity> {
        validate_entity(&entity)?;
        validate_expected(entity.revision, expected)?;
        let mut conn = self.project_db(&entity.project_id)?;
        let old = record(&conn, &entity.id, &entity.project_id)?;
        match &old {
            Some(old) if old.revision != expected => return Err(AppError::conflict()),
            Some(old) if old.deleted_at.is_some() => {
                return Err(AppError::new(
                    "DELETED",
                    "Restore this item before editing it.",
                ))
            }
            Some(old) if old.kind != entity.kind => {
                return Err(AppError::invalid(
                    "kind",
                    "An existing item's kind cannot change.",
                ))
            }
            None if expected != 0 => return Err(AppError::conflict()),
            _ => (),
        }
        if entity.deleted_at.is_some() {
            return Err(AppError::invalid(
                "deletedAt",
                "Use deleteRecord to move an item to trash.",
            ));
        }
        self.validate_assets(&conn, &entity)?;
        self.before_write(&entity.project_id)?;
        let at = now();
        entity.revision = expected + 1;
        entity.created_at = old
            .as_ref()
            .map(|r| r.created_at.clone())
            .unwrap_or_else(|| at.clone());
        entity.updated_at = at;
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        self.persist_record(
            &tx,
            &entity,
            if old.is_some() { "update" } else { "create" },
        )?;
        tx.commit()?;
        Ok(entity)
    }
    pub fn delete_record(&self, id: &str, project_id: &str, expected: u64) -> Result<()> {
        self.trash_transition(id, project_id, expected, true)?;
        Ok(())
    }
    pub fn restore_record(&self, id: &str, project_id: &str, expected: u64) -> Result<Entity> {
        self.trash_transition(id, project_id, expected, false)
    }
    fn trash_transition(
        &self,
        id: &str,
        project_id: &str,
        expected: u64,
        delete: bool,
    ) -> Result<Entity> {
        validate_id(id)?;
        let mut conn = self.project_db(project_id)?;
        let mut entity = record(&conn, id, project_id)?.ok_or_else(AppError::missing)?;
        validate_expected(entity.revision, expected)?;
        if entity.deleted_at.is_some() == delete {
            return Err(AppError::new(
                "INVALID_STATE",
                "The item is already in the requested trash state.",
            ));
        }
        self.validate_assets(&conn, &entity)?;
        self.before_write(project_id)?;
        entity.revision += 1;
        entity.updated_at = now();
        entity.deleted_at = if delete {
            Some(entity.updated_at.clone())
        } else {
            None
        };
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        self.persist_record(&tx, &entity, if delete { "delete" } else { "restore" })?;
        tx.commit()?;
        Ok(entity)
    }
    pub(crate) fn persist_record(
        &self,
        conn: &Connection,
        e: &Entity,
        operation: &str,
    ) -> Result<()> {
        let payload = serde_json::to_string(e)?;
        conn.execute("INSERT INTO records(id,kind,revision,updated_at,deleted_at,payload) VALUES(?1,?2,?3,?4,?5,?6) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,updated_at=excluded.updated_at,deleted_at=excluded.deleted_at,payload=excluded.payload", params![e.id,e.kind,e.revision as i64,e.updated_at,e.deleted_at,payload])?;
        conn.execute(
            "INSERT INTO revisions(id,entity_id,revision,at,payload) VALUES(?1,?2,?3,?4,?5)",
            params![new_id(), e.id, e.revision as i64, e.updated_at, payload],
        )?;
        for asset_id in asset_refs(e)? {
            conn.execute(
                "INSERT INTO asset_refs(entity_id,revision,asset_id) VALUES(?1,?2,?3)",
                params![e.id, e.revision as i64, asset_id],
            )?;
        }
        index_record(conn, e)?;
        self.change(
            conn,
            &e.project_id,
            &e.id,
            &e.kind,
            operation,
            e.revision,
            &e.updated_at,
        )
    }
    pub fn get_revisions(&self, id: &str, project_id: &str) -> Result<Vec<Revision>> {
        validate_id(id)?;
        let conn = self.project_db(project_id)?;
        record(&conn, id, project_id)?.ok_or_else(AppError::missing)?;
        let mut stmt = conn.prepare(
            "SELECT id,payload FROM revisions WHERE entity_id=?1 ORDER BY revision DESC",
        )?;
        let rows = stmt.query_map([id], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
        })?;
        let mut revisions = Vec::new();
        let mut bytes = 0;
        for row in rows {
            let (rid, payload) = row?;
            bytes += payload.len();
            if bytes > MAX_EXPORT_BYTES as usize {
                return Err(AppError::new("LIMIT_EXCEEDED", "Revision history exceeds the IPC response limit. Use a full backup to preserve this history."));
            }
            let entity: Entity = serde_json::from_str(&payload)?;
            if entity.project_id != project_id || entity.id != id {
                return Err(AppError::integrity());
            }
            revisions.push(Revision {
                id: rid,
                entity_id: id.into(),
                revision: entity.revision,
                at: entity.updated_at.clone(),
                title: entity.title.clone(),
                entity,
            });
        }
        Ok(revisions)
    }
    pub fn list_records(&self, query: RecordQuery) -> Result<Page<Entity>> {
        if let Some(kind) = &query.kind {
            validate_kind(kind)?;
        }
        let limit = query.limit.unwrap_or(100);
        if !(1..=500).contains(&limit) {
            return Err(AppError::invalid(
                "limit",
                "Page size must be between 1 and 500.",
            ));
        }
        let search = query.search.as_deref().unwrap_or("").trim();
        if search.len() > 512 {
            return Err(AppError::invalid(
                "search",
                "Search must be at most 512 bytes.",
            ));
        }
        let terms: Vec<&str> = search
            .split(|c: char| !c.is_alphanumeric())
            .filter(|s| !s.is_empty())
            .collect();
        if terms.len() > 32 {
            return Err(AppError::invalid("search", "Use at most 32 search terms."));
        }
        let fts = terms
            .iter()
            .map(|s| format!("\"{s}\"*"))
            .collect::<Vec<_>>()
            .join(" AND ");
        let conn = self.project_db(&query.project_id)?;
        let sequence = sequence(&conn)?;
        let signature = hash_bytes(
            serde_json::to_string(&(
                &query.project_id,
                &query.kind,
                search,
                query.include_deleted,
                limit,
            ))?
            .as_bytes(),
        );
        let cursor = query
            .cursor
            .as_ref()
            .map(|c| -> Result<Cursor> {
                if c.len() > 2048 {
                    return Err(AppError::invalid("cursor", "Invalid cursor."));
                }
                let cursor: Cursor = serde_json::from_str(c)
                    .map_err(|_| AppError::invalid("cursor", "Invalid cursor."))?;
                if cursor.signature != signature {
                    return Err(AppError::invalid(
                        "cursor",
                        "This cursor belongs to a different query.",
                    ));
                }
                if cursor.sequence != sequence {
                    return Err(AppError::new(
                        "STALE_CURSOR",
                        "The project changed during pagination. Restart from the first page.",
                    ));
                }
                validate_id(&cursor.id)?;
                Ok(cursor)
            })
            .transpose()?;
        let filter = "(?1 IS NULL OR r.kind=?1) AND (?2 OR r.deleted_at IS NULL) AND (?3='' OR r.id IN (SELECT id FROM records_fts WHERE records_fts MATCH ?3))";
        // Nonempty punctuation-only queries intentionally match no records.
        if !search.is_empty() && fts.is_empty() {
            return Ok(Page {
                items: vec![],
                next_cursor: None,
                total: 0,
            });
        }
        let total = conn.query_row(
            &format!("SELECT COUNT(*) FROM records r WHERE {filter}"),
            params![query.kind, query.include_deleted, fts],
            |r| r.get::<_, i64>(0),
        )? as u64;
        let sql = format!("SELECT r.payload FROM records r WHERE {filter} AND (?4 IS NULL OR r.updated_at < ?4 OR (r.updated_at=?4 AND r.id>?5)) ORDER BY r.updated_at DESC,r.id ASC LIMIT ?6");
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(
            params![
                query.kind,
                query.include_deleted,
                fts,
                cursor.as_ref().map(|c| &c.updated_at),
                cursor.as_ref().map(|c| &c.id),
                limit + 1
            ],
            |r| r.get::<_, String>(0),
        )?;
        let mut items = Vec::new();
        let mut bytes = 0;
        for row in rows {
            let payload = row?;
            bytes += payload.len();
            if bytes as u64 > MAX_EXPORT_BYTES {
                return Err(AppError::new(
                    "LIMIT_EXCEEDED",
                    "Reduce the page size for these large records.",
                ));
            }
            let e: Entity = serde_json::from_str(&payload)?;
            if e.project_id != query.project_id {
                return Err(AppError::integrity());
            }
            items.push(e);
        }
        let more = items.len() > limit as usize;
        items.truncate(limit as usize);
        let next_cursor = if more {
            items
                .last()
                .map(|e| {
                    serde_json::to_string(&Cursor {
                        signature,
                        sequence,
                        updated_at: e.updated_at.clone(),
                        id: e.id.clone(),
                    })
                })
                .transpose()?
        } else {
            None
        };
        Ok(Page {
            items,
            next_cursor,
            total,
        })
    }
    pub fn get_settings(&self) -> Result<AppSettings> {
        let payload: String =
            self.catalog
                .query_row("SELECT payload FROM settings WHERE id=1", [], |r| r.get(0))?;
        Ok(serde_json::from_str(&payload)?)
    }
    pub fn save_settings(&self, settings: AppSettings) -> Result<()> {
        if !["hu", "en"].contains(&settings.language.as_str()) {
            return Err(AppError::invalid("language", "Unsupported language."));
        }
        if !["system", "light", "dark"].contains(&settings.theme.as_str())
            || !["comfortable", "compact"].contains(&settings.density.as_str())
            || !(10..=32).contains(&settings.editor_font_size)
            || !["A4", "LETTER"].contains(&settings.page_size.as_str())
            || settings.author.len() > 500
            || settings.last_view.len() > 100
            || !(crate::model::MIN_CHECK_SECONDS..=crate::model::MAX_CHECK_SECONDS)
                .contains(&settings.update_check_seconds)
            || !(crate::model::MIN_CHECK_SECONDS..=crate::model::MAX_CHECK_SECONDS)
                .contains(&settings.plugin_check_seconds)
            || settings.shortcuts.len() > 100
            || settings
                .shortcuts
                .iter()
                .any(|(k, v)| k.len() > 100 || v.len() > 100)
        {
            return Err(AppError::invalid(
                "settings",
                "Settings contain unsupported values or exceed their limits.",
            ));
        }
        if let Some(id) = &settings.last_project_id {
            self.project_db(id)?;
        }
        self.catalog.execute(
            "UPDATE settings SET payload=?1 WHERE id=1",
            [serde_json::to_string(&settings)?],
        )?;
        Ok(())
    }
    pub fn import_asset(
        &self,
        project_id: &str,
        filename: &str,
        mime_type: &str,
        bytes: &[u8],
    ) -> Result<Asset> {
        validate_filename(filename)?;
        validate_mime(mime_type)?;
        if bytes.is_empty() || bytes.len() as u64 > MAX_ASSET_BYTES {
            return Err(AppError::invalid(
                "bytes",
                "Asset size must be between 1 byte and 64 MiB.",
            ));
        }
        let mut conn = self.project_db(project_id)?;
        let id = hash_bytes(bytes);
        let dir = child_dir(&self.project_dir(project_id)?, "assets", false)?;
        if let Some(existing) = asset(&conn, &id)? {
            read_verified(&dir.join(&id), &id, existing.size)?;
            return Ok(existing);
        }
        self.before_write(project_id)?;
        let path = dir.join(&id);
        if path.try_exists()? {
            read_verified(&path, &id, bytes.len() as u64)?;
        } else {
            atomic_write(&path, bytes, false)?;
        }
        // Crash before the transaction leaves only an unreferenced, immutable blob.
        let asset = Asset {
            id: id.clone(),
            filename: filename.into(),
            mime_type: mime_type.into(),
            size: bytes.len() as u64,
            hash: id,
            width: None,
            height: None,
        };
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        tx.execute(
            "INSERT INTO assets(id,payload) VALUES(?1,?2)",
            params![asset.id, serde_json::to_string(&asset)?],
        )?;
        self.change(&tx, project_id, &asset.id, "asset", "create", 1, &now())?;
        tx.commit()?;
        Ok(asset)
    }
    pub fn read_asset(&self, project_id: &str, asset_id: &str) -> Result<Vec<u8>> {
        validate_hash(asset_id)?;
        let conn = self.project_db(project_id)?;
        let asset = asset(&conn, asset_id)?.ok_or_else(AppError::missing)?;
        read_verified(
            &child_dir(&self.project_dir(project_id)?, "assets", false)?.join(asset_id),
            asset_id,
            asset.size,
        )
    }
    pub(crate) fn validate_assets(&self, conn: &Connection, entity: &Entity) -> Result<()> {
        for id in asset_refs(entity)? {
            let asset = asset(conn,&id)?.ok_or_else(|| AppError::new("ASSET_NOT_FOUND", "An evidence asset is missing from this project. Import it before saving the record."))?;
            read_verified(
                &child_dir(&self.project_dir(&entity.project_id)?, "assets", false)?.join(&id),
                &id,
                asset.size,
            )?;
        }
        if entity.kind == "evidence" {
            let id = entity
                .data
                .get("assetId")
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
                .ok_or_else(|| {
                    AppError::invalid("data.assetId", "Evidence requires an imported asset.")
                })?;
            let meta = asset(conn, id)?.ok_or_else(AppError::missing)?;
            if entity.data.get("hash").and_then(Value::as_str) != Some(meta.hash.as_str())
                || entity.data.get("size").and_then(Value::as_u64) != Some(meta.size)
                || entity.data.get("mimeType").and_then(Value::as_str)
                    != Some(meta.mime_type.as_str())
            {
                return Err(AppError::invalid(
                    "data",
                    "Evidence hash, size and MIME type must match its immutable asset.",
                ));
            }
        }
        Ok(())
    }
    /// Import a completed OS capture. The chooser must run outside the workspace lock.
    pub fn capture_screen(&self, project_id: &str, png: Option<&[u8]>) -> Result<Option<Asset>> {
        self.project_db(project_id)?;
        let Some(bytes) = png else {
            return Ok(None);
        };
        crate::capture::validate_png(bytes)?;
        self.import_asset(project_id, "Screenshot.png", "image/png", bytes)
            .map(Some)
    }
    pub fn storage_info(&self) -> Result<StorageInfo> {
        let projects = self.list_projects()?;
        let mut database_bytes = 0;
        let mut asset_bytes = 0;
        for p in &projects {
            let dir = self.project_dir(&p.id)?;
            asset_bytes += directory_size(&child_dir(&dir, "assets", false)?)?;
            for suffix in ["", "-wal", "-shm"] {
                let path = dir.join(format!("workspace.sqlite{suffix}"));
                check_optional_file(&path)?;
                if path.try_exists()? {
                    database_bytes += path.metadata()?.len();
                }
            }
        }
        for suffix in ["", "-wal", "-shm"] {
            let path = self.root.join(format!("settings.sqlite{suffix}"));
            check_optional_file(&path)?;
            if path.try_exists()? {
                database_bytes += path.metadata()?.len();
            }
        }
        Ok(StorageInfo {
            location: self.root.to_string_lossy().into_owned(),
            database_bytes,
            asset_bytes,
            backup_bytes: directory_size(&child_dir(&self.root, "backups", false)?)?
                + directory_size(&child_dir(&self.root, "backup-blobs", false)?)?,
            project_count: projects.len() as u64,
        })
    }
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Cursor {
    signature: String,
    sequence: u64,
    updated_at: String,
    id: String,
}
pub(crate) fn sequence(conn: &Connection) -> Result<u64> {
    Ok(
        conn.query_row("SELECT COALESCE(MAX(sequence),0) FROM changes", [], |r| {
            r.get::<_, i64>(0)
        })? as u64,
    )
}
pub(crate) fn record(conn: &Connection, id: &str, project: &str) -> Result<Option<Entity>> {
    let payload: Option<String> = conn
        .query_row("SELECT payload FROM records WHERE id=?1", [id], |r| {
            r.get(0)
        })
        .optional()?;
    payload
        .map(|p| {
            let e: Entity = serde_json::from_str(&p)?;
            if e.project_id != project || e.id != id {
                return Err(AppError::integrity());
            }
            Ok(e)
        })
        .transpose()
}
pub(crate) fn asset(conn: &Connection, id: &str) -> Result<Option<Asset>> {
    let payload: Option<String> = conn
        .query_row("SELECT payload FROM assets WHERE id=?1", [id], |r| r.get(0))
        .optional()?;
    payload
        .map(|p| {
            let a: Asset = serde_json::from_str(&p)?;
            if a.id != id || a.hash != id || a.size == 0 || a.size > MAX_ASSET_BYTES {
                return Err(AppError::integrity());
            }
            Ok(a)
        })
        .transpose()
}
pub(crate) fn validate_project(p: &Project) -> Result<()> {
    validate_id(&p.id)?;
    if p.name.trim().is_empty()
        || p.name.len() > 200
        || p.description.len() > 10000
        || p.prefix.len() > 32
        || p.color.len() > 64
        || p.revision >= 9_007_199_254_740_991
    {
        return Err(AppError::invalid(
            "project",
            "Project name is required and project fields must be within their size limits.",
        ));
    }
    Ok(())
}
pub(crate) fn validate_entity(e: &Entity) -> Result<()> {
    validate_id(&e.id)?;
    validate_id(&e.project_id)?;
    validate_kind(&e.kind)?;
    if e.title.len() > 2000
        || e.tags.len() > 100
        || e.tags.iter().any(|t| t.len() > 100)
        || e.body.get("type").and_then(Value::as_str) != Some("doc")
        || !e.data.is_object()
        || serde_json::to_vec(e)?.len() > 2 * 1024 * 1024
    {
        return Err(AppError::invalid(
            "record",
            "Record fields are invalid or the 2 MiB record limit was exceeded.",
        ));
    }
    depth(&e.body, 0)?;
    depth(&e.data, 0)?;
    Ok(())
}
fn depth(v: &Value, level: usize) -> Result<()> {
    if level > 48 {
        return Err(AppError::invalid(
            "record",
            "Record nesting exceeds the supported depth.",
        ));
    }
    match v {
        Value::Object(m) => {
            for v in m.values() {
                depth(v, level + 1)?;
            }
        }
        Value::Array(a) => {
            for v in a {
                depth(v, level + 1)?;
            }
        }
        _ => (),
    };
    Ok(())
}
fn validate_expected(actual: u64, expected: u64) -> Result<()> {
    if actual != expected {
        return Err(AppError::conflict());
    }
    if expected >= 9_007_199_254_740_990 {
        return Err(AppError::invalid(
            "revision",
            "Revision exceeds the safe integer range.",
        ));
    }
    Ok(())
}
fn validate_kind(kind: &str) -> Result<()> {
    if ![
        "document",
        "session",
        "entry",
        "finding",
        "case",
        "run",
        "requirement",
        "evidence",
        "template",
    ]
    .contains(&kind)
    {
        return Err(AppError::invalid("kind", "Unknown record kind."));
    }
    Ok(())
}
pub(crate) fn asset_refs(e: &Entity) -> Result<BTreeSet<String>> {
    fn visit(v: &Value, ids: &mut BTreeSet<String>) -> Result<()> {
        match v {
            Value::Object(m) => {
                for (k, v) in m {
                    if ["assetId", "originalAssetId", "sanitizedAssetId"].contains(&k.as_str()) {
                        if let Some(id) = v.as_str().filter(|s| !s.is_empty()) {
                            validate_hash(id)?;
                            ids.insert(id.into());
                        } else if !v.is_null() && v.as_str() != Some("") {
                            return Err(AppError::invalid(
                                "assetId",
                                "Asset references must be strings.",
                            ));
                        }
                    } else {
                        visit(v, ids)?;
                    }
                }
            }
            Value::Array(a) => {
                for v in a {
                    visit(v, ids)?;
                }
            }
            _ => (),
        }
        Ok(())
    }
    let mut ids = BTreeSet::new();
    visit(&e.body, &mut ids)?;
    visit(&e.data, &mut ids)?;
    Ok(ids)
}
fn searchable(v: &Value, out: &mut String) {
    match v {
        Value::String(s) => {
            out.push_str(s);
            out.push(' ');
        }
        Value::Object(m) => {
            for v in m.values() {
                searchable(v, out);
            }
        }
        Value::Array(a) => {
            for v in a {
                searchable(v, out);
            }
        }
        _ => (),
    }
}
pub(crate) fn index_record(conn: &Connection, e: &Entity) -> Result<()> {
    let mut body = String::new();
    searchable(&e.body, &mut body);
    let mut data = String::new();
    searchable(&e.data, &mut data);
    conn.execute("DELETE FROM records_fts WHERE id=?1", [&e.id])?;
    conn.execute(
        "INSERT INTO records_fts(id,title,body,tags,data) VALUES(?1,?2,?3,?4,?5)",
        params![e.id, e.title, body, e.tags.join(" "), data],
    )?;
    Ok(())
}
