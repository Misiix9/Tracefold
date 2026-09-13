mod backup;
mod capture;
mod catalog;
mod error;
mod files;
mod import;
mod menus;
mod model;
mod plugin_manager;
mod schema;
mod store;
#[cfg(test)]
mod tests;
mod transport;
mod updates;
use catalog::CatalogService;
use error::{AppError, Result};
use model::*;
use plugin_manager::{PluginInfo, PluginRuntime};
use sha2::{Digest, Sha256};
use std::sync::{atomic::{AtomicBool, Ordering}, Arc, Mutex};
use tauri::{Manager, State};
use tauri_plugin_dialog::DialogExt;
type Backend = Arc<Mutex<store::Workspace>>;

async fn work<T: Send + 'static>(state: &State<'_, Backend>, f: impl FnOnce(&store::Workspace) -> Result<T> + Send + 'static) -> Result<T> {
    let backend = Arc::clone(state.inner());
    tauri::async_runtime::spawn_blocking(move || {
        let guard = backend.lock().map_err(|_| AppError::new("STORAGE_UNAVAILABLE", "Storage stopped after an unexpected failure. Restart Tracefold to recover."))?;
        f(&guard)
    }).await.map_err(|_| AppError::new("STORAGE_UNAVAILABLE", "The storage worker stopped unexpectedly."))?
}

