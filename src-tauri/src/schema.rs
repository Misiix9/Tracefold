use crate::{
    error::{AppError, Result},
    files,
};
use rusqlite::{Connection, OpenFlags};
use std::{path::Path, time::Duration};
pub const VERSION: i64 = 1;

pub fn open(path: &Path, create: bool) -> Result<Connection> {
    files::check_path(path.parent().ok_or_else(AppError::integrity)?, true)?;
    if !create {
        files::check_path(path, false)?;
    }
    for suffix in ["", "-wal", "-shm", "-journal"] {
        files::check_optional_file(&path.with_file_name(format!(
            "{}{}",
            path.file_name().unwrap().to_string_lossy(),
            suffix
        )))?;
    }
    let flags = OpenFlags::SQLITE_OPEN_READ_WRITE
        | if create {
            OpenFlags::SQLITE_OPEN_CREATE
        } else {
            OpenFlags::empty()
        };
    let conn = Connection::open_with_flags(path, flags)?;
    conn.busy_timeout(Duration::from_secs(5))?;
    conn.execute_batch("PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA fullfsync=ON; PRAGMA checkpoint_fullfsync=ON;")?;
    Ok(conn)
}
pub fn open_snapshot(path: &Path) -> Result<Connection> {
    files::check_path(path, false)?;
    if path.metadata()?.len() > files::MAX_DATABASE_BYTES {
        return Err(AppError::new(
            "LIMIT_EXCEEDED",
            "The backup database exceeds the supported size.",
        ));
    }
    let conn = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    conn.execute_batch("PRAGMA foreign_keys=ON; PRAGMA query_only=ON; PRAGMA trusted_schema=OFF;")?;
    check_version(&conn)?;
    Ok(conn)
}
pub fn check_version(conn: &Connection) -> Result<()> {
    let version: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    if version != VERSION {
        return Err(AppError::new(
            "UNSUPPORTED_SCHEMA",
            "This database version is unsupported. No migration or write was attempted.",
        ));
    }
    Ok(())
}
pub fn initialize(conn: &Connection) -> Result<()> {
    conn.execute_batch("BEGIN IMMEDIATE;
      CREATE TABLE project (singleton INTEGER PRIMARY KEY CHECK(singleton=1), id TEXT NOT NULL UNIQUE, payload TEXT NOT NULL CHECK(json_valid(payload)));
      CREATE TABLE project_revisions (revision INTEGER PRIMARY KEY, payload TEXT NOT NULL CHECK(json_valid(payload)), at TEXT NOT NULL);
      CREATE TABLE records (id TEXT PRIMARY KEY, kind TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>0), updated_at TEXT NOT NULL, deleted_at TEXT, payload TEXT NOT NULL CHECK(json_valid(payload)));
      CREATE INDEX records_listing ON records(deleted_at,kind,updated_at DESC,id);
      CREATE TABLE revisions (id TEXT PRIMARY KEY, entity_id TEXT NOT NULL REFERENCES records(id), revision INTEGER NOT NULL, at TEXT NOT NULL, payload TEXT NOT NULL CHECK(json_valid(payload)), UNIQUE(entity_id,revision));
      CREATE TABLE changes (sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, project_id TEXT NOT NULL REFERENCES project(id) ON UPDATE CASCADE, entity_id TEXT NOT NULL, kind TEXT NOT NULL, operation TEXT NOT NULL CHECK(operation IN ('create','update','delete','restore')), revision INTEGER NOT NULL, device_id TEXT NOT NULL, actor_id TEXT NOT NULL, at TEXT NOT NULL);
      CREATE TABLE assets (id TEXT PRIMARY KEY, payload TEXT NOT NULL CHECK(json_valid(payload)));
      CREATE TABLE asset_refs (entity_id TEXT NOT NULL REFERENCES records(id), revision INTEGER NOT NULL, asset_id TEXT NOT NULL REFERENCES assets(id), PRIMARY KEY(entity_id,revision,asset_id), FOREIGN KEY(entity_id,revision) REFERENCES revisions(entity_id,revision));
      CREATE TABLE provenance (id INTEGER PRIMARY KEY, source_project_id TEXT NOT NULL, backup_id TEXT NOT NULL, restored_at TEXT NOT NULL);
      CREATE VIRTUAL TABLE records_fts USING fts5(id UNINDEXED,title,body,tags,data,tokenize='unicode61 remove_diacritics 2');
      PRAGMA user_version=1;
      COMMIT;")?;
    Ok(())
}
pub fn integrity(conn: &Connection) -> Result<()> {
    check_version(conn)?;
    let result: String = conn.query_row("PRAGMA integrity_check", [], |r| r.get(0))?;
    let foreign_violations = conn.prepare("PRAGMA foreign_key_check")?.exists([])?;
    if result != "ok" || foreign_violations {
        return Err(AppError::integrity());
    }
    Ok(())
}

/// A backup database must contain only the schema emitted by this format version.
/// Validate before any writable connection can execute imported triggers or views.
pub fn validate_snapshot_schema(conn: &Connection) -> Result<()> {
    fn entries(conn: &Connection) -> Result<Vec<(String, String, String)>> {
        Ok(conn
            .prepare("SELECT type,name,coalesce(sql,'') FROM sqlite_schema ORDER BY type,name")?
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))?
            .collect::<std::result::Result<Vec<_>, _>>()?)
    }
    let reference = Connection::open_in_memory()?;
    initialize(&reference)?;
    if entries(conn)? != entries(&reference)? {
        return Err(AppError::new(
            "UNSUPPORTED_SCHEMA",
            "The backup contains an unexpected database schema.",
        ));
    }
    Ok(())
}
