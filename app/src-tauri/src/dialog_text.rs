//! Interface language of native dialogs, and the dialog text itself.
//!
//! The shell cannot read the webview's language setting, so the OS locale decides.

#[cfg(target_os = "macos")]
use std::process::Command;
#[cfg(windows)]
use windows::Win32::Globalization::GetUserDefaultLocaleName;

/// Interface language of native dialogs. Taken from the OS locale because the
/// shell cannot read the webview's own language setting.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Lang {
    En,
    Tr,
}

#[derive(Debug, Clone, Copy)]
pub(crate) enum Key {
    FailedTitle,
    AlreadyRunning,
    DataDir,
    Port,
    Token,
    RuntimeMissing,
    Spawn,
    NotListening,
    Window,
    ServerGaveUp,
    ExitNotice,
    LogAt,
    BenchmarkInfo,
    Build,
}

/// Native dialog text. `{}` marks the one value a caller substitutes.
pub(crate) fn text(lang: Lang, key: Key) -> &'static str {
    match (lang, key) {
        (Lang::En, Key::FailedTitle) => "FlowMap failed to start",
        (Lang::Tr, Key::FailedTitle) => "FlowMap başlatılamadı",
        (Lang::En, Key::AlreadyRunning) => {
            "FlowMap is already running.\n\nClose the other FlowMap window first. If none is visible, a stuck FlowMap process may still be running. Quit it from Task Manager (Windows) or Activity Monitor (macOS)."
        }
        (Lang::Tr, Key::AlreadyRunning) => {
            "FlowMap zaten çalışıyor.\n\nÖnce diğer FlowMap penceresini kapatın. Hiçbiri görünmüyorsa, takılı kalmış bir FlowMap işlemi hâlâ çalışıyor olabilir. Görev Yöneticisi'nden (Windows) veya Etkinlik İzleyici'den (macOS) sonlandırın."
        }
        (Lang::En, Key::DataDir) => "could not resolve the app data directory: {}",
        (Lang::Tr, Key::DataDir) => "uygulama veri klasörü belirlenemedi: {}",
        (Lang::En, Key::Port) => "could not find a free loopback port: {}",
        (Lang::Tr, Key::Port) => "boş bir yerel bağlantı noktası bulunamadı: {}",
        (Lang::En, Key::Token) => "could not create the session token: {}",
        (Lang::Tr, Key::Token) => "oturum anahtarı oluşturulamadı: {}",
        (Lang::En, Key::RuntimeMissing) => "the bundled Python runtime was not found (expected at {})",
        (Lang::Tr, Key::RuntimeMissing) => "paketli Python çalışma zamanı bulunamadı (beklenen konum: {})",
        (Lang::En, Key::Spawn) => "could not launch the bundled FlowMap server: {}",
        (Lang::Tr, Key::Spawn) => "paketli FlowMap sunucusu başlatılamadı: {}",
        (Lang::En, Key::NotListening) => {
            "The bundled FlowMap server did not take its port, so the app cannot connect safely ({})."
        }
        (Lang::Tr, Key::NotListening) => {
            "Paketli FlowMap sunucusu kendi bağlantı noktasını alamadı; uygulama güvenli biçimde bağlanamaz ({})."
        }
        (Lang::En, Key::Window) => "could not create the main window: {}",
        (Lang::Tr, Key::Window) => "ana pencere oluşturulamadı: {}",
        (Lang::En, Key::ServerGaveUp) => {
            "The FlowMap server stopped and could not be restarted. Use Retry in the app, or see the log at: {}"
        }
        (Lang::Tr, Key::ServerGaveUp) => {
            "FlowMap sunucusu durdu ve yeniden başlatılamadı. Uygulamadaki Yeniden dene düğmesini kullanın veya şu günlüğe bakın: {}"
        }
        (Lang::En, Key::ExitNotice) => "FlowMap will now exit.",
        (Lang::Tr, Key::ExitNotice) => "FlowMap şimdi kapanacak.",
        (Lang::En, Key::LogAt) => "Server log: {}",
        (Lang::Tr, Key::LogAt) => "Sunucu günlüğü: {}",
        (Lang::En, Key::BenchmarkInfo) => "could not write the benchmark profile record: {}",
        (Lang::Tr, Key::BenchmarkInfo) => "kıyaslama profil kaydı yazılamadı: {}",
        (Lang::En, Key::Build) => "FlowMap could not set up its window and runtime: {}",
        (Lang::Tr, Key::Build) => "FlowMap pencere ve çalışma ortamını hazırlayamadı: {}",
    }
}

