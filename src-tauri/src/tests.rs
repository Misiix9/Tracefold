use crate::import::{ImportedAsset, ProjectImport};
use crate::{model::*, store::Workspace};
use serde_json::json;
fn project_import(p: &Project) -> ProjectImport {
    let mut project = p.clone();
    project.id = new_id();
    project.revision = 0;
    project.name = "Independent import".into();
    let record = document(&project, "Imported observation");
    ProjectImport {
        project,
        records: vec![record],
        assets: vec![],
        source_project_id: p.id.clone(),
    }
}
#[test]
fn imported_project_is_atomic_and_survives_reopening() {
    let (dir, workspace, p) = fixture();
    let input = project_import(&p);
    let record_id = input.records[0].id.clone();
    let imported = workspace.import_project(input).unwrap();
    assert_ne!(p.id, imported.id);
    assert_eq!(imported.revision, 1);
    drop(workspace);
    let reopened = Workspace::open(dir.path()).unwrap();
    let record = reopened
        .get_record(&record_id, &imported.id)
        .unwrap()
        .unwrap();
    assert_eq!(record.title, "Imported observation");
    assert_eq!(record.revision, 1);
    assert_eq!(
        reopened
            .get_revisions(&record_id, &imported.id)
            .unwrap()
            .len(),
        1
    );
}
#[test]
fn invalid_import_leaves_no_partial_project_or_asset() {
    let (dir, workspace, p) = fixture();
    let asset = workspace
        .import_asset(&p.id, "fixture.txt", "text/plain", b"verified bytes")
        .unwrap();
    let mut input = project_import(&p);
    let imported_id = input.project.id.clone();
    input.assets.push(ImportedAsset {
        asset,
        bytes: b"verified bytes".to_vec(),
    });
    input.records.push(input.records[0].clone());
    let count = workspace.list_projects().unwrap().len();
    assert!(workspace.import_project(input).is_err());
    assert_eq!(workspace.list_projects().unwrap().len(), count);
    assert!(!dir.path().join("projects").join(imported_id).exists());
    assert!(std::fs::read_dir(dir.path().join("projects"))
        .unwrap()
        .all(|e| !e
            .unwrap()
            .file_name()
            .to_string_lossy()
            .starts_with(".import-")));
}
#[test]
fn import_verifies_asset_bytes_and_project_scope() {
    let (_dir, workspace, p) = fixture();
    let asset = workspace
        .import_asset(&p.id, "fixture.txt", "text/plain", b"verified bytes")
        .unwrap();
    let mut input = project_import(&p);
    input.assets.push(ImportedAsset {
        asset,
        bytes: b"modified bytes".to_vec(),
    });
    assert_eq!(
        workspace.import_project(input).unwrap_err().code,
        "INTEGRITY"
    );
    let mut input = project_import(&p);
    input.records[0].project_id = p.id.clone();
    assert!(workspace.import_project(input).is_err());
    assert_eq!(workspace.list_projects().unwrap().len(), 1);
}
fn fixture() -> (tempfile::TempDir, Workspace, Project) {
    let dir = tempfile::tempdir().unwrap();
    let workspace = Workspace::open(dir.path()).unwrap();
    let at = now();
    let p = workspace
        .save_project(
            Project {
                id: new_id(),
                name: "Fixture".into(),
                description: "".into(),
                prefix: "TF".into(),
                color: "#783D49".into(),
                created_at: at.clone(),
                updated_at: at,
                archived: false,
                revision: 0,
            },
            0,
        )
        .unwrap();
    (dir, workspace, p)
}
fn document(p: &Project, title: &str) -> Entity {
    let at = now();
    Entity {
        id: new_id(),
        project_id: p.id.clone(),
        kind: "document".into(),
        title: title.into(),
        body: json!({"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"A durable observation"}]}]}),
        tags: vec![],
        data: json!({"evidenceIds":[],"private":false}),
        revision: 0,
        created_at: at.clone(),
        updated_at: at,
        deleted_at: None,
    }
}
#[test]
fn writes_survive_reopening() {
    let (dir, workspace, p) = fixture();
    let e = workspace.save_record(document(&p, "Original"), 0).unwrap();
    drop(workspace);
    let reopened = Workspace::open(dir.path()).unwrap();
    assert_eq!(reopened.get_record(&e.id, &p.id).unwrap().unwrap(), e);
}
#[test]
fn rejects_stale_revision_without_overwrite() {
    let (_dir, workspace, p) = fixture();
    let e = workspace.save_record(document(&p, "Original"), 0).unwrap();
    let mut updated = e.clone();
    updated.title = "Latest".into();
    let saved = workspace.save_record(updated, 1).unwrap();
    assert_eq!(
        workspace.save_record(e.clone(), 1).unwrap_err().code,
        "CONFLICT"
    );
    assert_eq!(
        workspace.get_record(&e.id, &p.id).unwrap().unwrap().title,
        saved.title
    );
}
#[test]
fn mismatched_payload_revision_is_rejected() {
    let (_dir, workspace, p) = fixture();
    let e = workspace.save_record(document(&p, "Original"), 0).unwrap();
    assert_eq!(workspace.save_record(e, 2).unwrap_err().code, "CONFLICT");
}
#[test]
fn trash_restore_preserves_history() {
    let (_dir, workspace, p) = fixture();
    let e = workspace.save_record(document(&p, "Original"), 0).unwrap();
    workspace.delete_record(&e.id, &p.id, 1).unwrap();
    let deleted = workspace.get_record(&e.id, &p.id).unwrap().unwrap();
    assert!(deleted.deleted_at.is_some());
    assert_eq!(
        workspace.save_record(deleted.clone(), 2).unwrap_err().code,
        "DELETED"
    );
    let restored = workspace.restore_record(&e.id, &p.id, 2).unwrap();
    assert_eq!(restored.revision, 3);
    assert!(restored.deleted_at.is_none());
    assert_eq!(workspace.get_revisions(&e.id, &p.id).unwrap().len(), 3);
}
#[test]
fn project_scope_and_filename_traversal_are_rejected() {
    let (_dir, workspace, p) = fixture();
    let e = workspace.save_record(document(&p, "Original"), 0).unwrap();
    assert!(workspace.get_record(&e.id, "../escape").is_err());
    assert!(workspace
        .import_asset(&p.id, "../secret", "text/plain", b"test")
        .is_err());
    assert!(workspace.read_asset(&p.id, "../../secret").is_err());
}
#[test]
fn only_one_process_can_own_workspace() {
    let (dir, _workspace, _p) = fixture();
    assert!(matches!(Workspace::open(dir.path()),Err(e) if e.code=="WORKSPACE_LOCKED"));
}
#[test]
fn backup_restores_independent_copy_with_history_and_verified_assets() {
    let (_dir, workspace, p) = fixture();
    let asset = workspace
        .import_asset(&p.id, "log.txt", "text/plain", b"retained log bytes")
        .unwrap();
    let mut evidence = document(&p, "Log");
    evidence.kind = "evidence".into();
    evidence.data = json!({"assetId":asset.id,"hash":asset.hash,"size":asset.size,"mimeType":"text/plain","filename":"log.txt","annotations":[],"private":true,"source":"import","caption":"Original"});
    let original = workspace.save_record(evidence, 0).unwrap();
    let backup = workspace.create_backup(&p.id).unwrap();
    let mut changed = original.clone();
    changed.title = "Later change".into();
    workspace.save_record(changed, 1).unwrap();
    let restored = workspace.restore_backup(&backup.id, &p.id).unwrap();
    assert_ne!(restored.id, p.id);
    assert_eq!(
        workspace
            .get_record(&original.id, &restored.id)
            .unwrap()
            .unwrap()
            .title,
        "Log"
    );
    assert_eq!(
        workspace
            .get_record(&original.id, &p.id)
            .unwrap()
            .unwrap()
            .title,
        "Later change"
    );
    assert_eq!(
        workspace.read_asset(&restored.id, &asset.id).unwrap(),
        b"retained log bytes"
    );
    assert_eq!(
        workspace
            .get_revisions(&original.id, &restored.id)
            .unwrap()
            .len(),
        1
    );
}
#[test]
fn corrupt_backup_does_not_publish_a_project() {
    let (dir, workspace, p) = fixture();
    workspace.save_record(document(&p, "Original"), 0).unwrap();
    let backup = workspace.create_backup(&p.id).unwrap();
    let count = workspace.list_projects().unwrap().len();
    std::fs::write(
        dir.path()
            .join("backups")
            .join(&backup.id)
            .join("workspace.sqlite"),
        b"corrupt",
    )
    .unwrap();
    assert!(workspace.restore_backup(&backup.id, &p.id).is_err());
    assert_eq!(workspace.list_projects().unwrap().len(), count);
}
#[test]
fn missing_evidence_asset_prevents_record_commit() {
    let (_dir, workspace, p) = fixture();
    let mut e = document(&p, "Missing asset");
    e.kind = "evidence".into();
    e.data =
        json!({"assetId":"a".repeat(64),"hash":"a".repeat(64),"size":4,"mimeType":"image/png"});
    assert!(workspace.save_record(e.clone(), 0).is_err());
    assert!(workspace.get_record(&e.id, &p.id).unwrap().is_none());
}
#[test]
fn search_cursor_detects_mutation() {
    let (_dir, workspace, p) = fixture();
    workspace
        .save_record(document(&p, "Address first"), 0)
        .unwrap();
    workspace
        .save_record(document(&p, "Address second"), 0)
        .unwrap();
    let query = RecordQuery {
        project_id: p.id.clone(),
        search: Some("Address".into()),
        limit: Some(1),
        ..Default::default()
    };
    let page = workspace.list_records(query.clone()).unwrap();
    assert_eq!(page.total, 2);
    assert!(page.next_cursor.is_some());
    workspace
        .save_record(document(&p, "Address third"), 0)
        .unwrap();
    assert_eq!(
        workspace
            .list_records(RecordQuery {
                cursor: page.next_cursor,
                ..query
            })
            .unwrap_err()
            .code,
        "STALE_CURSOR"
    );
}

#[test]
fn language_settings_migrate_validate_and_survive_reopening() {
    let (dir, workspace, p) = fixture();
    let mut settings = workspace.get_settings().unwrap();
    assert_eq!(settings.language, "hu");
    let mut legacy = serde_json::to_value(&settings).unwrap();
    legacy.as_object_mut().unwrap().remove("language");
    let migrated: AppSettings = serde_json::from_value(legacy).unwrap();
    assert_eq!(migrated.language, "hu");
    settings.language = "de".into();
    assert!(workspace.save_settings(settings.clone()).is_err());
    settings.language = "en".into();
    workspace.save_settings(settings).unwrap();
    let record = workspace
        .save_record(document(&p, "Settings ő ű"), 0)
        .unwrap();
    drop(workspace);
    let reopened = Workspace::open(dir.path()).unwrap();
    assert_eq!(reopened.get_settings().unwrap().language, "en");
    assert_eq!(
        reopened.get_record(&record.id, &p.id).unwrap().unwrap(),
        record
    );
}

#[test]
fn portable_backup_preserves_private_history_trash_and_original_assets_on_another_workspace() {
    let (dir, workspace, p) = fixture();
    let asset = workspace
        .import_asset(
            &p.id,
            "private.txt",
            "text/plain",
            b"original private evidence",
        )
        .unwrap();
    let mut evidence = document(&p, "Original caption");
    evidence.kind = "evidence".into();
    evidence.data = json!({"assetId":asset.id,"hash":asset.hash,"size":asset.size,"mimeType":"text/plain","filename":"private.txt","annotations":[],"private":true,"source":"import"});
    let record = workspace.save_record(evidence, 0).unwrap();
    let mut edited = record.clone();
    edited.title = "Revised caption".into();
    workspace.save_record(edited, 1).unwrap();
    workspace.delete_record(&record.id, &p.id, 2).unwrap();
    let backup = workspace.create_backup(&p.id).unwrap();
    let file = dir.path().join("portable.tracefold-backup");
    workspace
        .export_backup_file(&backup.id, &p.id, &file)
        .unwrap();
    let destination = tempfile::tempdir().unwrap();
    let other = Workspace::open(destination.path()).unwrap();
    let restored = other.restore_backup_file(&file).unwrap();
    assert_ne!(restored.id, p.id);
    drop(other);
    let reopened = Workspace::open(destination.path()).unwrap();
    let recovered = reopened
        .get_record(&record.id, &restored.id)
        .unwrap()
        .unwrap();
    assert_eq!(recovered.title, "Revised caption");
    assert!(recovered.deleted_at.is_some());
    assert_eq!(recovered.data["private"], true);
    assert_eq!(
        reopened.read_asset(&restored.id, &asset.id).unwrap(),
        b"original private evidence"
    );
    assert_eq!(
        reopened
            .get_revisions(&record.id, &restored.id)
            .unwrap()
            .len(),
        3
    );
    assert_eq!(workspace.list_projects().unwrap().len(), 1);
}

#[test]
fn damaged_portable_backups_never_publish_partial_projects() {
    let (dir, workspace, p) = fixture();
    workspace
        .import_asset(&p.id, "log.txt", "text/plain", b"asset payload")
        .unwrap();
    let backup = workspace.create_backup(&p.id).unwrap();
    let file = dir.path().join("backup.tracefold-backup");
    workspace
        .export_backup_file(&backup.id, &p.id, &file)
        .unwrap();
    let valid = std::fs::read(&file).unwrap();
    let count = workspace.list_projects().unwrap().len();
    let mut corrupt = valid.clone();
    *corrupt.last_mut().unwrap() ^= 1;
    let mut trailing = valid.clone();
    trailing.push(0);
    let mut oversized_header = valid.clone();
    oversized_header[12..16].copy_from_slice(&u32::MAX.to_le_bytes());
    let mut wrong_version = valid.clone();
    wrong_version[8] = 2;
    for invalid in [
        vec![],
        valid[..15].to_vec(),
        valid[..valid.len() - 1].to_vec(),
        corrupt,
        trailing,
        oversized_header,
        wrong_version,
    ] {
        std::fs::write(&file, invalid).unwrap();
        assert!(workspace.restore_backup_file(&file).is_err());
        assert_eq!(workspace.list_projects().unwrap().len(), count);
        assert!(!std::fs::read_dir(dir.path().join("projects"))
            .unwrap()
            .any(|entry| entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .starts_with('.')));
    }
}

#[test]
fn failed_backup_export_preserves_existing_destination() {
    let (dir, workspace, p) = fixture();
    let asset = workspace
        .import_asset(&p.id, "asset.txt", "text/plain", b"good bytes")
        .unwrap();
    let backup = workspace.create_backup(&p.id).unwrap();
    let output = dir.path().join("existing.tracefold-backup");
    std::fs::write(&output, b"existing backup remains intact").unwrap();
    std::fs::write(
        dir.path().join("backup-blobs").join(asset.id),
        b"bad! bytes",
    )
    .unwrap();
    assert!(workspace
        .export_backup_file(&backup.id, &p.id, &output)
        .is_err());
    assert_eq!(
        std::fs::read(output).unwrap(),
        b"existing backup remains intact"
    );
}

#[test]
fn imported_backup_rejects_unexpected_schema_even_with_matching_checksum() {
    let (dir, workspace, p) = fixture();
    let backup = workspace.create_backup(&p.id).unwrap();
    let backup_dir = dir.path().join("backups").join(&backup.id);
    let database = backup_dir.join("workspace.sqlite");
    let conn = rusqlite::Connection::open(&database).unwrap();
    conn.execute_batch(
        "CREATE TRIGGER injected AFTER UPDATE ON project BEGIN DELETE FROM records; END;",
    )
    .unwrap();
    drop(conn);
    let manifest_file = backup_dir.join("manifest.json");
    let mut manifest: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&manifest_file).unwrap()).unwrap();
    manifest["databaseHash"] = json!(crate::files::hash_bytes(&std::fs::read(&database).unwrap()));
    manifest["info"]["size"] = json!(database.metadata().unwrap().len());
    std::fs::write(&manifest_file, serde_json::to_vec(&manifest).unwrap()).unwrap();
    let file = dir.path().join("unexpected-schema.tracefold-backup");
    workspace
        .export_backup_file(&backup.id, &p.id, &file)
        .unwrap();
    assert_eq!(
        workspace.restore_backup_file(&file).unwrap_err().code,
        "UNSUPPORTED_SCHEMA"
    );
    assert_eq!(workspace.list_projects().unwrap().len(), 1);
}

