use tauri::{Emitter, Manager};
use tauri::{LogicalSize, PhysicalPosition, Position};
use tauri_plugin_global_shortcut::{Code, Modifiers, ShortcutState};
use serde::Serialize;

fn clamp(start: i32, size: i32, min: i32, max: i32) -> i32 {
    let max_start = max - size;
    if max_start < min {
        return min;
    }
    start.clamp(min, max_start)
}

fn keep_widget_visible(app: &tauri::AppHandle) {
    let Some(widget) = app.get_webview_window("widget") else {
        return;
    };
    let (Ok(pos), Ok(size)) = (widget.outer_position(), widget.outer_size()) else {
        return;
    };
    let monitor = widget
        .current_monitor()
        .ok()
        .flatten()
        .or_else(|| app.primary_monitor().ok().flatten());
    let Some(m) = monitor else {
        return;
    };
    let left = m.position().x;
    let top = m.position().y;
    let right = left + m.size().width as i32;
    let bottom = top + m.size().height as i32;
    let x = clamp(pos.x, size.width as i32, left, right);
    let y = clamp(pos.y, size.height as i32, top, bottom);
    let _ = widget.set_position(Position::Physical(PhysicalPosition::new(x, y)));
}

fn get_widget_monitor(app: &tauri::AppHandle, widget: &tauri::WebviewWindow) -> Option<tauri::Monitor> {
    widget
        .current_monitor()
        .ok()
        .flatten()
        .or_else(|| app.primary_monitor().ok().flatten())
}

#[derive(Serialize)]
struct WidgetSize {
    width: f64,
    height: f64,
}

#[derive(Serialize)]
struct WidgetDock {
    vertical: String,
    horizontal: String,
}

#[tauri::command]
fn show_main(app: tauri::AppHandle) {
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.show();
        let _ = main.set_focus();
    }
    if let Some(widget) = app.get_webview_window("widget") {
        let _ = widget.hide();
    }
}

#[tauri::command]
fn show_widget(app: tauri::AppHandle) {
    if let Some(widget) = app.get_webview_window("widget") {
        let _ = widget.show();
        // Intentionally no set_focus: avoid stealing focus when the widget appears for new items.
    }
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.hide();
    }
    keep_widget_visible(&app);
}

#[tauri::command]
fn hide_widget(app: tauri::AppHandle) {
    if let Some(widget) = app.get_webview_window("widget") {
        let _ = widget.hide();
    }
}

#[tauri::command]
fn toggle_windows(app: tauri::AppHandle) {
    if let Some(main) = app.get_webview_window("main") {
        if main.is_visible().unwrap_or(false) {
            show_widget(app);
        } else {
            show_main(app);
        }
    }
}

#[tauri::command]
fn start_dragging(app: tauri::AppHandle, label: String) {
    if let Some(window) = app.get_webview_window(&label) {
        let _ = window.start_dragging();
    }
}

#[tauri::command]
fn resize_widget(
    app: tauri::AppHandle,
    width: f64,
    height: f64,
    anchor_vertical: Option<String>,
    anchor_horizontal: Option<String>,
) {
    if let Some(widget) = app.get_webview_window("widget") {
        let logical_width = width.max(50.0);
        let logical_height = height.max(50.0);

        if let (Ok(pos), Ok(size)) = (widget.outer_position(), widget.outer_size()) {
            let scale = widget
                .scale_factor()
                .ok()
                .filter(|v| *v > 0.0)
                .unwrap_or(1.0);
            let target_width = (logical_width * scale).round() as i32;
            let target_height = (logical_height * scale).round() as i32;
            let current_bottom = pos.y + size.height as i32;
            let current_right = pos.x + size.width as i32;

            let mut next_x = if anchor_horizontal.as_deref() == Some("right") {
                current_right - target_width
            } else {
                pos.x
            };
            let mut next_y = if anchor_vertical.as_deref() == Some("top") {
                pos.y
            } else {
                current_bottom - target_height
            };

            if let Some(monitor) = get_widget_monitor(&app, &widget) {
                let left = monitor.position().x;
                let top = monitor.position().y;
                let right = left + monitor.size().width as i32;
                let bottom = top + monitor.size().height as i32;

                next_x = clamp(next_x, target_width, left, right);
                next_y = clamp(next_y, target_height, top, bottom);
            }

            let _ = widget.set_size(LogicalSize::new(logical_width, logical_height));
            let _ = widget.set_position(Position::Physical(PhysicalPosition::new(next_x, next_y)));
            return;
        }

        let _ = widget.set_size(LogicalSize::new(logical_width, logical_height));
        keep_widget_visible(&app);
    }
}

#[tauri::command]
fn get_widget_size(app: tauri::AppHandle) -> Option<WidgetSize> {
    let widget = app.get_webview_window("widget")?;
    let size = widget.outer_size().ok()?;
    let scale = widget
        .scale_factor()
        .ok()
        .filter(|v| *v > 0.0)
        .unwrap_or(1.0);
    Some(WidgetSize {
        width: (size.width as f64) / scale,
        height: (size.height as f64) / scale,
    })
}

