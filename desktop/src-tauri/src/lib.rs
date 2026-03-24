use tauri::{Emitter, Manager};
use tauri::{LogicalPosition, LogicalSize, Position};
use tauri_plugin_global_shortcut::{Code, Modifiers, ShortcutState};

fn get_widget_monitor(
    app: &tauri::AppHandle,
    widget: &tauri::WebviewWindow,
) -> Option<tauri::Monitor> {
    widget
        .current_monitor()
        .ok()
        .flatten()
        .or_else(|| app.primary_monitor().ok().flatten())
}

fn clamp_to_visible_range(start: i32, size: i32, min: i32, max: i32) -> i32 {
    let max_start = max - size;
    if max_start < min {
        return min;
    }
    start.clamp(min, max_start)
}

fn keep_widget_visible(app: &tauri::AppHandle, widget: &tauri::WebviewWindow) {
    let (Ok(pos), Ok(size)) = (widget.outer_position(), widget.outer_size()) else {
        return;
    };
    let Some(monitor) = get_widget_monitor(app, widget) else {
        return;
    };

    let monitor_left = monitor.position().x;
    let monitor_top = monitor.position().y;
    let monitor_right = monitor.position().x + monitor.size().width as i32;
    let monitor_bottom = monitor.position().y + monitor.size().height as i32;

    let width = size.width as i32;
    let height = size.height as i32;
    let target_x = clamp_to_visible_range(pos.x, width, monitor_left, monitor_right);
    let target_y = clamp_to_visible_range(pos.y, height, monitor_top, monitor_bottom);

    if target_x != pos.x || target_y != pos.y {
        let _ = widget.set_position(Position::Logical(LogicalPosition::new(
            target_x as f64,
            target_y as f64,
        )));
    }
}

#[tauri::command]
fn show_panel(app: tauri::AppHandle) {
    if let Some(panel) = app.get_webview_window("panel") {
        let _ = panel.show();
        let _ = panel.set_focus();
    }
    if let Some(widget) = app.get_webview_window("widget") {
        let _ = widget.hide();
    }
}

#[tauri::command]
fn show_widget(app: tauri::AppHandle) {
    if let Some(widget) = app.get_webview_window("widget") {
        #[cfg(target_os = "macos")]
        {
            let _ = widget.set_visible_on_all_workspaces(true);
        }
        keep_widget_visible(&app, &widget);
        let _ = widget.show();
        let _ = widget.set_focus();
    }
    if let Some(panel) = app.get_webview_window("panel") {
        let _ = panel.hide();
    }
}

#[tauri::command]
fn recover_widget(app: tauri::AppHandle) {
    if let Some(widget) = app.get_webview_window("widget") {
        #[cfg(target_os = "macos")]
        {
            let _ = widget.set_visible_on_all_workspaces(true);
        }

        if let (Ok(size), Some(monitor)) = (widget.outer_size(), get_widget_monitor(&app, &widget))
        {
            let monitor_left = monitor.position().x;
            let monitor_top = monitor.position().y;
            let monitor_right = monitor.position().x + monitor.size().width as i32;
            let monitor_bottom = monitor.position().y + monitor.size().height as i32;
            let target_x = clamp_to_visible_range(
                monitor_right - size.width as i32 - 24,
                size.width as i32,
                monitor_left,
                monitor_right,
            );
            let target_y = clamp_to_visible_range(
                monitor_top + 80,
                size.height as i32,
                monitor_top,
                monitor_bottom,
            );
            let _ = widget.set_position(Position::Logical(LogicalPosition::new(
                target_x as f64,
                target_y as f64,
            )));
        } else {
            keep_widget_visible(&app, &widget);
        }

        let _ = widget.show();
        let _ = widget.set_focus();
    }

    if let Some(panel) = app.get_webview_window("panel") {
        let _ = panel.hide();
    }
}

#[tauri::command]
fn start_dragging(app: tauri::AppHandle, label: String) {
    if let Some(win) = app.get_webview_window(&label) {
        let _ = win.start_dragging();
    }
}

