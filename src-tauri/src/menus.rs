use tauri::{
    menu::{Menu, PredefinedMenuItem as Item, Submenu},
    AppHandle,
};

/// Application menu labels follow the saved language; OS-owned dialogs follow the OS locale.
pub fn apply(app: &AppHandle, language: &str) -> tauri::Result<()> {
    let tr = |en: &'static str, hu: &'static str| if language == "hu" { hu } else { en };
    let menu = Menu::new(app)?;
    #[cfg(target_os = "macos")]
    menu.append(&Submenu::with_items(
        app,
        "Tracefold",
        true,
        &[
            &Item::about(
                app,
                Some(tr("About Tracefold", "A Tracefold névjegye")),
                None,
            )?,
            &Item::separator(app)?,
            &Item::services(app, Some(tr("Services", "Szolgáltatások")))?,
            &Item::separator(app)?,
            &Item::hide(app, Some(tr("Hide Tracefold", "Tracefold elrejtése")))?,
            &Item::hide_others(app, Some(tr("Hide Others", "Többi elrejtése")))?,
            &Item::show_all(app, Some(tr("Show All", "Összes megjelenítése")))?,
            &Item::separator(app)?,
            &Item::quit(app, Some(tr("Quit Tracefold", "Kilépés a Tracefoldból")))?,
        ],
    )?)?;
    let file = Submenu::with_items(
        app,
        tr("File", "Fájl"),
        true,
        &[&Item::close_window(
            app,
            Some(tr("Close Window", "Ablak bezárása")),
        )?],
    )?;
    #[cfg(not(target_os = "macos"))]
    file.append(&Item::quit(
        app,
        Some(tr("Quit Tracefold", "Kilépés a Tracefoldból")),
    )?)?;
    menu.append(&file)?;
    let edit = Submenu::new(app, tr("Edit", "Szerkesztés"), true)?;
    #[cfg(target_os = "macos")]
    edit.append_items(&[
        &Item::undo(app, Some(tr("Undo", "Visszavonás")))?,
        &Item::redo(app, Some(tr("Redo", "Ismétlés")))?,
        &Item::separator(app)?,
    ])?;
    edit.append_items(&[
        &Item::cut(app, Some(tr("Cut", "Kivágás")))?,
        &Item::copy(app, Some(tr("Copy", "Másolás")))?,
        &Item::paste(app, Some(tr("Paste", "Beillesztés")))?,
        &Item::select_all(app, Some(tr("Select All", "Összes kijelölése")))?,
    ])?;
    menu.append(&edit)?;
    let window = Submenu::with_items(
        app,
        tr("Window", "Ablak"),
        true,
        &[
            &Item::minimize(app, Some(tr("Minimize", "Kis méret")))?,
            &Item::maximize(app, Some(tr("Zoom", "Nagyítás")))?,
        ],
    )?;
    #[cfg(target_os = "macos")]
    window.append_items(&[
        &Item::fullscreen(
            app,
            Some(tr("Toggle Full Screen", "Teljes képernyő váltása")),
        )?,
        &Item::bring_all_to_front(app, Some(tr("Bring All to Front", "Összes előrehozása")))?,
    ])?;
    menu.append(&window)?;
    app.set_menu(menu)?;
    Ok(())
}
