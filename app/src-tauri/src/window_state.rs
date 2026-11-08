//! The main window's saved size and position, and where it may be restored.

use std::fs;
use std::io;
use std::path::Path;

use tauri::AppHandle;

use crate::write_atomically;

/// The last window placement, persisted in the app-data dir.
const WINDOW_STATE_FILE: &str = "window-state.json";

/// The window placement saved at close, in logical pixels.
#[derive(Debug, Clone, Copy, PartialEq, serde::Serialize, serde::Deserialize)]
pub(crate) struct WindowState {
    pub(crate) x: f64,
    pub(crate) y: f64,
    pub(crate) width: f64,
    pub(crate) height: f64,
}

/// A monitor's usable area (its work area, without the taskbar), in logical pixels.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct LogicalArea {
    pub(crate) x: f64,
    pub(crate) y: f64,
    pub(crate) width: f64,
    pub(crate) height: f64,
}

/// A saved size below this is treated as a corrupt file, not a choice.
pub(crate) const MIN_RESTORED_SIZE: (f64, f64) = (400.0, 300.0);
/// A restored window uses at most this share of the monitor it lands on.
pub(crate) const RESTORED_SHARE: f64 = 0.9;
/// The point the monitor check uses: this far below the window's top edge, on the
/// title bar. A window whose title bar is on no monitor cannot be dragged back.
pub(crate) const TITLE_GRAB_OFFSET: f64 = 16.0;

pub(crate) fn read_window_state(data_dir: &Path) -> Option<WindowState> {
    let content = fs::read_to_string(data_dir.join(WINDOW_STATE_FILE)).ok()?;
    serde_json::from_str(&content).ok()
}

pub(crate) fn write_window_state(data_dir: &Path, state: WindowState) -> io::Result<()> {
    fs::create_dir_all(data_dir)?;
    let json = serde_json::to_string(&state).map_err(io::Error::other)?;
    write_atomically(&data_dir.join(WINDOW_STATE_FILE), json.as_bytes())
}

/// Where a saved window goes on the current monitors. Returns None when the saved
/// placement cannot be used, so the caller centres the window instead: the saved
/// values are not finite or too small, or the title bar is on no monitor (a display
/// was unplugged). Otherwise the size is fitted to the monitor it lands on, and the
/// position is pulled back inside that monitor's area.
pub(crate) fn place_window(saved: WindowState, areas: &[LogicalArea]) -> Option<WindowState> {
    let finite = [saved.x, saved.y, saved.width, saved.height]
        .iter()
        .all(|value| value.is_finite());
    if !finite || saved.width < MIN_RESTORED_SIZE.0 || saved.height < MIN_RESTORED_SIZE.1 {
        return None;
    }
    let grab_x = saved.x + saved.width / 2.0;
    let grab_y = saved.y + TITLE_GRAB_OFFSET;
    let area = areas.iter().find(|area| {
        grab_x >= area.x
            && grab_x < area.x + area.width
            && grab_y >= area.y
            && grab_y < area.y + area.height
    })?;
    let width = saved.width.min(area.width * RESTORED_SHARE);
    let height = saved.height.min(area.height * RESTORED_SHARE);
    let x = saved.x.min(area.x + area.width - width).max(area.x);
    let y = saved.y.min(area.y + area.height - height).max(area.y);
    Some(WindowState {
        x,
        y,
        width,
        height,
    })
}

/// Every connected monitor's work area, in logical pixels.
pub(crate) fn logical_areas(app: &AppHandle) -> Vec<LogicalArea> {
    let monitors = app.available_monitors().unwrap_or_default();
    monitors
        .iter()
        .map(|monitor| {
            let area = monitor.work_area();
            let scale = monitor.scale_factor().max(1.0);
            LogicalArea {
                x: f64::from(area.position.x) / scale,
                y: f64::from(area.position.y) / scale,
                width: f64::from(area.size.width) / scale,
                height: f64::from(area.size.height) / scale,
            }
        })
        .collect()
}

