use crate::{
    error::{AppError, Result},
    files::*,
    model::*,
    schema,
    store::{asset_refs, validate_entity, validate_project, Workspace},
};
use rusqlite::params;
use serde::Deserialize;
use std::collections::BTreeMap;
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ImportedAsset {
    pub asset: Asset,
    pub bytes: Vec<u8>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectImport {
    pub project: Project,
    pub records: Vec<Entity>,
    pub assets: Vec<ImportedAsset>,
    pub source_project_id: String,
}
impl Workspace {
    pub fn import_project(&self, mut input: ProjectImport) -> Result<Project> {
        validate_project(&input.project)?;
        if input.project.revision != 0
            || input.project.archived
            || input.records.len() > 10000
            || input.assets.len() > 1000
            || input.source_project_id.len() > 200
        {
            return Err(AppError::invalid("import", "Unsupported imported project."));
        }
        let destination = self.projects_dir()?.join(&input.project.id);
        if destination.try_exists()? {
            return Err(AppError::conflict());
        }
        let stage = tempfile::Builder::new()
            .prefix(".import-")
            .tempdir_in(self.projects_dir()?)?;
        let assets_dir = child_dir(stage.path(), "assets", true)?;
        let mut assets = BTreeMap::new();
        let mut total = 0u64;
        for item in input.assets {
            let a = item.asset;
            validate_hash(&a.id)?;
            validate_filename(&a.filename)?;
            validate_mime(&a.mime_type)?;
            if a.id != a.hash
                || a.size == 0
                || a.size > MAX_ASSET_BYTES
                || a.size != item.bytes.len() as u64
                || hash_bytes(&item.bytes) != a.hash
                || assets.contains_key(&a.id)
            {
                return Err(AppError::integrity());
            }
            total = total.checked_add(a.size).ok_or_else(AppError::integrity)?;
            if total > 128 * 1024 * 1024 {
                return Err(AppError::invalid(
                    "assets",
                    "Imported evidence exceeds 128 MiB.",
                ));
            }
            atomic_write(&assets_dir.join(&a.id), &item.bytes, false)?;
            assets.insert(a.id.clone(), a);
        }
        let mut ids = std::collections::BTreeSet::new();
        let mut record_bytes = 0usize;
        for e in &input.records {
            validate_entity(e)?;
            record_bytes += serde_json::to_vec(e)?.len();
            if record_bytes > 24 * 1024 * 1024
                || e.project_id != input.project.id
                || e.revision != 0
                || e.deleted_at.is_some()
                || !ids.insert(e.id.clone())
            {
                return Err(AppError::invalid(
                    "records",
                    "Imported record scope, identity or size is invalid.",
                ));
            }
            for id in asset_refs(e)? {
                if !assets.contains_key(&id) {
                    return Err(AppError::new(
                        "ASSET_NOT_FOUND",
                        "An imported record references missing evidence.",
                    ));
                }
            }
            if e.kind == "evidence" {
                let a = e
                    .data
                    .get("assetId")
                    .and_then(|v| v.as_str())
                    .and_then(|id| assets.get(id))
                    .ok_or_else(AppError::integrity)?;
                if e.data.get("hash").and_then(|v| v.as_str()) != Some(a.hash.as_str())
                    || e.data.get("size").and_then(|v| v.as_u64()) != Some(a.size)
                    || e.data.get("mimeType").and_then(|v| v.as_str()) != Some(a.mime_type.as_str())
                {
                    return Err(AppError::integrity());
                }
            }
        }
        let path = stage.path().join("workspace.sqlite");
        let mut conn = schema::open(&path, true)?;
        schema::initialize(&conn)?;
        input.project.revision = 1;
        let tx = conn.transaction()?;
        tx.execute(
            "INSERT INTO project(singleton,id,payload) VALUES(1,?1,?2)",
            params![input.project.id, serde_json::to_string(&input.project)?],
        )?;
        self.project_history(&tx, &input.project, "create")?;
        for a in assets.values() {
            tx.execute(
                "INSERT INTO assets(id,payload) VALUES(?1,?2)",
                params![a.id, serde_json::to_string(a)?],
            )?;
        }
        for mut record in input.records {
            record.revision = 1;
            self.persist_record(&tx, &record, "create")?;
        }
        tx.execute(
            "INSERT INTO provenance(source_project_id,backup_id,restored_at) VALUES(?1,?2,?3)",
            params![
                input.source_project_id,
                format!("import-{}", new_id()),
                now()
            ],
        )?;
        tx.commit()?;
        schema::integrity(&conn)?;
        conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode=DELETE;")?;
        drop(conn);
        sync_file(&path)?;
        publish_dir(stage, &destination)?;
        Ok(input.project)
    }
}