/// The capability allowlist and the invoke handler drift silently: a command that is
/// registered but not allowed fails only at runtime, in a packaged build. v0.2.0 shipped
/// with the streaming plugin installer unreachable for exactly that reason.
#[test]
fn every_registered_command_is_permitted() {
    const LIB: &str = include_str!("lib.rs");
    const PERMISSIONS: &str = include_str!("../permissions/workspace.toml");

    let handler = LIB
        .split_once("tauri::generate_handler![")
        .expect("lib.rs must register an invoke handler")
        .1
        .split_once(']')
        .expect("the invoke handler list must be closed")
        .0;
    let registered: Vec<&str> = handler
        .split(',')
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .collect();

    let allowed_line = PERMISSIONS
        .lines()
        .find(|line| line.starts_with("commands.allow"))
        .expect("the workspace permission must declare commands.allow");
    let allowed: Vec<&str> = allowed_line
        .split('"')
        .skip(1)
        .step_by(2)
        .collect();

    assert!(!registered.is_empty(), "no commands were parsed from lib.rs");
    for command in &registered {
        assert!(
            allowed.contains(command),
            "command `{command}` is registered but missing from permissions/workspace.toml"
        );
    }
    for command in &allowed {
        assert!(
            registered.contains(command),
            "permissions/workspace.toml allows `{command}`, which is not a registered command"
        );
    }
}