#[cfg(windows)]
pub(crate) fn detect_lang() -> Lang {
    let mut buf = [0u16; 85];
    let len = unsafe { GetUserDefaultLocaleName(&mut buf) };
    if len > 1 && String::from_utf16_lossy(&buf[..len as usize - 1]).starts_with("tr") {
        Lang::Tr
    } else {
        Lang::En
    }
}

/// The first entry of macOS's language list, from `defaults read -g AppleLanguages`
/// (`(`, then one quoted language per line, most preferred first).
#[cfg(any(target_os = "macos", test))]
pub(crate) fn lang_from_apple_languages(output: &str) -> Option<Lang> {
    let first = output.split('"').nth(1)?;
    Some(if first.starts_with("tr") {
        Lang::Tr
    } else {
        Lang::En
    })
}

#[cfg(target_os = "macos")]
pub(crate) fn detect_lang() -> Lang {
    // A Finder-launched app has no LANG, so the user's language list is the source.
    Command::new("defaults")
        .args(["read", "-g", "AppleLanguages"])
        .output()
        .ok()
        .and_then(|out| lang_from_apple_languages(&String::from_utf8_lossy(&out.stdout)))
        .unwrap_or_else(lang_from_env)
}

#[cfg(all(unix, not(target_os = "macos")))]
pub(crate) fn detect_lang() -> Lang {
    lang_from_env()
}

#[cfg(not(windows))]
pub(crate) fn lang_from_env() -> Lang {
    ["LC_ALL", "LC_MESSAGES", "LANG"]
        .iter()
        .filter_map(|key| std::env::var(key).ok())
        .find(|value| !value.is_empty())
        .map(|value| {
            if value.starts_with("tr") {
                Lang::Tr
            } else {
                Lang::En
            }
        })
        .unwrap_or(Lang::En)
}

#[cfg(test)]
mod tests {
    use super::*;

    const ALL_KEYS: [Key; 14] = [
        Key::FailedTitle,
        Key::AlreadyRunning,
        Key::DataDir,
        Key::Port,
        Key::Token,
        Key::RuntimeMissing,
        Key::Spawn,
        Key::NotListening,
        Key::Window,
        Key::ServerGaveUp,
        Key::ExitNotice,
        Key::LogAt,
        Key::BenchmarkInfo,
        Key::Build,
    ];

    #[test]
    fn every_message_has_text_and_the_same_placeholders_in_both_languages() {
        for key in ALL_KEYS {
            let en = text(Lang::En, key);
            let tr = text(Lang::Tr, key);
            assert!(
                !en.is_empty() && !tr.is_empty(),
                "{key:?} has an empty message"
            );
            assert_eq!(
                en.matches("{}").count(),
                tr.matches("{}").count(),
                "{key:?}: the English and Turkish texts substitute different values"
            );
        }
    }

    #[test]
    fn the_first_apple_language_picks_the_dialog_language() {
        assert_eq!(
            lang_from_apple_languages("(\n    \"tr-TR\",\n    \"en-US\"\n)\n"),
            Some(Lang::Tr)
        );
        assert_eq!(
            lang_from_apple_languages("(\n    \"en-US\",\n    \"tr-TR\"\n)\n"),
            Some(Lang::En)
        );
        assert_eq!(
            lang_from_apple_languages("(\n    en\n)\n"),
            None,
            "unquoted output is not trusted"
        );
    }
}
