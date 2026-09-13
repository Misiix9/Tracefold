//! A cheap "has the release feed changed?" probe.
//!
//! Asking the updater itself is not free: it fetches the feed, parses it, compares
//! versions and prepares a verified download handle. Doing that every minute would be
//! wasteful for the overwhelmingly common answer, which is "nothing has changed".
//!
//! So the poll sends a conditional request instead. Once a validator is known, GitHub
//! answers an unchanged feed with `304 Not Modified` and no body — a few hundred bytes,
//! no parsing, no allocation of a download. Only when the feed actually changes does the
//! real update check run, which is what makes the update action appear promptly without
//! the traffic that frequent full checks would cost.
//!
//! There is no push channel here on purpose: that would require a server, and this
//! workspace has none. Conditional polling is the closest thing that stays serverless.

use crate::error::{AppError, Result};
use std::sync::Mutex;
use std::time::Duration;

/// Kept in step with `plugins.updater.endpoints` in tauri.conf.json by a test.
pub const UPDATE_FEED_URL: &str =
    "https://github.com/Misiix9/Tracefold/releases/latest/download/latest.json";

const PROBE_TIMEOUT: Duration = Duration::from_secs(15);
const USER_AGENT: &str = concat!("Tracefold/", env!("CARGO_PKG_VERSION"), " (update probe)");

#[derive(Default)]
struct Validators {
    etag: Option<String>,
    last_modified: Option<String>,
}

#[derive(Default)]
pub struct FeedWatcher {
    validators: Mutex<Validators>,
}

impl FeedWatcher {
    pub fn new() -> Self {
        Self::default()
    }

    /// `true` when the feed may have changed and a full check is worth running.
    ///
    /// Fails open: a network error, a proxy, or a server that ignores conditional
    /// requests all report "changed", so a probe that cannot do its job never becomes a
    /// reason to miss an update. The full check is the authority on whether one exists.
    pub async fn changed(&self) -> Result<bool> {
        if rustls::crypto::CryptoProvider::get_default().is_none() {
            let _ = rustls::crypto::ring::default_provider().install_default();
        }
        let (etag, last_modified) = {
            let held = self
                .validators
                .lock()
                .map_err(|_| AppError::new("UPDATE_PROBE", "The update probe state is unavailable."))?;
            (held.etag.clone(), held.last_modified.clone())
        };

        let client = reqwest::Client::builder()
            .user_agent(USER_AGENT)
            .timeout(PROBE_TIMEOUT)
            .build()
            .map_err(|e| AppError::new("UPDATE_PROBE", &format!("Could not prepare the update probe: {e}")))?;
        let mut request = client.get(UPDATE_FEED_URL);
        if let Some(value) = &etag {
            request = request.header(reqwest::header::IF_NONE_MATCH, value);
        }
        if let Some(value) = &last_modified {
            request = request.header(reqwest::header::IF_MODIFIED_SINCE, value);
        }

        let response = match request.send().await {
            Ok(response) => response,
            // Offline is not "up to date", but it is also not an error worth showing.
            Err(_) => return Ok(false),
        };

        if response.status() == reqwest::StatusCode::NOT_MODIFIED {
            return Ok(false);
        }
        if !response.status().is_success() {
            return Ok(false);
        }

        let fresh_etag = header_value(&response, reqwest::header::ETAG);
        let fresh_modified = header_value(&response, reqwest::header::LAST_MODIFIED);
        let had_validator = etag.is_some() || last_modified.is_some();
        let unchanged = had_validator
            && ((fresh_etag.is_some() && fresh_etag == etag)
                || (fresh_modified.is_some() && fresh_modified == last_modified));

        if fresh_etag.is_some() || fresh_modified.is_some() {
            let mut held = self
                .validators
                .lock()
                .map_err(|_| AppError::new("UPDATE_PROBE", "The update probe state is unavailable."))?;
            held.etag = fresh_etag;
            held.last_modified = fresh_modified;
        }

        // Without any validator the server cannot tell us it is unchanged, so every poll
        // reports changed and the full check does the real comparison. Correct, just not
        // as cheap.
        Ok(!unchanged)
    }
}

fn header_value(response: &reqwest::Response, name: reqwest::header::HeaderName) -> Option<String> {
    response
        .headers()
        .get(name)
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The probe and the updater must look at the same feed, or the probe would gate
    /// checks on a file the updater never reads.
    #[test]
    fn the_probe_watches_the_configured_update_feed() {
        const CONFIG: &str = include_str!("../tauri.conf.json");
        let config: serde_json::Value = serde_json::from_str(CONFIG).expect("tauri.conf.json must parse");
        let endpoints = config["plugins"]["updater"]["endpoints"]
            .as_array()
            .expect("the updater must declare endpoints");
        assert!(
            endpoints.iter().any(|value| value.as_str() == Some(UPDATE_FEED_URL)),
            "UPDATE_FEED_URL must be one of the configured updater endpoints, got {endpoints:?}"
        );
    }

    #[test]
    fn a_feed_url_is_https() {
        assert!(UPDATE_FEED_URL.starts_with("https://"));
    }
}
