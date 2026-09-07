//! `SSH_ASKPASS` helper for Remote SFTP Explorer.
//!
//! OpenSSH runs this program when it needs a password, passphrase, verification code, or a
//! host-key confirmation, passing the prompt as arguments and reading the answer from stdout.
//! We relay the prompt to the extension over authenticated loopback HTTP so the answer can be
//! collected with a native VS Code input box.
//!
//! Design notes:
//!   * The prompt is forwarded verbatim; the extension decides what kind of answer is wanted
//!     (ADR-0003). Prompt wording changes between OpenSSH versions, and that logic belongs
//!     where it can be unit-tested rather than cross-compiled.
//!   * Only the answer is ever written to stdout. Every failure path exits non-zero and
//!     prints nothing there.
//!   * No logs, no files. Diagnostics go to stderr and never contain a secret.

// Without this the process is a console application, and Windows flashes a console window on
// every prompt. Our own `windowsHide` does not propagate to ssh.exe's children.
#![cfg_attr(windows, windows_subsystem = "windows")]

use serde::{Deserialize, Serialize};
use std::env;
use std::io::{Read, Write};
use std::net::{Ipv4Addr, SocketAddrV4, TcpStream};
use std::process::ExitCode;
use std::time::Duration;
use zeroize::Zeroize;

const MAX_REQUEST_BYTES: usize = 8 * 1024;
const MAX_RESPONSE_BYTES: u64 = 16 * 1024;
const IO_TIMEOUT: Duration = Duration::from_secs(120);

#[derive(Serialize)]
struct PromptRequest<'a> {
    prompt: &'a str,
    /// Raw argv, so the extension can see exactly what OpenSSH passed.
    argv: &'a [String],
    /// `SSH_ASKPASS_PROMPT` if OpenSSH set it. Advisory only.
    #[serde(rename = "envHint", skip_serializing_if = "Option::is_none")]
    env_hint: Option<&'a str>,
}

#[derive(Deserialize)]
struct PromptResponse {
    answer: Option<String>,
    #[serde(default)]
    cancelled: bool,
}

struct LoopbackUrl {
    port: u16,
    path: String,
}

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(message) => {
            // Only our own constructed messages reach here; none interpolate a secret.
            eprintln!("remote-sftp-askpass: {message}");
            ExitCode::FAILURE
        }
    }
}

fn run() -> Result<(), String> {
    // `SSH_ASKPASS_REQUIRE=never` means the user has asked OpenSSH not to use an askpass
    // helper at all. Honour it rather than prompting anyway.
    if let Ok(require) = env::var("SSH_ASKPASS_REQUIRE") {
        if require.eq_ignore_ascii_case("never") {
            return Err("SSH_ASKPASS_REQUIRE=never; refusing to prompt".to_owned());
        }
    }

    let argv: Vec<String> = env::args().skip(1).collect();
    let prompt = argv.join(" ");

    let url = env::var("REMOTE_SFTP_ASKPASS_URL")
        .map_err(|_| "REMOTE_SFTP_ASKPASS_URL is missing".to_owned())?;
    let mut token = env::var("REMOTE_SFTP_ASKPASS_TOKEN")
        .map_err(|_| "REMOTE_SFTP_ASKPASS_TOKEN is missing".to_owned())?;
    if token.len() < 32 || token.bytes().any(|byte| byte <= 0x20 || byte >= 0x7f) {
        token.zeroize();
        return Err("askpass token is invalid".to_owned());
    }

    let env_hint = env::var("SSH_ASKPASS_PROMPT").ok();

    let result = send_prompt(&url, &token, &prompt, &argv, env_hint.as_deref());
    token.zeroize();

    let mut response = result?;
    if response.cancelled {
        if let Some(answer) = response.answer.as_mut() {
            answer.zeroize();
        }
        return Err("prompt was cancelled".to_owned());
    }

    let mut answer = response
        .answer
        .ok_or_else(|| "prompt response did not contain an answer".to_owned())?;
    let write_result = {
        let mut stdout = std::io::stdout().lock();
        // OpenSSH reads a single line and strips the newline.
        stdout
            .write_all(answer.as_bytes())
            .and_then(|()| stdout.write_all(b"\n"))
            .and_then(|()| stdout.flush())
    };
    answer.zeroize();
    write_result.map_err(|error| format!("failed to write answer: {error}"))?;
    Ok(())
}

