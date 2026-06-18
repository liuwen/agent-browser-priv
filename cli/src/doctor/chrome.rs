//! Check the selected local browser backend plus optional Chrome installs.

use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;

use super::helpers::which_exists;
use super::{Check, DoctorOptions, Status};
use serde_json::Value;

const PATCHRIGHT_LATEST_URL: &str = "https://registry.npmjs.org/patchright/latest";

pub(super) fn check(checks: &mut Vec<Check>, opts: &DoctorOptions) {
    let engine = opts.engine.as_deref().unwrap_or("chrome");
    let backend = opts.backend.as_deref().unwrap_or(if engine == "chrome" {
        "patchright"
    } else {
        "chrome"
    });

    check_selected_backend(checks, opts, engine, backend);

    let category = "Chrome";

    let chrome = crate::native::cdp::chrome::find_chrome();
    match chrome {
        Some(path) => {
            let label = path.display().to_string();
            match query_chrome_version(&path) {
                Some(version) => checks.push(Check::new(
                    "chrome.installed",
                    category,
                    Status::Pass,
                    format!("{} at {}", version, label),
                )),
                None => checks.push(Check::new(
                    "chrome.installed",
                    category,
                    Status::Pass,
                    format!("Chrome at {} (version unknown)", label),
                )),
            }
        }
        None => {
            let selected = engine == "chrome" && backend == "chrome";
            let check = Check::new(
                "chrome.installed",
                category,
                if selected { Status::Fail } else { Status::Info },
                if selected {
                    "No Chrome binary found for --backend chrome"
                } else {
                    "No Chrome binary found; run `agent-browser install chrome` to use --backend chrome"
                },
            );
            checks.push(if selected {
                check.with_fix("agent-browser install chrome")
            } else {
                check
            });
        }
    }

    let cache_dir = crate::install::get_browsers_dir();
    if cache_dir.exists() {
        checks.push(Check::new(
            "chrome.cache_dir",
            category,
            Status::Info,
            format!("Cache dir {}", cache_dir.display()),
        ));
    }

    if let Some(puppeteer_dir) = puppeteer_cache_dir() {
        if puppeteer_dir.exists() {
            checks.push(Check::new(
                "chrome.puppeteer_cache",
                category,
                Status::Info,
                format!(
                    "Puppeteer cache also present: {} (will be used as a fallback)",
                    puppeteer_dir.display()
                ),
            ));
        }
    }

    if let Some(user_data_dir) = crate::native::cdp::chrome::find_chrome_user_data_dir() {
        let profiles = crate::native::cdp::chrome::list_chrome_profiles(&user_data_dir);
        let count = profiles.len();
        let dir_label = user_data_dir.display().to_string();
        if count == 0 {
            checks.push(Check::new(
                "chrome.user_data_dir",
                category,
                Status::Info,
                format!(
                    "Chrome user data dir found ({}), no profiles parsed",
                    dir_label
                ),
            ));
        } else {
            checks.push(Check::new(
                "chrome.user_data_dir",
                category,
                Status::Info,
                format!("{} Chrome profile(s) at {}", count, dir_label),
            ));
        }
    }

    if engine == "lightpanda" {
        // Best-effort PATH lookup; absence is FAIL only when the user
        // explicitly opted into the lightpanda engine.
        if which_exists("lightpanda") {
            checks.push(Check::new(
                "chrome.engine_lightpanda",
                category,
                Status::Pass,
                "Lightpanda binary on PATH",
            ));
        } else {
            checks.push(
                Check::new(
                    "chrome.engine_lightpanda",
                    category,
                    Status::Fail,
                    "AGENT_BROWSER_ENGINE=lightpanda but no lightpanda binary on PATH",
                )
                .with_fix("install lightpanda or unset AGENT_BROWSER_ENGINE"),
            );
        }
    }
}

fn check_selected_backend(
    checks: &mut Vec<Check>,
    opts: &DoctorOptions,
    engine: &str,
    backend: &str,
) {
    if engine != "chrome" {
        return;
    }

    let category = "Browser backend";
    match backend {
        "patchright" => {
            let root = crate::native::cdp::patchright::patchright_backend_dir();
            let package = root.join("node_modules").join("patchright");
            if package.exists() {
                checks.push(Check::new(
                    "backend.patchright",
                    category,
                    Status::Pass,
                    format!("Patchright backend installed at {}", root.display()),
                ));
                check_patchright_versions(checks, category, &root, opts.offline);
            } else {
                checks.push(
                    Check::new(
                        "backend.patchright",
                        category,
                        Status::Fail,
                        format!("Patchright backend not installed at {}", root.display()),
                    )
                    .with_fix("agent-browser install"),
                );
            }
        }
        "chrome" => checks.push(Check::new(
            "backend.chrome",
            category,
            Status::Info,
            "Using built-in Chrome CDP backend",
        )),
        other => checks.push(Check::new(
            "backend.unknown",
            category,
            Status::Fail,
            format!(
                "Unknown local Chrome backend '{}'; supported backends: patchright, chrome",
                other
            ),
        )),
    }
}

