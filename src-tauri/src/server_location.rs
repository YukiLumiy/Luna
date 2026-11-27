//! Server location: find the game server IP in Roblox's log and geolocate it.

use std::fs;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::paths::roblox_logs_dir;

// ---------------------------------------------------------------------
// Server location — reads Roblox's own log file to find the IP of the
// game server you're currently connected to, then geolocates it. Unlike
// everything else in this file, the log-parsing regex here is reverse
// engineered from Roblox's log format rather than a documented API, so
// it can break if Roblox changes how it logs connections. If this stops
// finding a match, open the newest file in `%LocalAppData%\Roblox\logs`
// while in a game, search for "UDMUX" or "RCC Server", and update
// SERVER_IP_PATTERN to match the current line format.
// ---------------------------------------------------------------------

#[derive(Serialize)]
pub struct ServerLocation {
    ip: String,
    city: Option<String>,
    region: Option<String>,
    country: Option<String>,
    isp: Option<String>,
}

pub(crate) fn newest_log_file() -> Result<PathBuf, String> {
    let dir = roblox_logs_dir()?;
    fs::read_dir(&dir)
        .map_err(|e| e.to_string())?
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.path())
        .filter(|p| p.extension().and_then(|e| e.to_str()) == Some("log"))
        .filter_map(|p| {
            let modified = p.metadata().ok()?.modified().ok()?;
            Some((p, modified))
        })
        .max_by_key(|(_, modified)| *modified)
        .map(|(p, _)| p)
        .ok_or_else(|| "No Roblox log files found — join a game first".to_string())
}

pub(crate) fn find_server_ip(log_contents: &str) -> Option<String> {
    // Roblox has logged the game server's address under a few different
    // labels over time ("UDMUX Address", "RCC Server Address"); match any
    // of them and take the last occurrence, since a log file can contain
    // more than one join (the most recent game is what we want).
    let pattern = regex::Regex::new(
        r"(?:UDMUX Address|RCC Server Address)\s*=\s*(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})",
    )
    .ok()?;
    pattern
        .captures_iter(log_contents)
        .last()
        .and_then(|caps| caps.get(1))
        .map(|m| m.as_str().to_string())
}

/// Looks up where an IP address is. Roblox's servers sit in address blocks registered to
/// Roblox in the United States, and a lookup that goes by the registration (ip-api.com does)
/// answers "United States" for a server in Tokyo. ipinfo.io places addresses by where they
/// really answer from, so it goes first; ipwho.is and ip-api.com are the fallbacks for when it
/// is unreachable or over its free limit.
pub(crate) async fn geolocate(ip: &str) -> Result<ServerLocation, String> {
    let mut failures: Vec<String> = Vec::new();
    match geolocate_ipinfo(ip).await {
        Ok(found) => return Ok(found),
        Err(e) => failures.push(e),
    }
    match geolocate_ipwho(ip).await {
        Ok(found) => return Ok(found),
        Err(e) => failures.push(e),
    }
    match geolocate_ip_api(ip).await {
        Ok(found) => Ok(found),
        Err(e) => {
            failures.push(e);
            Err(failures.join("; "))
        }
    }
}

async fn geolocate_ipinfo(ip: &str) -> Result<ServerLocation, String> {
    #[derive(Deserialize)]
    struct IpInfo {
        city: Option<String>,
        region: Option<String>,
        country: Option<String>,
        org: Option<String>,
        #[serde(default)]
        bogon: bool,
    }

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(8))
        .build()
        .map_err(|e| e.to_string())?;
    let response: IpInfo = client
        .get(format!("https://ipinfo.io/{ip}/json"))
        .send()
        .await
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?
        .json()
        .await
        .map_err(|e| e.to_string())?;
    if response.bogon || (response.city.is_none() && response.country.is_none()) {
        return Err("ipinfo.io couldn't place that IP".to_string());
    }
    Ok(ServerLocation {
        ip: ip.to_string(),
        city: response.city,
        region: response.region,
        country: response.country.map(|code| country_name(&code)),
        isp: response.org,
    })
}