fn send_prompt(
    raw_url: &str,
    token: &str,
    prompt: &str,
    argv: &[String],
    env_hint: Option<&str>,
) -> Result<PromptResponse, String> {
    let url = parse_loopback_url(raw_url)?;
    let mut body = serde_json::to_vec(&PromptRequest {
        prompt,
        argv,
        env_hint,
    })
    .map_err(|error| format!("failed to encode prompt: {error}"))?;

    if body.len() > MAX_REQUEST_BYTES {
        body.zeroize();
        return Err("prompt request exceeds 8 KiB".to_owned());
    }

    let address = SocketAddrV4::new(Ipv4Addr::LOCALHOST, url.port);
    let mut stream = TcpStream::connect_timeout(&address.into(), IO_TIMEOUT)
        .map_err(|error| format!("failed to connect to extension: {error}"))?;
    stream
        .set_read_timeout(Some(IO_TIMEOUT))
        .map_err(|error| format!("failed to set read timeout: {error}"))?;
    stream
        .set_write_timeout(Some(IO_TIMEOUT))
        .map_err(|error| format!("failed to set write timeout: {error}"))?;

    let send = write!(
        stream,
        "POST {} HTTP/1.1\r\n\
         Host: 127.0.0.1:{}\r\n\
         Authorization: Bearer {}\r\n\
         Content-Type: application/json\r\n\
         Content-Length: {}\r\n\
         Connection: close\r\n\r\n",
        url.path,
        url.port,
        token,
        body.len()
    )
    .and_then(|()| stream.write_all(&body))
    .and_then(|()| stream.flush());
    body.zeroize();
    send.map_err(|error| format!("failed to send prompt: {error}"))?;

    let mut response = Vec::new();
    let read = stream
        .take(MAX_RESPONSE_BYTES + 1)
        .read_to_end(&mut response);

    let parsed = match read {
        Err(error) => Err(format!("failed to read extension response: {error}")),
        Ok(_) if response.len() as u64 > MAX_RESPONSE_BYTES => {
            Err("extension response exceeds 16 KiB".to_owned())
        }
        Ok(_) => parse_http_response(&response),
    };

    // The raw HTTP buffer holds the answer in plaintext. Scrub it: the previous version left
    // this copy in freed heap memory, where it could linger or reach swap.
    response.zeroize();
    parsed
}

fn parse_loopback_url(raw: &str) -> Result<LoopbackUrl, String> {
    // Explicit IPv4 loopback only. `localhost` can resolve elsewhere, and https is not us.
    let remainder = raw
        .strip_prefix("http://127.0.0.1:")
        .ok_or_else(|| "askpass URL must use http://127.0.0.1".to_owned())?;
    let (port, path) = remainder
        .split_once('/')
        .ok_or_else(|| "askpass URL must include a path".to_owned())?;
    let port = port
        .parse::<u16>()
        .map_err(|_| "askpass URL port is invalid".to_owned())?;
    if port == 0
        || path.is_empty()
        || path
            .chars()
            .any(|character| matches!(character, '?' | '#' | '\r' | '\n' | ' '))
    {
        return Err("askpass URL is invalid".to_owned());
    }
    Ok(LoopbackUrl {
        port,
        path: format!("/{path}"),
    })
}

