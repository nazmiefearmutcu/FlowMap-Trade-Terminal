// The commands the webview may call. Tauri denies every app command that no
// capability allows, so each one listed here is granted explicitly by
// capabilities/default.json and a new command stays private until both are edited.
const APP_COMMANDS: &[&str] = &[
    "sidecar_status",
    "retry_sidecar",
    "recording_settings",
    "set_recording_enabled",
    "open_log_folder",
];

fn main() {
    let manifest = tauri_build::AppManifest::new().commands(APP_COMMANDS);
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(manifest))
        .expect("failed to run the Tauri build script");
}