#[tauri::command]
async fn list_projects(state: State<'_, Backend>) -> Result<Vec<Project>> { work(&state, |s| s.list_projects()).await }
#[tauri::command]
async fn save_project(state: State<'_, Backend>, project: Project, expected_revision: u64) -> Result<Project> { work(&state, move |s| s.save_project(project, expected_revision)).await }
#[tauri::command]
async fn list_records(state: State<'_, Backend>, query: RecordQuery) -> Result<Page<Entity>> { work(&state, move |s| s.list_records(query)).await }
#[tauri::command]
async fn get_record(state: State<'_, Backend>, id: String, project_id: String) -> Result<Option<Entity>> { work(&state, move |s| s.get_record(&id, &project_id)).await }
#[tauri::command]
async fn save_record(state: State<'_, Backend>, record: Entity, expected_revision: u64) -> Result<Entity> { work(&state, move |s| s.save_record(record, expected_revision)).await }
#[tauri::command]
async fn delete_record(state: State<'_, Backend>, id: String, project_id: String, expected_revision: u64) -> Result<()> { work(&state, move |s| s.delete_record(&id, &project_id, expected_revision)).await }
#[tauri::command]
async fn restore_record(state: State<'_, Backend>, id: String, project_id: String, expected_revision: u64) -> Result<Entity> { work(&state, move |s| s.restore_record(&id, &project_id, expected_revision)).await }
#[tauri::command]
async fn get_revisions(state: State<'_, Backend>, id: String, project_id: String) -> Result<Vec<Revision>> { work(&state, move |s| s.get_revisions(&id, &project_id)).await }
#[tauri::command]
async fn get_settings(state: State<'_, Backend>) -> Result<AppSettings> { work(&state, |s| s.get_settings()).await }
#[tauri::command]
async fn save_settings(app: tauri::AppHandle, state: State<'_, Backend>, settings: AppSettings) -> Result<()> {
    let language = settings.language.clone();
    let changed = work(&state, move |s| { let changed = s.get_settings()?.language != settings.language; s.save_settings(settings)?; Ok(changed) }).await?;
    if changed { menus::apply(&app, &language).map_err(|_| AppError::new("MENU", "The language was saved, but the application menu could not refresh. Restart Tracefold."))?; }
    Ok(())
}
#[tauri::command]
async fn import_asset(state: State<'_, Backend>, request: tauri::ipc::Request<'_>) -> Result<Asset> {
    let project_id = transport::header(&request, "x-project-id")?;
    let filename = transport::header(&request, "x-filename")?;
    let mime_type = transport::header(&request, "x-mime-type")?;
    let bytes = transport::bytes(&request, files::MAX_ASSET_BYTES)?;
    work(&state, move |s| s.import_asset(&project_id, &filename, &mime_type, &bytes)).await
}
#[tauri::command]
async fn read_asset(state: State<'_, Backend>, project_id: String, asset_id: String) -> Result<tauri::ipc::Response> { work(&state, move |s| s.read_asset(&project_id, &asset_id)).await.map(tauri::ipc::Response::new) }
#[tauri::command]
async fn capture_capabilities() -> Result<CaptureCapabilities> { tauri::async_runtime::spawn_blocking(model::capture_capabilities).await.map_err(|_| AppError::new("CAPTURE_FAILED", "Could not inspect screenshot support.")) }
#[tauri::command]
async fn capture_screen(state: State<'_, Backend>, project_id: String) -> Result<Option<Asset>> {
    let scope = project_id.clone();
    let language = work(&state, move |s| { s.project_db(&scope)?; Ok(s.get_settings()?.language) }).await?;
    let bytes = tauri::async_runtime::spawn_blocking(move || capture::capture_png(&language)).await.map_err(|_| AppError::new("CAPTURE_FAILED", "The screenshot worker stopped unexpectedly."))??;
    work(&state, move |s| s.capture_screen(&project_id, bytes.as_deref())).await
}
#[tauri::command]
async fn create_backup(state: State<'_, Backend>, project_id: String) -> Result<BackupInfo> { work(&state, move |s| s.create_backup(&project_id)).await }
#[tauri::command]
async fn list_backups(state: State<'_, Backend>, project_id: String) -> Result<Vec<BackupInfo>> { work(&state, move |s| s.list_backups(&project_id)).await }
#[tauri::command]
async fn restore_backup(state: State<'_, Backend>, id: String, project_id: String) -> Result<Project> { work(&state, move |s| s.restore_backup(&id, &project_id)).await }
#[tauri::command]
async fn export_backup_file(app: tauri::AppHandle, state: State<'_, Backend>, id: String, project_id: String) -> Result<bool> {
    let destination = tauri::async_runtime::spawn_blocking(move || app.dialog().file().add_filter("Tracefold backup", &["tracefold-backup"]).set_file_name("Tracefold.tracefold-backup").blocking_save_file()).await.map_err(|_| AppError::new("SAVE_FAILED", "The file picker could not finish."))?;
    let Some(destination) = destination else { return Ok(false); };
    let path = destination.into_path().map_err(|_| AppError::new("PATH_SCOPE", "Choose a local file destination."))?;
    work(&state, move |s| s.export_backup_file(&id, &project_id, &path)).await?;
    Ok(true)
}
#[tauri::command]
async fn restore_backup_file(app: tauri::AppHandle, state: State<'_, Backend>) -> Result<Option<Project>> {
    let source = tauri::async_runtime::spawn_blocking(move || app.dialog().file().add_filter("Tracefold backup", &["tracefold-backup"]).blocking_pick_file()).await.map_err(|_| AppError::new("SAVE_FAILED", "The file picker could not finish."))?;
    let Some(source) = source else { return Ok(None); };
    let path = source.into_path().map_err(|_| AppError::new("PATH_SCOPE", "Choose a local backup file."))?;
    work(&state, move |s| s.restore_backup_file(&path)).await.map(Some)
}
#[tauri::command]
async fn storage_info(state: State<'_, Backend>) -> Result<StorageInfo> { work(&state, |s| s.storage_info()).await }
#[tauri::command]
async fn import_project(state: State<'_, Backend>, input: import::ProjectImport) -> Result<Project> { work(&state, move |s| s.import_project(input)).await }
#[tauri::command]
async fn save_file(app: tauri::AppHandle, request: tauri::ipc::Request<'_>) -> Result<bool> {
    let filename = transport::header(&request, "x-filename")?;
    let mime_type = transport::header(&request, "x-mime-type")?;
    let bytes = transport::bytes(&request, files::MAX_EXPORT_BYTES)?;
    files::validate_filename(&filename)?;
    files::validate_mime(&mime_type)?;
    if bytes.len() as u64 > files::MAX_EXPORT_BYTES { return Err(AppError::new("LIMIT_EXCEEDED", "Export exceeds 256 MiB.")); }
    tauri::async_runtime::spawn_blocking(move || {
        let destination = app.dialog().file().set_file_name(filename).blocking_save_file();
        let Some(destination) = destination else { return Ok(false); };
        let path = destination.into_path().map_err(|_| AppError::new("PATH_SCOPE", "Choose a local file destination."))?;
        files::atomic_write(&path, &bytes, true)?;
        Ok(true)
    }).await.map_err(|_| AppError::new("SAVE_FAILED", "The save operation could not finish."))?
}

fn plugin_window_label(id: &str) -> String {
    let digest = Sha256::digest(id.as_bytes());
    let hex = digest.iter().map(|byte| format!("{byte:02x}")).collect::<String>();
    format!("plugin-{hex}")
}

fn close_plugin_window(app: &tauri::AppHandle, id: &str) {
    let label = plugin_window_label(id);
    if let Some(window) = app.get_webview_window(&label) { let _ = window.close(); }
}

fn close_all_plugin_windows(app: &tauri::AppHandle) {
    for (label, window) in app.webview_windows() {
        if label.starts_with("plugin-") { let _ = window.close(); }
    }
}

async fn plugin_blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T> + Send + 'static) -> Result<T> {
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|_| AppError::new("PLUGIN_RUNTIME", "The plugin worker stopped unexpectedly."))?
}

#[tauri::command]
fn list_plugins(state: State<'_, Arc<PluginRuntime>>) -> Result<Vec<PluginInfo>> { state.list() }

/// Picking, reading, unpacking and installing all happen in Rust. The archive never
/// crosses the IPC boundary, so a 256 MiB package costs one file read instead of a
/// webview-sized copy of itself.
#[tauri::command]
async fn install_plugin_from_file(app: tauri::AppHandle, state: State<'_, Arc<PluginRuntime>>) -> Result<Option<PluginInfo>> {
    let runtime = Arc::clone(state.inner());
    let picker = app.clone();
    let installed = plugin_blocking(move || {
        let archive = plugin_manager::pick_plugin_archive(&picker)?;
        if archive.is_empty() {
            return Ok(None);
        }
        plugin_manager::install_package_bytes(&runtime, &archive, None).map(Some)
    })
    .await?;
    if let Some(info) = &installed {
        close_plugin_window(&app, &info.id);
    }
    Ok(installed)
}

/// A cheap conditional probe. The full check only runs when this says the feed moved.
#[tauri::command]
async fn update_feed_changed(state: State<'_, Arc<updates::FeedWatcher>>) -> Result<bool> {
    state.changed().await
}

#[tauri::command]
async fn fetch_plugin_catalog(state: State<'_, Arc<CatalogService>>) -> Result<catalog::CatalogResult> {
    state.fetch().await
}

#[tauri::command]
async fn install_catalog_plugin(app: tauri::AppHandle, state: State<'_, Arc<CatalogService>>, id: String, version: String) -> Result<PluginInfo> {
    let info = state.install(&id, &version).await?;
    close_plugin_window(&app, &info.id);
    Ok(info)
}

#[tauri::command]
async fn set_plugin_enabled(app: tauri::AppHandle, state: State<'_, Arc<PluginRuntime>>, id: String, enabled: bool) -> Result<()> {
    if !enabled { close_plugin_window(&app, &id); }
    let runtime = Arc::clone(state.inner());
    plugin_blocking(move || runtime.set_enabled(&id, enabled)).await
}

#[tauri::command]
async fn remove_plugin(app: tauri::AppHandle, state: State<'_, Arc<PluginRuntime>>, id: String) -> Result<()> {
    close_plugin_window(&app, &id);
    let runtime = Arc::clone(state.inner());
    plugin_blocking(move || runtime.remove(&id)).await
}

#[tauri::command]
async fn stop_plugin(app: tauri::AppHandle, state: State<'_, Arc<PluginRuntime>>, id: String) -> Result<()> {
    close_plugin_window(&app, &id);
    let runtime = Arc::clone(state.inner());
    plugin_blocking(move || runtime.stop(&id)).await
}

/// Start a plugin and hand back its loopback URL so the main window can host it inline.
/// The URL comes from host-owned runtime state, never from the plugin directory.
#[tauri::command]
async fn start_plugin(state: State<'_, Arc<PluginRuntime>>, id: String) -> Result<String> {
    let runtime = Arc::clone(state.inner());
    plugin_blocking(move || runtime.start(&id)).await
}

#[tauri::command]
async fn launch_plugin(app: tauri::AppHandle, state: State<'_, Arc<PluginRuntime>>, id: String) -> Result<()> {
    let label = plugin_window_label(&id);
    let runtime = Arc::clone(state.inner());
    let already_running = plugin_blocking({ let runtime = Arc::clone(&runtime); let id = id.clone(); move || runtime.is_running(&id) }).await?;
    if already_running {
        if let Some(window) = app.get_webview_window(&label) {
            let _ = window.show();
            let _ = window.set_focus();
            return Ok(());
        }
    } else {
        close_plugin_window(&app, &id);
    }
    let url = plugin_blocking({ let runtime = Arc::clone(&runtime); let id = id.clone(); move || runtime.start(&id) }).await?;
    let title = plugin_blocking({ let runtime = Arc::clone(&runtime); let id = id.clone(); move || runtime.info(&id).map(|info| info.name) }).await?;
    let parsed = url.parse().map_err(|_| AppError::new("PLUGIN_RUNTIME", "Plugin URL is invalid."))?;
    let build = tauri::WebviewWindowBuilder::new(&app, &label, tauri::WebviewUrl::External(parsed))
        .title(format!("{} · Tracefold", title))
        .inner_size(1280.0, 820.0)
        .min_inner_size(960.0, 620.0)
        .build();
    if let Err(error) = build {
        let runtime = Arc::clone(&runtime);
        let _ = plugin_blocking(move || runtime.stop(&id)).await;
        return Err(AppError::new("PLUGIN_WINDOW", &format!("Could not open plugin window: {error}")));
    }
    Ok(())
}

pub fn run() {
    let exiting = Arc::new(AtomicBool::new(false));
    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let root = app.path().app_local_data_dir()?;
            let workspace = store::Workspace::open(&root)?;
            let language = workspace.get_settings()?.language;
            let plugin_root = root.join("plugins");
            let plugins = Arc::new(PluginRuntime::open(plugin_root.clone())?);
            app.manage(Arc::new(Mutex::new(workspace)));
            app.manage(Arc::new(CatalogService::new(Arc::clone(&plugins), plugin_root)));
            app.manage(Arc::new(updates::FeedWatcher::new()));
            app.manage(plugins);
            menus::apply(app.handle(), &language)?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_projects, save_project, list_records, get_record, save_record, delete_record,
            restore_record, get_revisions, get_settings, save_settings, import_asset, read_asset,
            capture_capabilities, capture_screen, save_file, create_backup, list_backups, restore_backup,
            export_backup_file, restore_backup_file, storage_info, import_project, list_plugins,
            install_plugin_from_file, fetch_plugin_catalog, install_catalog_plugin, update_feed_changed,
            set_plugin_enabled, remove_plugin, stop_plugin, start_plugin, launch_plugin
        ])
        .build(tauri::generate_context!())
        .expect("Tracefold could not start")
        .run({
            let exiting = Arc::clone(&exiting);
            move |app, event| {
                match event {
                    tauri::RunEvent::WindowEvent { label, event: tauri::WindowEvent::CloseRequested { api, .. }, .. } if label == "main" => {
                        if !exiting.swap(true, Ordering::SeqCst) {
                            api.prevent_close();
                            app.state::<Arc<PluginRuntime>>().shutdown();
                            close_all_plugin_windows(app);
                            if let Some(window) = app.get_webview_window("main") { let _ = window.close(); }
                        }
                    }
                    tauri::RunEvent::ExitRequested { .. } => {
                        app.state::<Arc<PluginRuntime>>().shutdown();
                        close_all_plugin_windows(app);
                    }
                    tauri::RunEvent::Exit => {
                        app.state::<Arc<PluginRuntime>>().shutdown();
                    }
                    _ => {}
                }
            }
        });
}