fn parse_http_response(bytes: &[u8]) -> Result<PromptResponse, String> {
    let separator = bytes
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .ok_or_else(|| "extension response is not HTTP".to_owned())?;
    let headers = std::str::from_utf8(&bytes[..separator])
        .map_err(|_| "extension response headers are not UTF-8".to_owned())?;
    let status = headers.lines().next().unwrap_or_default();
    if status != "HTTP/1.1 200 OK" && status != "HTTP/1.0 200 OK" {
        return Err("extension rejected the prompt".to_owned());
    }
    serde_json::from_slice(&bytes[separator + 4..])
        .map_err(|error| format!("extension response JSON is invalid: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::BufRead;
    use std::net::TcpListener;
    use std::thread;

    #[test]
    fn accepts_only_explicit_ipv4_loopback_urls() {
        let parsed = parse_loopback_url("http://127.0.0.1:49152/v1/prompt").unwrap();
        assert_eq!(parsed.port, 49152);
        assert_eq!(parsed.path, "/v1/prompt");

        assert!(parse_loopback_url("http://localhost:49152/v1/prompt").is_err());
        assert!(parse_loopback_url("https://127.0.0.1:49152/v1/prompt").is_err());
        assert!(parse_loopback_url("http://127.0.0.1:0/v1/prompt").is_err());
        assert!(parse_loopback_url("http://127.0.0.1:1/pa th").is_err());
        assert!(parse_loopback_url("http://10.0.0.1:49152/v1/prompt").is_err());
    }

    #[test]
    fn parses_answer_and_cancel_responses() {
        let answer = parse_http_response(
            b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n{\"answer\":\"value\"}",
        )
        .unwrap();
        assert_eq!(answer.answer.as_deref(), Some("value"));
        assert!(!answer.cancelled);

        let cancelled = parse_http_response(b"HTTP/1.1 200 OK\r\n\r\n{\"cancelled\":true}").unwrap();
        assert!(cancelled.cancelled);
    }

    #[test]
    fn rejects_non_success_and_invalid_json() {
        assert!(parse_http_response(b"HTTP/1.1 401 Unauthorized\r\n\r\n{}").is_err());
        assert!(parse_http_response(b"HTTP/1.1 200 OK\r\n\r\nnot-json").is_err());
        assert!(parse_http_response(b"no header separator").is_err());
    }

    /// Spawn a one-shot HTTP server and hand back its port plus the captured request.
    fn serve_once(response: &'static str) -> (u16, thread::JoinHandle<String>) {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let handle = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut reader = std::io::BufReader::new(stream.try_clone().unwrap());
            let mut request = String::new();
            let mut content_length = 0usize;
            loop {
                let mut line = String::new();
                reader.read_line(&mut line).unwrap();
                if let Some(value) = line.strip_prefix("Content-Length: ") {
                    content_length = value.trim().parse().unwrap();
                }
                let done = line == "\r\n" || line.is_empty();
                request.push_str(&line);
                if done {
                    break;
                }
            }
            let mut body = vec![0u8; content_length];
            reader.read_exact(&mut body).unwrap();
            request.push_str(std::str::from_utf8(&body).unwrap());
            stream.write_all(response.as_bytes()).unwrap();
            stream.flush().unwrap();
            request
        });
        (port, handle)
    }

    #[test]
    fn sends_a_bearer_token_and_the_prompt_verbatim() {
        let (port, handle) = serve_once("HTTP/1.1 200 OK\r\n\r\n{\"answer\":\"sesame\"}");
        let url = format!("http://127.0.0.1:{port}/v1/prompt");
        let argv = vec!["Enter".to_owned(), "passphrase:".to_owned()];

        let response = send_prompt(&url, "a".repeat(43).as_str(), "Enter passphrase:", &argv, None)
            .unwrap();
        assert_eq!(response.answer.as_deref(), Some("sesame"));

        let request = handle.join().unwrap();
        assert!(request.starts_with("POST /v1/prompt HTTP/1.1\r\n"));
        assert!(request.contains(&format!("Authorization: Bearer {}", "a".repeat(43))));
        assert!(request.contains("\"prompt\":\"Enter passphrase:\""));
        assert!(request.contains("\"argv\":[\"Enter\",\"passphrase:\"]"));
    }

    #[test]
    fn forwards_the_environment_hint_when_present() {
        let (port, handle) = serve_once("HTTP/1.1 200 OK\r\n\r\n{\"answer\":\"y\"}");
        let url = format!("http://127.0.0.1:{port}/v1/prompt");

        send_prompt(&url, "b".repeat(43).as_str(), "continue?", &[], Some("confirm")).unwrap();

        let request = handle.join().unwrap();
        assert!(request.contains("\"envHint\":\"confirm\""));
    }

    #[test]
    fn a_rejected_request_is_an_error() {
        let (port, handle) = serve_once("HTTP/1.1 401 Unauthorized\r\n\r\n{}");
        let url = format!("http://127.0.0.1:{port}/v1/prompt");

        let result = send_prompt(&url, "c".repeat(43).as_str(), "password:", &[], None);
        assert!(result.is_err());
        handle.join().unwrap();
    }

    #[test]
    fn an_oversized_prompt_is_refused_before_connecting() {
        // No listener exists on this port; refusing before connecting is what makes that safe.
        let url = "http://127.0.0.1:1/v1/prompt";
        let huge = "x".repeat(MAX_REQUEST_BYTES + 1);
        // Matched rather than unwrapped: PromptResponse deliberately does not derive Debug,
        // so a struct holding a plaintext credential can never be formatted into output.
        match send_prompt(url, "d".repeat(43).as_str(), &huge, &[], None) {
            Err(message) => assert_eq!(message, "prompt request exceeds 8 KiB"),
            Ok(_) => panic!("an oversized prompt must be refused"),
        }
    }
}