/// ipinfo.io gives the country as a two-letter code. These are the countries Roblox has
/// servers in (and a few more); anything else keeps its code.
fn country_name(code: &str) -> String {
    let name = match code.to_ascii_uppercase().as_str() {
        "US" => "United States",
        "JP" => "Japan",
        "KR" => "South Korea",
        "SG" => "Singapore",
        "HK" => "Hong Kong",
        "TW" => "Taiwan",
        "IN" => "India",
        "AU" => "Australia",
        "NZ" => "New Zealand",
        "CA" => "Canada",
        "MX" => "Mexico",
        "BR" => "Brazil",
        "AR" => "Argentina",
        "CL" => "Chile",
        "GB" => "United Kingdom",
        "IE" => "Ireland",
        "FR" => "France",
        "DE" => "Germany",
        "NL" => "Netherlands",
        "BE" => "Belgium",
        "ES" => "Spain",
        "PT" => "Portugal",
        "IT" => "Italy",
        "CH" => "Switzerland",
        "AT" => "Austria",
        "PL" => "Poland",
        "CZ" => "Czechia",
        "SE" => "Sweden",
        "NO" => "Norway",
        "FI" => "Finland",
        "DK" => "Denmark",
        "RU" => "Russia",
        "TR" => "Türkiye",
        "AE" => "United Arab Emirates",
        "IL" => "Israel",
        "ZA" => "South Africa",
        "ID" => "Indonesia",
        "TH" => "Thailand",
        "VN" => "Vietnam",
        "PH" => "Philippines",
        "MY" => "Malaysia",
        "CN" => "China",
        _ => return code.to_ascii_uppercase(),
    };
    name.to_string()
}

async fn geolocate_ipwho(ip: &str) -> Result<ServerLocation, String> {
    #[derive(Deserialize)]
    struct Connection {
        isp: Option<String>,
    }
    #[derive(Deserialize)]
    struct IpWho {
        success: bool,
        city: Option<String>,
        region: Option<String>,
        country: Option<String>,
        connection: Option<Connection>,
    }

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(8))
        .build()
        .map_err(|e| e.to_string())?;
    let response: IpWho = client
        .get(format!("https://ipwho.is/{ip}"))
        .send()
        .await
        .map_err(|e| e.to_string())?
        .json()
        .await
        .map_err(|e| e.to_string())?;
    if !response.success {
        return Err("ipwho.is couldn't place that IP".to_string());
    }
    Ok(ServerLocation {
        ip: ip.to_string(),
        city: response.city,
        region: response.region,
        country: response.country,
        isp: response.connection.and_then(|c| c.isp),
    })
}

async fn geolocate_ip_api(ip: &str) -> Result<ServerLocation, String> {
    #[derive(Deserialize)]
    struct IpApiResponse {
        status: String,
        city: Option<String>,
        #[serde(rename = "regionName")]
        region_name: Option<String>,
        country: Option<String>,
        isp: Option<String>,
    }

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(8))
        .build()
        .map_err(|e| e.to_string())?;
    let url = format!("http://ip-api.com/json/{ip}");
    let response: IpApiResponse = client
        .get(&url)
        .send()
        .await
        .map_err(|e| e.to_string())?
        .json()
        .await
        .map_err(|e| e.to_string())?;

    if response.status != "success" {
        return Err("Geolocation lookup failed for that IP".to_string());
    }

    Ok(ServerLocation {
        ip: ip.to_string(),
        city: response.city,
        region: response.region_name,
        country: response.country,
        isp: response.isp,
    })
}

impl ServerLocation {
    /// "Tokyo, Japan" / "Ashburn, Virginia, United States" for the popup.
    pub(crate) fn place(&self) -> Option<String> {
        let mut parts: Vec<&str> = Vec::new();
        for part in [self.city.as_deref(), self.region.as_deref(), self.country.as_deref()].into_iter().flatten() {
            let part = part.trim();
            if !part.is_empty() && !parts.contains(&part) {
                parts.push(part);
            }
        }
        if parts.is_empty() {
            None
        } else {
            Some(parts.join(", "))
        }
    }
}

#[tauri::command]
pub async fn get_server_location() -> Result<ServerLocation, String> {
    let log_path = newest_log_file()?;
    let contents = fs::read_to_string(&log_path).map_err(|e| e.to_string())?;
    let ip = find_server_ip(&contents)
        .ok_or("Couldn't find a server address in the latest Roblox log — are you in a game?")?;
    geolocate(&ip).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn country_codes_become_names() {
        assert_eq!(country_name("jp"), "Japan");
        assert_eq!(country_name("US"), "United States");
        assert_eq!(country_name("ZZ"), "ZZ");
    }

    #[test]
    fn the_place_leaves_out_repeats() {
        let loc = ServerLocation {
            ip: "1.2.3.4".into(),
            city: Some("Tokyo".into()),
            region: Some("Tokyo".into()),
            country: Some("Japan".into()),
            isp: None,
        };
        assert_eq!(loc.place().as_deref(), Some("Tokyo, Japan"));
    }
}
