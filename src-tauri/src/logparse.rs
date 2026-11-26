//! Reads Roblox's player log for the moments Luna cares about: joining a game server and
//! leaving it. The line formats are reverse engineered (Roblox documents none of this) and
//! can change; the patterns below are the ones Bloxstrap-style launchers rely on too. If the
//! game popup stops appearing, open the newest file in `%LocalAppData%\Roblox\logs` while in a
//! game and compare its "Joining game", "UDMUX Address" and "serverId:" lines with these.

use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

use regex::Regex;
use serde::Serialize;

/// What the log has said about the game the player is in.
#[derive(Clone, Default, Serialize, Debug, PartialEq)]
pub struct GameSession {
    pub place_id: Option<u64>,
    pub job_id: Option<String>,
    /// The game server's address (the RCC address when the log gives one).
    pub ip: Option<String>,
    /// Every address the log named for this server, best first: the one to look up first
    /// comes first, the others are for when that lookup fails.
    pub candidates: Vec<String>,
}

#[derive(Debug, PartialEq)]
pub enum LogEvent {
    /// The client has connected to the server described by the session.
    Joined(GameSession),
    /// The client left the server (a rejoin or a teleport joins again afterwards).
    Left,
}

pub struct LogParser {
    joining: Regex,
    udmux: Regex,
    joined: Regex,
    place_id: Option<u64>,
    job_id: Option<String>,
    join_ip: Option<String>,
    rcc_ip: Option<String>,
    server_id_ip: Option<String>,
}

impl LogParser {
    pub fn new() -> Self {
        LogParser {
            // [FLog::Output] ! Joining game '<job id>' place <place id> at <ip>
            joining: Regex::new(r"! Joining game '([0-9a-fA-F-]{36})' place (\d+) at ([0-9.]+)").unwrap(),
            // [FLog::Network] UDMUX Address = <relay>, Port = N | RCC Server Address = <server>, Port = N
            udmux: Regex::new(r"UDMUX Address = ([0-9.]+), Port = \d+ \| RCC Server Address = ([0-9.]+), Port = \d+").unwrap(),
            // [FLog::Network] serverId: <ip>|<port>
            joined: Regex::new(r"\[FLog::Network\] serverId: ([0-9.]+)\|\d+").unwrap(),
            place_id: None,
            job_id: None,
            join_ip: None,
            rcc_ip: None,
            server_id_ip: None,
        }
    }

    /// What is known about the current game right now (lines about it may still arrive).
    pub fn session(&self) -> GameSession {
        let mut candidates: Vec<String> = Vec::new();
        for ip in [&self.rcc_ip, &self.server_id_ip, &self.join_ip].into_iter().flatten() {
            if !candidates.contains(ip) {
                candidates.push(ip.clone());
            }
        }
        GameSession {
            place_id: self.place_id,
            job_id: self.job_id.clone(),
            ip: candidates.first().cloned(),
            candidates,
        }
    }

    pub fn feed(&mut self, line: &str) -> Option<LogEvent> {
        if let Some(c) = self.joining.captures(line) {
            self.job_id = Some(c[1].to_string());
            self.place_id = c[2].parse().ok();
            self.join_ip = Some(c[3].to_string());
            self.rcc_ip = None;
            self.server_id_ip = None;
            return None;
        }
        if let Some(c) = self.udmux.captures(line) {
            self.rcc_ip = Some(c[2].to_string());
            return None;
        }
        if let Some(c) = self.joined.captures(line) {
            self.server_id_ip = Some(c[1].to_string());
            return Some(LogEvent::Joined(self.session()));
        }
        if line.contains("[FLog::Network] Time to disconnect replication data:") {
            self.place_id = None;
            self.job_id = None;
            self.join_ip = None;
            self.rcc_ip = None;
            self.server_id_ip = None;
            return Some(LogEvent::Left);
        }
        None
    }
}

/// Reads what was appended to a file since `offset` and moves `offset` past it. A file that
/// got shorter was replaced, so it is read from the start.
pub fn read_new(path: &Path, offset: &mut u64) -> std::io::Result<Vec<u8>> {
    let mut file = File::open(path)?;
    let len = file.metadata()?.len();
    if len < *offset {
        *offset = 0;
    }
    file.seek(SeekFrom::Start(*offset))?;
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)?;
    *offset += bytes.len() as u64;
    Ok(bytes)
}

/// Splits `buffer` into complete lines (without the newline), leaving an unfinished last line
/// in the buffer for the next read.
pub fn take_lines(buffer: &mut Vec<u8>) -> Vec<String> {
    let mut lines = Vec::new();
    while let Some(pos) = buffer.iter().position(|b| *b == b'\n') {
        let line: Vec<u8> = buffer.drain(..=pos).collect();
        lines.push(String::from_utf8_lossy(&line).trim_end().to_string());
    }
    lines
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_join_is_reported_with_the_rcc_address() {
        let mut p = LogParser::new();
        let job = "2f9b1c7e-0a1b-4c3d-8e9f-112233445566";
        assert_eq!(p.feed(&format!("2024-01-01T00:00:01.100Z,1.1,abc,6 [FLog::Output] ! Joining game '{job}' place 920587237 at 128.116.1.2")), None);
        assert_eq!(p.feed("2024-01-01T00:00:02.100Z,1.2,abc,6 [FLog::Network] UDMUX Address = 10.0.0.9, Port = 3478 | RCC Server Address = 128.116.44.5, Port = 53640"), None);
        let ev = p.feed("2024-01-01T00:00:03.100Z,1.3,abc,6 [FLog::Network] serverId: 128.116.44.5|53640");
        assert_eq!(
            ev,
            Some(LogEvent::Joined(GameSession {
                place_id: Some(920587237),
                job_id: Some(job.to_string()),
                ip: Some("128.116.44.5".to_string()),
                candidates: vec!["128.116.44.5".to_string(), "128.116.1.2".to_string()],
            }))
        );
        // a UDMUX line that comes after the join is still picked up by the later snapshot
        assert_eq!(p.session().ip.as_deref(), Some("128.116.44.5"));
        assert_eq!(p.feed("x [FLog::Network] Time to disconnect replication data: 0.05"), Some(LogEvent::Left));
        // after leaving, nothing is remembered
        match p.feed("x [FLog::Network] serverId: 1.2.3.4|1") {
            Some(LogEvent::Joined(s)) => assert_eq!((s.place_id, s.ip.as_deref()), (None, Some("1.2.3.4"))),
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn lines_are_cut_at_newlines() {
        let mut buf = b"one\r\ntwo\nthr".to_vec();
        assert_eq!(take_lines(&mut buf), vec!["one", "two"]);
        buf.extend_from_slice(b"ee\n");
        assert_eq!(take_lines(&mut buf), vec!["three"]);
    }

    #[test]
    fn new_bytes_are_read_once() {
        let dir = std::env::temp_dir().join("luna-logparse-test");
        let _ = std::fs::create_dir_all(&dir);
        let f = dir.join("a.log");
        std::fs::write(&f, b"abc\n").unwrap();
        let mut off = 0;
        assert_eq!(read_new(&f, &mut off).unwrap(), b"abc\n");
        assert!(read_new(&f, &mut off).unwrap().is_empty());
        std::fs::write(&f, b"x\n").unwrap(); // shorter: replaced
        assert_eq!(read_new(&f, &mut off).unwrap(), b"x\n");
    }
}