fn check_patchright_versions(
    checks: &mut Vec<Check>,
    category: &'static str,
    backend_root: &Path,
    offline: bool,
) {
    let pinned = crate::install::PATCHRIGHT_VERSION;

    match installed_patchright_version(backend_root) {
        Some(installed) if installed == pinned => {
            checks.push(Check::new(
                "backend.patchright_installed_version",
                category,
                Status::Pass,
                format!(
                    "Patchright backend version {} matches release pin",
                    installed
                ),
            ));
        }
        Some(installed) => {
            checks.push(
                Check::new(
                    "backend.patchright_installed_version",
                    category,
                    Status::Warn,
                    format!(
                        "Patchright backend version {} differs from release pin {}",
                        installed, pinned
                    ),
                )
                .with_fix("agent-browser install"),
            );
        }
        None => {
            checks.push(Check::new(
                "backend.patchright_installed_version",
                category,
                Status::Info,
                "Patchright backend version unknown",
            ));
        }
    }

    if offline {
        checks.push(Check::new(
            "backend.patchright_latest_version",
            category,
            Status::Info,
            "Patchright latest-version check skipped (--offline)",
        ));
        return;
    }

    match fetch_latest_patchright_version() {
        Ok(latest) if latest == pinned => {
            checks.push(Check::new(
                "backend.patchright_latest_version",
                category,
                Status::Pass,
                format!("Patchright release pin {} matches npm latest", pinned),
            ));
        }
        Ok(latest) => {
            checks.push(
                Check::new(
                    "backend.patchright_latest_version",
                    category,
                    Status::Warn,
                    format!(
                        "Patchright npm latest {} is newer than release pin {}",
                        latest, pinned
                    ),
                )
                .with_fix("upgrade agent-browser after a release with the new Patchright pin"),
            );
        }
        Err(e) => {
            checks.push(Check::new(
                "backend.patchright_latest_version",
                category,
                Status::Info,
                format!("Could not check Patchright npm latest: {}", e),
            ));
        }
    }
}

fn installed_patchright_version(backend_root: &Path) -> Option<String> {
    let package_json = backend_root
        .join("node_modules")
        .join("patchright")
        .join("package.json");
    let content = fs::read_to_string(package_json).ok()?;
    let value: Value = serde_json::from_str(&content).ok()?;
    value
        .get("version")
        .and_then(|v| v.as_str())
        .map(str::to_string)
}

fn fetch_latest_patchright_version() -> Result<String, String> {
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|e| format!("runtime init failed: {}", e))?;
    let client = reqwest::Client::builder()
        .user_agent(format!("agent-browser/{}", env!("CARGO_PKG_VERSION")))
        .timeout(Duration::from_secs(3))
        .connect_timeout(Duration::from_secs(3))
        .build()
        .map_err(|e| format!("client init failed: {}", e))?;

    let value: Value = rt
        .block_on(async {
            let response = client
                .get(PATCHRIGHT_LATEST_URL)
                .send()
                .await
                .map_err(|e| e.to_string())?
                .error_for_status()
                .map_err(|e| e.to_string())?;
            response.json().await.map_err(|e| e.to_string())
        })
        .map_err(|e| format!("registry request failed: {}", e))?;

    value
        .get("version")
        .and_then(|v| v.as_str())
        .map(str::to_string)
        .ok_or_else(|| "registry response did not include a version".to_string())
}

fn query_chrome_version(path: &Path) -> Option<String> {
    let output = std::process::Command::new(path)
        .arg("--version")
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let s = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if s.is_empty() {
        None
    } else {
        Some(s)
    }
}

pub(super) fn puppeteer_cache_dir() -> Option<PathBuf> {
    if let Ok(p) = env::var("PUPPETEER_CACHE_DIR") {
        return Some(PathBuf::from(p));
    }
    dirs::home_dir().map(|h| h.join(".cache").join("puppeteer"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn test_puppeteer_cache_dir_returns_sensible_default() {
        // When PUPPETEER_CACHE_DIR is unset, we fall back to
        // ~/.cache/puppeteer. Mutating env vars here would race with other
        // tests, so just verify the fallback path is shaped correctly.
        if env::var("PUPPETEER_CACHE_DIR").is_err() {
            let dir = puppeteer_cache_dir().expect("home dir should resolve in tests");
            let s = dir.to_string_lossy();
            assert!(s.contains(".cache"));
            assert!(s.ends_with("puppeteer"));
        }
    }

    #[test]
    fn test_installed_patchright_version_reads_package_json() {
        let dir = TempDir::new().unwrap();
        let package_dir = dir.path().join("node_modules").join("patchright");
        fs::create_dir_all(&package_dir).unwrap();
        fs::write(package_dir.join("package.json"), r#"{"version":"1.2.3"}"#).unwrap();

        assert_eq!(
            installed_patchright_version(dir.path()).as_deref(),
            Some("1.2.3")
        );
    }

    #[test]
    fn test_installed_patchright_version_missing_or_invalid_is_unknown() {
        let dir = TempDir::new().unwrap();
        assert!(installed_patchright_version(dir.path()).is_none());

        let package_dir = dir.path().join("node_modules").join("patchright");
        fs::create_dir_all(&package_dir).unwrap();
        fs::write(package_dir.join("package.json"), "{not-json}").unwrap();
        assert!(installed_patchright_version(dir.path()).is_none());
    }
}
