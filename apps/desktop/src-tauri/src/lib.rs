use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use tauri::{Emitter, Manager};
use tauri::{LogicalSize, PhysicalPosition, Position};
use tauri::image::Image;
use tauri_plugin_global_shortcut::{Code, Modifiers, ShortcutState};
use serde::Serialize;
use serde_json::json;

/// 与桌面 `main.js` 中 API 默认端口一致（若改 PORT 需同步）
const SCRAPE_SERVER_ORIGIN: &str = "http://127.0.0.1:2999";

fn post_playwright_visual_toggle() {
    let url = format!("{SCRAPE_SERVER_ORIGIN}/api/scrape/playwright-visual/toggle");
    match ureq::post(&url)
        .set("Content-Type", "application/json")
        .timeout(std::time::Duration::from_secs(8))
        .send_json(json!({}))
    {
        Ok(resp) => {
            if !(200..300).contains(&resp.status()) {
                eprintln!(
                    "[tray] playwright visual toggle: HTTP {}",
                    resp.status()
                );
            }
        }
        Err(err) => eprintln!("[tray] playwright visual toggle: {err}"),
    }
}

fn post_schedule_toggle(app: &tauri::AppHandle) {
    let url = format!("{SCRAPE_SERVER_ORIGIN}/api/scrape/schedule/toggle");
    match ureq::post(&url)
        .set("Content-Type", "application/json")
        .timeout(Duration::from_secs(8))
        .send_json(json!({}))
    {
        Ok(resp) => {
            if (200..300).contains(&resp.status()) {
                if let Ok(v) = resp.into_json::<serde_json::Value>() {
                    if let Some(s) = v.get("scheduled").and_then(|x| x.as_bool()) {
                        apply_schedule_visual(app, s);
                        return;
                    }
                }
                if let Some(s) = fetch_schedule_active() {
                    apply_schedule_visual(app, s);
                }
            } else {
                eprintln!(
                    "[shortcut] schedule toggle: HTTP {}",
                    resp.status()
                );
            }
        }
        Err(err) => eprintln!("[shortcut] schedule toggle: {err}"),
    }
}

fn fetch_schedule_active() -> Option<bool> {
    let url = format!("{SCRAPE_SERVER_ORIGIN}/api/status");
    let resp = ureq::get(&url)
        .timeout(Duration::from_secs(2))
        .call()
        .ok()?;
    if !(200..300).contains(&resp.status()) {
        return None;
    }
    let v: serde_json::Value = resp.into_json().ok()?;
    v.get("schedule_active").and_then(|x| x.as_bool())
}

fn schedule_tray_images() -> (Image<'static>, Image<'static>) {
    static CACHE: OnceLock<(Image<'static>, Image<'static>)> = OnceLock::new();
    CACHE
        .get_or_init(|| {
            const PNG: &[u8] = include_bytes!("../icons/32x32.png");
            let color = Image::from_bytes(PNG).expect("icons/32x32.png 无效，请在 apps/desktop 执行 pnpm icons");
            let mut rgba = color.rgba().to_vec();
            for px in rgba.chunks_exact_mut(4) {
                let a = px[3];
                if a == 0 {
                    continue;
                }
                let r = px[0] as f32;
                let g = px[1] as f32;
                let b = px[2] as f32;
                let y = (0.2126 * r + 0.7152 * g + 0.0722 * b).round().clamp(0.0, 255.0) as u8;
                px[0] = y;
                px[1] = y;
                px[2] = y;
            }
            let gray = Image::new_owned(rgba, color.width(), color.height());
            (color.to_owned(), gray)
        })
        .clone()
}

/// 托盘句柄，供暂停/恢复时切换彩色与灰阶图标。
#[derive(Clone)]
struct TrayIconSlot(Arc<Mutex<Option<tauri::tray::TrayIcon<tauri::Wry>>>>);

impl TrayIconSlot {
    fn new() -> Self {
        Self(Arc::new(Mutex::new(None)))
    }
}