#[tauri::command]
fn resize_widget_height(
    app: tauri::AppHandle,
    height: f64,
    anchor_vertical: Option<String>,
    anchor_horizontal: Option<String>,
) {
    if let Some(widget) = app.get_webview_window("widget") {
        let logical_height = height.max(50.0);

        if let (Ok(pos), Ok(size)) = (widget.outer_position(), widget.outer_size()) {
            let scale = widget
                .scale_factor()
                .ok()
                .filter(|v| *v > 0.0)
                .unwrap_or(1.0);
            let logical_width = ((size.width as f64) / scale).max(280.0);
            let target_width = size.width as i32;
            let target_height = (logical_height * scale).round() as i32;
            let current_bottom = pos.y + size.height as i32;
            let current_right = pos.x + size.width as i32;

            let mut next_x = if anchor_horizontal.as_deref() == Some("right") {
                current_right - target_width
            } else {
                pos.x
            };
            let mut next_y = if anchor_vertical.as_deref() == Some("top") {
                pos.y
            } else {
                current_bottom - target_height
            };

            if let Some(monitor) = get_widget_monitor(&app, &widget) {
                let left = monitor.position().x;
                let top = monitor.position().y;
                let right = left + monitor.size().width as i32;
                let bottom = top + monitor.size().height as i32;

                next_x = clamp(next_x, target_width, left, right);
                next_y = clamp(next_y, target_height, top, bottom);
            }

            let _ = widget.set_size(LogicalSize::new(logical_width, logical_height));
            let _ = widget.set_position(Position::Physical(PhysicalPosition::new(next_x, next_y)));
            return;
        }

        let _ = widget.set_size(LogicalSize::new(420.0, logical_height));
        keep_widget_visible(&app);
    }
}

#[tauri::command]
fn sync_widget_position(app: tauri::AppHandle) {
    keep_widget_visible(&app);
}

#[tauri::command]
fn get_widget_dock(app: tauri::AppHandle) -> Option<WidgetDock> {
    let widget = app.get_webview_window("widget")?;
    let pos = widget.outer_position().ok()?;
    let size = widget.outer_size().ok()?;
    let monitor = get_widget_monitor(&app, &widget)?;

    let left_gap = pos.x - monitor.position().x;
    let top_gap = pos.y - monitor.position().y;
    let right_gap = (monitor.position().x + monitor.size().width as i32) - (pos.x + size.width as i32);
    let bottom_gap = (monitor.position().y + monitor.size().height as i32) - (pos.y + size.height as i32);

    let vertical = if top_gap <= bottom_gap { "top" } else { "bottom" };
    let horizontal = if left_gap <= right_gap { "left" } else { "right" };

    Some(WidgetDock {
        vertical: String::from(vertical),
        horizontal: String::from(horizontal),
    })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    use tauri::menu::{Menu, MenuItem};
    use tauri::tray::TrayIconBuilder;

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            show_main,
            show_widget,
            hide_widget,
            toggle_windows,
            start_dragging,
            resize_widget,
            resize_widget_height,
            get_widget_size,
            get_widget_dock,
            sync_widget_position
        ])
        .setup(|app| {
            app.handle().plugin(
                tauri_plugin_global_shortcut::Builder::new()
                    .with_shortcuts(["CommandOrControl+D"])?
                    .with_handler(|app, shortcut, event| {
                        if event.state == ShortcutState::Pressed
                            && (shortcut.matches(Modifiers::SUPER, Code::KeyD)
                                || shortcut.matches(Modifiers::CONTROL, Code::KeyD))
                        {
                            let _ = app.emit("mark-read-shortcut", ());
                            let _ = app.emit_to("widget", "mark-read-shortcut", ());
                            let _ = app.emit_to("main", "mark-read-shortcut", ());
                        }
                    })
                    .build(),
            )?;

            if let Some(widget) = app.get_webview_window("widget") {
                #[cfg(target_os = "macos")]
                {
                    let _ = widget.set_visible_on_all_workspaces(true);
                }
                let _ = widget.show();
            }
            if let Some(main) = app.get_webview_window("main") {
                let _ = main.hide();
            }
            keep_widget_visible(&app.handle().clone());

            let show_main_item =
                MenuItem::with_id(app, "show_main", "Show Main Window", true, None::<&str>)?;
            let show_widget_item =
                MenuItem::with_id(app, "show_widget", "Show Widget Window", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_main_item, &show_widget_item, &quit_item])?;
            let icon = app.default_window_icon().cloned().expect("icon not found");

            TrayIconBuilder::new()
                .icon(icon)
                .menu(&menu)
                .show_menu_on_left_click(true)
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "show_main" => show_main(app.clone()),
                    "show_widget" => show_widget(app.clone()),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .build(app)?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