/// The window's placement for the next launch. A minimised or maximised window
/// has no placement worth keeping, so nothing is saved for it.
pub(crate) fn current_window_state(window: &tauri::Window) -> Option<WindowState> {
    if window.is_minimized().unwrap_or(true) || window.is_maximized().unwrap_or(true) {
        return None;
    }
    let scale = window.scale_factor().ok()?.max(1.0);
    let position = window.outer_position().ok()?;
    let size = window.inner_size().ok()?;
    Some(WindowState {
        x: f64::from(position.x) / scale,
        y: f64::from(position.y) / scale,
        width: f64::from(size.width) / scale,
        height: f64::from(size.height) / scale,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn screen(x: f64, y: f64, width: f64, height: f64) -> LogicalArea {
        LogicalArea {
            x,
            y,
            width,
            height,
        }
    }

    #[test]
    fn a_saved_placement_on_a_connected_monitor_is_kept() {
        let areas = [screen(0.0, 0.0, 1920.0, 1040.0)];
        let saved = WindowState {
            x: 100.0,
            y: 80.0,
            width: 1200.0,
            height: 800.0,
        };
        assert_eq!(place_window(saved, &areas), Some(saved));
    }

    #[test]
    fn a_placement_on_a_monitor_that_is_gone_is_not_restored() {
        let areas = [screen(0.0, 0.0, 1920.0, 1040.0)];
        let saved = WindowState {
            x: 4000.0,
            y: 80.0,
            width: 1200.0,
            height: 800.0,
        };
        assert_eq!(
            place_window(saved, &areas),
            None,
            "the caller centres the window instead"
        );
    }

    #[test]
    fn a_monitor_left_of_the_primary_one_has_a_negative_origin_and_is_kept() {
        let areas = [
            screen(0.0, 0.0, 1920.0, 1040.0),
            screen(-1920.0, 0.0, 1920.0, 1040.0),
        ];
        let saved = WindowState {
            x: -1800.0,
            y: 100.0,
            width: 1200.0,
            height: 800.0,
        };
        assert_eq!(place_window(saved, &areas), Some(saved));
    }

    #[test]
    fn a_window_larger_than_its_new_monitor_is_fitted_and_pulled_inside() {
        let areas = [screen(0.0, 0.0, 1280.0, 720.0)];
        let saved = WindowState {
            x: 300.0,
            y: 300.0,
            width: 1400.0,
            height: 900.0,
        };
        let placed = place_window(saved, &areas).expect("the title bar is on the screen");
        assert_eq!(placed.width, 1280.0 * RESTORED_SHARE);
        assert_eq!(placed.height, 720.0 * RESTORED_SHARE);
        assert!(
            placed.x >= 0.0 && placed.x + placed.width <= 1280.0,
            "{placed:?}"
        );
        assert!(
            placed.y >= 0.0 && placed.y + placed.height <= 720.0,
            "{placed:?}"
        );
    }

    #[test]
    fn a_corrupt_placement_is_not_restored() {
        let areas = [screen(0.0, 0.0, 1920.0, 1040.0)];
        let not_a_number = WindowState {
            x: f64::NAN,
            y: 0.0,
            width: 1200.0,
            height: 800.0,
        };
        let tiny = WindowState {
            x: 10.0,
            y: 10.0,
            width: 120.0,
            height: 90.0,
        };
        assert_eq!(place_window(not_a_number, &areas), None);
        assert_eq!(place_window(tiny, &areas), None);
    }

    #[test]
    fn the_window_state_file_round_trips_and_a_bad_one_is_ignored() {
        let dir = std::env::temp_dir().join(format!("flowmap-win-state-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!(read_window_state(&dir), None);
        let state = WindowState {
            x: 12.5,
            y: 40.0,
            width: 1280.0,
            height: 800.0,
        };
        write_window_state(&dir, state).expect("write");
        assert_eq!(read_window_state(&dir), Some(state));
        std::fs::write(dir.join(WINDOW_STATE_FILE), "{ broken").unwrap();
        assert_eq!(read_window_state(&dir), None);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