fn apply_schedule_visual(app: &tauri::AppHandle, schedule_active: bool) {
    let (color, gray) = schedule_tray_images();
    let tray_img = if schedule_active {
        color.clone()
    } else {
        gray.clone()
    };

    if let Some(slot) = app.try_state::<TrayIconSlot>() {
        if let Ok(guard) = slot.0.lock() {
            if let Some(ref tray) = *guard {
                let _ = tray.set_icon(Some(tray_img.clone()));
            }
        }
    }

    let win_img = if schedule_active { color } else { gray };
    for label in ["main", "widget"] {
        if let Some(w) = app.get_webview_window(label) {
            let _ = w.set_icon(win_img.clone());
        }
    }
}

#[tauri::command]
fn set_schedule_icon_state(app: tauri::AppHandle, scheduled: bool) {
    apply_schedule_visual(&app, scheduled);
}

struct CmdDState {
    times: Vec<Instant>,
}

static CMD_D_STATE: OnceLock<Mutex<CmdDState>> = OnceLock::new();

fn cmd_d_state() -> &'static Mutex<CmdDState> {
    CMD_D_STATE.get_or_init(|| Mutex::new(CmdDState { times: Vec::new() }))
}

/// ⌘/Ctrl+D：同一连按串里**第 1 下立即已读**（无延迟）；550ms 内第 3 下切换定时抓取，第 2、3 下不再已读。
/// 若三连只为暂停抓取，第 1 下仍会触发已读。
fn handle_command_d_shortcut(app: &tauri::AppHandle) {
    const CHAIN_GAP: Duration = Duration::from_millis(550);

    let mut g = cmd_d_state().lock().unwrap_or_else(|e| e.into_inner());
    let now = Instant::now();
    g.times.retain(|t| now.duration_since(*t) <= CHAIN_GAP);
    g.times.push(now);

    if g.times.len() >= 3 {
        g.times.clear();
        drop(g);
        post_schedule_toggle(app);
        return;
    }

    if g.times.len() == 1 {
        drop(g);
        let _ = app.emit("mark-read-shortcut", ());
        let _ = app.emit_to("widget", "mark-read-shortcut", ());
        let _ = app.emit_to("main", "mark-read-shortcut", ());
    }
}

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
            sync_widget_position,
            set_schedule_icon_state
        ])
        .setup(|app| {
            let tray_slot = TrayIconSlot::new();
            app.manage(tray_slot.clone());

            app.handle().plugin(
                tauri_plugin_global_shortcut::Builder::new()
                    .with_shortcuts(["CommandOrControl+D"])?
                    .with_handler(|app, shortcut, event| {
                        if event.state != ShortcutState::Pressed {
                            return;
                        }
                        if shortcut.matches(Modifiers::SUPER, Code::KeyD)
                            || shortcut.matches(Modifiers::CONTROL, Code::KeyD)
                        {
                            handle_command_d_shortcut(app);
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
            let playwright_toggle_item = MenuItem::with_id(
                app,
                "playwright_visual_toggle",
                "切换抓取浏览器显示（开/关）",
                true,
                None::<&str>,
            )?;
            let quit_item = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(
                app,
                &[
                    &show_main_item,
                    &show_widget_item,
                    &playwright_toggle_item,
                    &quit_item,
                ],
            )?;
            let handle = app.handle().clone();
            let initial_schedule = fetch_schedule_active().unwrap_or(true);
            let (icon_color, icon_gray) = schedule_tray_images();
            let initial_icon = if initial_schedule {
                icon_color.clone()
            } else {
                icon_gray.clone()
            };

            let tray = TrayIconBuilder::new()
                .icon(initial_icon)
                .menu(&menu)
                .show_menu_on_left_click(true)
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "show_main" => show_main(app.clone()),
                    "show_widget" => show_widget(app.clone()),
                    "playwright_visual_toggle" => post_playwright_visual_toggle(),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .build(app)?;

            if let Ok(mut guard) = tray_slot.0.lock() {
                *guard = Some(tray);
            }

            apply_schedule_visual(&handle, initial_schedule);

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