#[tauri::command]
fn resize_window(app: tauri::AppHandle, label: String, width: f64, height: f64) {
    if let Some(win) = app.get_webview_window(&label) {
        // Keep widget bottom edge fixed while resizing so the toolbar
        // (placed at the bottom in compact mode) won't be pushed off-screen.
        if label == "widget" {
            if let (Ok(pos), Ok(size)) = (win.outer_position(), win.outer_size()) {
                let current_bottom = pos.y + size.height as i32;
                let target_width = width.max(1.0) as i32;
                let target_height = height.max(84.0) as i32;

                let mut target_x = pos.x;
                let mut target_y = current_bottom - target_height;
                if let Some(monitor) = get_widget_monitor(&app, &win) {
                    let monitor_left = monitor.position().x;
                    let monitor_top = monitor.position().y;
                    let monitor_right = monitor.position().x + monitor.size().width as i32;
                    let monitor_bottom = monitor.position().y + monitor.size().height as i32;
                    let max_y = monitor_bottom - target_height;
                    if target_y < monitor_top {
                        target_y = monitor_top;
                    }
                    if target_y > max_y {
                        target_y = max_y;
                    }
                    target_x =
                        clamp_to_visible_range(pos.x, target_width, monitor_left, monitor_right);
                }

                let _ = win.set_size(LogicalSize::new(width, height));
                let _ = win.set_position(Position::Logical(LogicalPosition::new(
                    target_x as f64,
                    target_y as f64,
                )));
                return;
            }
        }
        let _ = win.set_size(LogicalSize::new(width, height));
    }
}

#[tauri::command]
fn sync_widget_position(app: tauri::AppHandle) -> Option<String> {
    let win = app.get_webview_window("widget")?;
    let outer = win.outer_position().ok()?;
    let size = win.outer_size().ok()?;
    let monitor = get_widget_monitor(&app, &win)?;

    let monitor_left = monitor.position().x;
    let monitor_top = monitor.position().y;
    let monitor_right = monitor.position().x + monitor.size().width as i32;
    let monitor_bottom = monitor.position().y + monitor.size().height as i32;
    let window_bottom = outer.y + size.height as i32;
    let snapped_x = clamp_to_visible_range(outer.x, size.width as i32, monitor_left, monitor_right);

    let top_gap = outer.y - monitor_top;
    let bottom_gap = monitor_bottom - window_bottom;
    let threshold = 28;

    let dock = if top_gap <= bottom_gap {
        "top"
    } else {
        "bottom"
    };

    if top_gap <= threshold {
        let _ = win.set_position(Position::Logical(LogicalPosition::new(
            snapped_x as f64,
            monitor_top as f64,
        )));
        return Some(String::from("top"));
    }

    if bottom_gap <= threshold {
        let target_y = monitor_bottom - size.height as i32;
        let _ = win.set_position(Position::Logical(LogicalPosition::new(
            snapped_x as f64,
            target_y as f64,
        )));
        return Some(String::from("bottom"));
    }

    Some(String::from(dock))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    use tauri::menu::{Menu, MenuItem};
    use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
    use tauri::Manager;

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            show_panel,
            show_widget,
            recover_widget,
            start_dragging,
            resize_window,
            sync_widget_position
        ])
        .setup(|app| {
            let app_handle = app.handle().clone();
            if let Some(widget) = app.get_webview_window("widget") {
                #[cfg(target_os = "macos")]
                {
                    let _ = widget.set_visible_on_all_workspaces(true);
                }
                let _ = widget.show();
                keep_widget_visible(&app_handle, &widget);
            }

            app.handle().plugin(
                tauri_plugin_global_shortcut::Builder::new()
                    .with_shortcuts(["CommandOrControl+D"])?
                    .with_handler(|app, shortcut, event| {
                        if event.state == ShortcutState::Pressed
                            && (shortcut.matches(Modifiers::SUPER, Code::KeyD)
                                || shortcut.matches(Modifiers::CONTROL, Code::KeyD))
                        {
                            let _ = app.emit("mark-read-shortcut", ());
                        }
                    })
                    .build(),
            )?;

            let panel_item =
                MenuItem::with_id(app, "show_panel", "Show Panel", true, None::<&str>)?;
            let widget_item =
                MenuItem::with_id(app, "show_widget", "Show Widget", true, None::<&str>)?;
            let recover_item =
                MenuItem::with_id(app, "recover_widget", "Recover Widget", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu =
                Menu::with_items(app, &[&panel_item, &widget_item, &recover_item, &quit_item])?;

            let icon = app.default_window_icon().cloned().expect("icon not found");

            TrayIconBuilder::new()
                .icon(icon)
                .menu(&menu)
                .show_menu_on_left_click(true)
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "show_panel" => {
                        show_panel(app.clone());
                    }
                    "show_widget" => {
                        show_widget(app.clone());
                    }
                    "recover_widget" => {
                        recover_widget(app.clone());
                    }
                    "quit" => {
                        app.exit(0);
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        let app = tray.app_handle();
                        if let Some(panel) = app.get_webview_window("panel") {
                            let visible = panel.is_visible().unwrap_or(false);
                            if visible {
                                show_widget(app.clone());
                            } else {
                                show_panel(app.clone());
                            }
                        }
                    }
                })
                .build(app)?;

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
