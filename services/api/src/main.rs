use actix_multipart::Multipart;
use actix_web::{web, App, HttpServer, HttpRequest, HttpResponse};
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use chrono::Utc;
use futures::StreamExt;
use jsonwebtoken::{encode, decode, Header, Validation, EncodingKey, DecodingKey};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Sha256, Digest};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};
use sysinfo::System;
use tokio::io::AsyncWriteExt;
use uuid::Uuid;

// ---------------------------------------------------------------------------
// Shared application state
// ---------------------------------------------------------------------------
struct AppState {
    jwt_secret: String,
    files_root: String,
    google_client_id: String,
    google_client_secret: String,
    turnstile_sitekey: String,
    turnstile_secret: String,
    oauth_store: Mutex<serde_json::Map<String, Value>>,
}

// ---------------------------------------------------------------------------
// JWT helpers
// ---------------------------------------------------------------------------
#[derive(Debug, Serialize, Deserialize)]
struct Claims {
    user: String,
    #[serde(default)]
    name: String,
    #[serde(default)]
    given_name: String,
    exp: usize,
}

fn create_jwt(secret: &str, user: &str, name: &str, given_name: &str, hours: i64) -> Result<String, jsonwebtoken::errors::Error> {
    let exp = (Utc::now() + chrono::Duration::hours(hours)).timestamp() as usize;
    let claims = Claims { user: user.to_string(), name: name.to_string(), given_name: given_name.to_string(), exp };
    encode(&Header::default(), &claims, &EncodingKey::from_secret(secret.as_bytes()))
}

fn verify_jwt(secret: &str, token: &str) -> Result<Claims, jsonwebtoken::errors::Error> {
    let data = decode::<Claims>(token, &DecodingKey::from_secret(secret.as_bytes()), &Validation::default())?;
    Ok(data.claims)
}

fn extract_token(req: &HttpRequest) -> Option<String> {
    req.headers().get("Authorization")
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string())
        .or_else(|| {
            let q = web::Query::<std::collections::HashMap<String, String>>::from_query(req.query_string()).ok()?;
            q.get("token").cloned()
        })
}

fn require_auth(req: &HttpRequest, state: &AppState) -> Result<Claims, HttpResponse> {
    let token = extract_token(req).ok_or_else(|| HttpResponse::Unauthorized().json(json!({"error": "Missing token"})))?;
    verify_jwt(&state.jwt_secret, &token).map_err(|_| HttpResponse::Unauthorized().json(json!({"error": "Invalid token"})))
}

// ---------------------------------------------------------------------------
// Path safety
// ---------------------------------------------------------------------------
fn safe_path(files_root: &str, path: &str) -> Option<PathBuf> {
    let base = Path::new(files_root);
    let joined = base.join(path.trim_start_matches('/'));
    let canonical_base = std::fs::canonicalize(base).ok()?;
    // Try canonicalize; if it fails the path doesn't exist yet — check parent
    if let Ok(canon) = std::fs::canonicalize(&joined) {
        if canon.starts_with(&canonical_base) { return Some(canon); }
    } else if let Some(parent) = joined.parent() {
        if let Ok(canon_parent) = std::fs::canonicalize(parent) {
            if canon_parent.starts_with(&canonical_base) {
                return Some(joined);
            }
        }
    }
    None
}

fn format_size(size: u64) -> String {
    if size > 1_073_741_824 { format!("{:.1} GB", size as f64 / 1_073_741_824.0) }
    else if size > 1_048_576 { format!("{:.1} MB", size as f64 / 1_048_576.0) }
    else if size > 1024 { format!("{:.1} KB", size as f64 / 1024.0) }
    else { format!("{} B", size) }
}

// ---------------------------------------------------------------------------
// Allowed users
// ---------------------------------------------------------------------------
fn load_allowed_users() -> Vec<String> {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("allowed_users.json");
    if let Ok(data) = std::fs::read_to_string(&path) {
        if let Ok(users) = serde_json::from_str::<Vec<String>>(&data) {
            return users;
        }
    }
    vec!["emilvinod@gmail.com".to_string()]
}

fn is_user_allowed(email: &str) -> bool {
    let allowed = load_allowed_users();
    allowed.iter().any(|e| e.eq_ignore_ascii_case(email))
}

// ---------------------------------------------------------------------------
// Access denied HTML
// ---------------------------------------------------------------------------
fn access_denied_page(message: &str) -> HttpResponse {
    let html = format!(r#"<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Access Denied</title>
<style>*{{margin:0;padding:0;box-sizing:border-box}}html,body{{height:100%;font-family:Inter,system-ui,sans-serif}}
body{{display:flex;align-items:center;justify-content:center;background:#000;color:#fff}}
.message{{text-align:center;padding:40px}}h1{{font-size:1.5rem;font-weight:500}}</style></head>
<body><div class="message"><h1>{}</h1></div></body></html>"#, message);
    HttpResponse::Ok().content_type("text/html; charset=utf-8").body(html)
}

// ---------------------------------------------------------------------------
// OAuth helpers
// ---------------------------------------------------------------------------
fn make_redirect_uri(req: &HttpRequest) -> String {
    let proto = req.headers().get("X-Forwarded-Proto")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("https");
    let host = req.headers().get("X-Forwarded-Host")
        .or_else(|| req.headers().get("Host"))
        .and_then(|v| v.to_str().ok())
        .unwrap_or("localhost");
    format!("{}://{}/cloud/api/oauth/callback", proto, host.trim_end_matches('/'))
}

fn save_oauth_store(store: &serde_json::Map<String, Value>) {
    let _ = std::fs::write("/tmp/pincerna_oauth_state.json", serde_json::to_string(store).unwrap_or_default());
}

fn load_oauth_store() -> serde_json::Map<String, Value> {
    std::fs::read_to_string("/tmp/pincerna_oauth_state.json")
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

async fn health() -> HttpResponse {
    HttpResponse::Ok().json(json!({"status": "ok"}))
}

async fn config_handler(state: web::Data<Arc<AppState>>) -> HttpResponse {
    HttpResponse::Ok().json(json!({"turnstile_sitekey": state.turnstile_sitekey}))
}

async fn login(state: web::Data<Arc<AppState>>) -> HttpResponse {
    match create_jwt(&state.jwt_secret, "admin", "", "", 1) {
        Ok(token) => HttpResponse::Ok().json(json!({"token": token})),
        Err(e) => HttpResponse::InternalServerError().json(json!({"error": e.to_string()})),
    }
}

async fn verify_turnstile(state: web::Data<Arc<AppState>>, body: web::Json<Value>) -> HttpResponse {
    let token = body.get("token").or(body.get("cf_turnstile_response"))
        .and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
    if token.is_empty() {
        return HttpResponse::BadRequest().json(json!({"error": "missing_token"}));
    }
    if state.turnstile_secret.is_empty() {
        return HttpResponse::InternalServerError().json(json!({"error": "turnstile_not_configured"}));
    }
    let client = reqwest::Client::new();
    let params = [("secret", state.turnstile_secret.as_str()), ("response", &token)];
    match client.post("https://challenges.cloudflare.com/turnstile/v0/siteverify")
        .form(&params).send().await
    {
        Ok(resp) => match resp.json::<Value>().await {
            Ok(j) => {
                if j.get("success").and_then(|v| v.as_bool()).unwrap_or(false) {
                    HttpResponse::Ok().json(json!({"success": true, "detail": j}))
                } else {
                    HttpResponse::BadRequest().json(json!({"error": "not_human", "detail": j}))
                }
            }
            Err(e) => HttpResponse::InternalServerError().json(json!({"error": "verify_failed", "detail": e.to_string()})),
        },
        Err(e) => HttpResponse::InternalServerError().json(json!({"error": "verify_failed", "detail": e.to_string()})),
    }
}

async fn verify_google(state: web::Data<Arc<AppState>>, body: web::Json<Value>) -> HttpResponse {
    let id_token = body.get("id_token").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
    if id_token.is_empty() {
        return HttpResponse::BadRequest().json(json!({"error": "missing_token"}));
    }
    let url = format!("https://oauth2.googleapis.com/tokeninfo?id_token={}", urlencoding::encode(&id_token));
    let client = reqwest::Client::new();
    let payload: Value = match client.get(&url).send().await.and_then(|r| Ok(r)).ok() {
        Some(resp) => match resp.json().await {
            Ok(j) => j,
            Err(e) => return HttpResponse::BadRequest().json(json!({"error": "token_verification_failed", "detail": e.to_string()})),
        },
        None => return HttpResponse::BadRequest().json(json!({"error": "token_verification_failed"})),
    };
    let email = payload.get("email").and_then(|v| v.as_str()).unwrap_or("");
    let verified = matches!(payload.get("email_verified").and_then(|v| v.as_str()), Some("true"));
    if email.is_empty() || !verified {
        return HttpResponse::BadRequest().json(json!({"error": "email_not_verified"}));
    }
    if !is_user_allowed(email) {
        return HttpResponse::Forbidden().json(json!({"error": "not_allowed"}));
    }
    match create_jwt(&state.jwt_secret, email, "", "", 12) {
        Ok(token) => HttpResponse::Ok().json(json!({"token": token})),
        Err(e) => HttpResponse::InternalServerError().json(json!({"error": e.to_string()})),
    }
}

async fn oauth_start(req: HttpRequest, state: web::Data<Arc<AppState>>) -> HttpResponse {
    if state.google_client_id.is_empty() {
        return access_denied_page("OAuth is not configured on this server. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET.");
    }
    let state_token = Uuid::new_v4().to_string();
    let code_verifier = URL_SAFE_NO_PAD.encode(rand::random::<[u8; 48]>());

    let hash = Sha256::digest(code_verifier.as_bytes());
    let code_challenge = URL_SAFE_NO_PAD.encode(hash);

    {
        let mut store = state.oauth_store.lock().unwrap();
        let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs() as i64;
        store.insert(state_token.clone(), json!({"code_verifier": code_verifier, "expires": now + 600}));
        save_oauth_store(&store);
    }

    let redirect_uri = make_redirect_uri(&req);
    let params = format!(
        "client_id={}&response_type=code&scope=openid+email+profile&redirect_uri={}&state={}&code_challenge={}&code_challenge_method=S256",
        urlencoding::encode(&state.google_client_id),
        urlencoding::encode(&redirect_uri),
        urlencoding::encode(&state_token),
        urlencoding::encode(&code_challenge),
    );
    let auth_url = format!("https://accounts.google.com/o/oauth2/v2/auth?{}", params);
    HttpResponse::Found().insert_header(("Location", auth_url)).finish()
}

async fn oauth_callback(req: HttpRequest, state: web::Data<Arc<AppState>>, query: web::Query<std::collections::HashMap<String, String>>) -> HttpResponse {
    if let Some(error) = query.get("error") {
        return if error == "access_denied" {
            access_denied_page("Sign in was cancelled")
        } else {
            access_denied_page("Authentication failed")
        };
    }

    let code = match query.get("code") { Some(c) => c.clone(), None => return access_denied_page("Missing authentication data") };
    let state_param = match query.get("state") { Some(s) => s.clone(), None => return access_denied_page("Missing authentication data") };

    let code_verifier;
    {
        let mut store = state.oauth_store.lock().unwrap();
        let stored = match store.get(&state_param) {
            Some(v) => v.clone(),
            None => return access_denied_page("Session expired. Please try signing in again."),
        };
        let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs() as i64;
        if stored.get("expires").and_then(|v| v.as_i64()).unwrap_or(0) < now {
            return access_denied_page("Session expired. Please try signing in again.");
        }
        code_verifier = stored.get("code_verifier").and_then(|v| v.as_str()).unwrap_or("").to_string();
        store.remove(&state_param);
        save_oauth_store(&store);
    }

    let redirect_uri = make_redirect_uri(&req);
    let client = reqwest::Client::new();
    let token_resp = client.post("https://oauth2.googleapis.com/token")
        .form(&[
            ("code", code.as_str()),
            ("client_id", state.google_client_id.as_str()),
            ("client_secret", state.google_client_secret.as_str()),
            ("redirect_uri", redirect_uri.as_str()),
            ("grant_type", "authorization_code"),
            ("code_verifier", code_verifier.as_str()),
        ])
        .send().await;
    let resp_j: Value = match token_resp {
        Ok(r) => match r.json().await { Ok(j) => j, Err(_) => return access_denied_page("Authentication failed") },
        Err(_) => return access_denied_page("Authentication failed"),
    };
    let id_token = match resp_j.get("id_token").and_then(|v| v.as_str()) {
        Some(t) => t.to_string(),
        None => return access_denied_page("Authentication failed"),
    };

    let info_url = format!("https://oauth2.googleapis.com/tokeninfo?id_token={}", urlencoding::encode(&id_token));
    let payload: Value = match client.get(&info_url).send().await {
        Ok(r) => match r.json().await { Ok(j) => j, Err(_) => return access_denied_page("Authentication failed") },
        Err(_) => return access_denied_page("Authentication failed"),
    };

    if payload.get("aud").and_then(|v| v.as_str()) != Some(&state.google_client_id) {
        return access_denied_page("Invalid token audience");
    }
    let email = payload.get("email").and_then(|v| v.as_str()).unwrap_or("");
    let verified = match payload.get("email_verified") {
        Some(Value::Bool(true)) => true,
        Some(Value::String(s)) if s == "true" => true,
        _ => false,
    };
    if email.is_empty() || !verified {
        return access_denied_page("Email not verified");
    }
    if !is_user_allowed(email) {
        return HttpResponse::Forbidden().body(access_denied_page("Sorry, you don't have access").into_body());
    }

    let user_name = payload.get("name").and_then(|v| v.as_str()).unwrap_or("");
    let user_given = payload.get("given_name").and_then(|v| v.as_str()).unwrap_or("");
    let user_picture = payload.get("picture").and_then(|v| v.as_str()).unwrap_or("");

    let token = match create_jwt(&state.jwt_secret, email, user_name, user_given, 12) {
        Ok(t) => t,
        Err(_) => return access_denied_page("Internal error during OAuth callback"),
    };

    let user_info = json!({"email": email, "name": user_name, "given_name": user_given, "picture": user_picture});
    let frag_token = urlencoding::encode(&token);
    let frag_user = urlencoding::encode(&user_info.to_string());
    let redirect_url = format!("/cloud/#token={}&user={}", frag_token, frag_user);
    HttpResponse::Found().insert_header(("Location", redirect_url)).finish()
}

async fn auth_logout() -> HttpResponse {
    HttpResponse::Ok().json(json!({"success": true}))
}

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------
async fn metrics_handler() -> HttpResponse {
    let mut sys = System::new_all();
    sys.refresh_all();
    std::thread::sleep(std::time::Duration::from_millis(100));
    sys.refresh_cpu_usage();

    let cpu_percent: f32 = sys.cpus().iter().map(|c| c.cpu_usage()).sum::<f32>() / sys.cpus().len().max(1) as f32;
    let total_mem = sys.total_memory();
    let used_mem = sys.used_memory();
    let available_mem = sys.available_memory();

    let disk = sysinfo::Disks::new_with_refreshed_list();
    let root_disk = disk.list().iter().find(|d| d.mount_point() == Path::new("/"));
    let (disk_total, disk_used, disk_free, disk_percent) = match root_disk {
        Some(d) => {
            let total = d.total_space();
            let avail = d.available_space();
            let used = total.saturating_sub(avail);
            let pct = if total > 0 { (used as f64 / total as f64) * 100.0 } else { 0.0 };
            (total, used, avail, pct)
        }
        None => (0, 0, 0, 0.0),
    };

    let networks = sysinfo::Networks::new_with_refreshed_list();
    let (net_sent, net_recv): (u64, u64) = networks.list().values()
        .fold((0, 0), |(s, r), n| (s + n.total_transmitted(), r + n.total_received()));

    let uptime = System::uptime();

    let load_avg = System::load_average();

    // CPU temp
    let components = sysinfo::Components::new_with_refreshed_list();
    let cpu_temp: Option<f32> = components.list().iter()
        .find(|c| {
            let label = c.label().to_lowercase();
            label.contains("cpu") || label.contains("core")
        })
        .map(|c| c.temperature());

    let process_count = sys.processes().len();

    HttpResponse::Ok().json(json!({
        "cpu": (cpu_percent * 10.0).round() / 10.0,
        "cpu_count": sys.cpus().len(),
        "cpu_temp": cpu_temp.map(|t| (t * 10.0).round() / 10.0),
        "memory": ((used_mem as f64 / total_mem.max(1) as f64) * 1000.0).round() / 10.0,
        "memory_used": used_mem,
        "memory_total": total_mem,
        "memory_available": available_mem,
        "disk": (disk_percent * 10.0).round() / 10.0,
        "disk_used": disk_used,
        "disk_total": disk_total,
        "disk_free": disk_free,
        "net_sent": net_sent,
        "net_recv": net_recv,
        "uptime": uptime,
        "load_avg": [load_avg.one, load_avg.five, load_avg.fifteen],
        "process_count": process_count,
    }))
}

async fn restart_service(req: HttpRequest, state: web::Data<Arc<AppState>>) -> HttpResponse {
    if require_auth(&req, &state).is_err() {
        return HttpResponse::Unauthorized().json(json!({"error": "Missing token"}));
    }
    HttpResponse::Ok().json(json!({"message": "Restart command received", "status": "ok"}))
}

// ---------------------------------------------------------------------------
// File operations
// ---------------------------------------------------------------------------
async fn list_files(req: HttpRequest, state: web::Data<Arc<AppState>>, query: web::Query<std::collections::HashMap<String, String>>) -> HttpResponse {
    let path = query.get("path").map(|s| s.as_str()).unwrap_or("/");
    let full_path = match safe_path(&state.files_root, path) {
        Some(p) => p,
        None => return HttpResponse::BadRequest().json(json!({"error": "Invalid path"})),
    };
    if !full_path.is_dir() {
        return HttpResponse::Ok().json(json!({"files": [], "path": path}));
    }
    let mut items: Vec<Value> = Vec::new();
    if let Ok(mut entries) = tokio::fs::read_dir(&full_path).await {
        while let Ok(Some(entry)) = entries.next_entry().await {
            let name = entry.file_name().to_string_lossy().to_string();
            let meta = match entry.metadata().await { Ok(m) => m, Err(_) => continue };
            let is_dir = meta.is_dir();
            let size = if is_dir { None } else { Some(meta.len()) };
            let size_str = size.map(|s| format_size(s)).unwrap_or_default();
            let mtime = meta.modified().ok()
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| chrono::DateTime::from_timestamp(d.as_secs() as i64, 0).map(|dt| dt.format("%Y-%m-%d %H:%M").to_string()).unwrap_or_default())
                .unwrap_or_default();
            let rel_path = format!("{}{}{}", path.trim_end_matches('/'), "/", &name);
            items.push(json!({
                "name": name,
                "path": rel_path,
                "is_dir": is_dir,
                "size": size_str,
                "mtime": mtime,
            }));
        }
    }
    items.sort_by(|a, b| {
        let a_dir = a.get("is_dir").and_then(|v| v.as_bool()).unwrap_or(false);
        let b_dir = b.get("is_dir").and_then(|v| v.as_bool()).unwrap_or(false);
        b_dir.cmp(&a_dir).then_with(|| {
            let an = a.get("name").and_then(|v| v.as_str()).unwrap_or("").to_lowercase();
            let bn = b.get("name").and_then(|v| v.as_str()).unwrap_or("").to_lowercase();
            an.cmp(&bn)
        })
    });
    HttpResponse::Ok().json(json!({"files": items, "path": path}))
}

async fn download_file(req: HttpRequest, state: web::Data<Arc<AppState>>, query: web::Query<std::collections::HashMap<String, String>>) -> HttpResponse {
    if require_auth(&req, &state).is_err() {
        return HttpResponse::Unauthorized().json(json!({"error": "Missing token"}));
    }
    let path = query.get("path").map(|s| s.as_str()).unwrap_or("");
    let full_path = match safe_path(&state.files_root, path) {
        Some(p) if p.is_file() => p,
        _ => return HttpResponse::NotFound().json(json!({"error": "File not found"})),
    };
    let filename = full_path.file_name().unwrap_or_default().to_string_lossy().to_string();
    match tokio::fs::read(&full_path).await {
        Ok(data) => {
            let mime = mime_guess::from_path(&full_path).first_or_octet_stream();
            HttpResponse::Ok()
                .insert_header(("Content-Disposition", format!("attachment; filename=\"{}\"", filename)))
                .content_type(mime.to_string())
                .body(data)
        }
        Err(e) => HttpResponse::InternalServerError().json(json!({"error": e.to_string()})),
    }
}

async fn preview_file(req: HttpRequest, state: web::Data<Arc<AppState>>, query: web::Query<std::collections::HashMap<String, String>>) -> HttpResponse {
    if require_auth(&req, &state).is_err() {
        return HttpResponse::Unauthorized().json(json!({"error": "Missing token"}));
    }
    let path = query.get("path").map(|s| s.as_str()).unwrap_or("");
    let full_path = match safe_path(&state.files_root, path) {
        Some(p) if p.is_file() => p,
        _ => return HttpResponse::NotFound().json(json!({"error": "File not found"})),
    };
    let mime = mime_guess::from_path(&full_path).first_or_octet_stream();
    let is_raw = query.get("raw").map(|s| s == "1").unwrap_or(false);

    // Video preview HTML
    if mime.type_() == mime_guess::mime::VIDEO && !is_raw {
        let token = extract_token(&req).unwrap_or_default();
        let html = format!(r#"<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Video Preview</title><style>*{{margin:0;padding:0}}body{{background:#000;overflow:hidden}}
video{{width:100vw;height:100vh;object-fit:contain}}</style></head><body>
<video controls autoplay><source src="/cloud/api/files/preview?path={}&token={}&raw=1" type="{}"></video></body></html>"#,
            urlencoding::encode(path), urlencoding::encode(&token), mime);
        return HttpResponse::Ok().content_type("text/html").body(html);
    }

    // Serve file with range support for videos
    if mime.type_() == mime_guess::mime::VIDEO && is_raw {
        let meta = match tokio::fs::metadata(&full_path).await {
            Ok(m) => m,
            Err(e) => return HttpResponse::InternalServerError().json(json!({"error": e.to_string()})),
        };
        let file_size = meta.len();
        let range_header = req.headers().get("Range").and_then(|v| v.to_str().ok()).map(|s| s.to_string());

        if let Some(range_str) = range_header {
            if let Some(caps) = range_str.strip_prefix("bytes=") {
                let parts: Vec<&str> = caps.splitn(2, '-').collect();
                let start: u64 = parts[0].parse().unwrap_or(0);
                let end: u64 = if parts.len() > 1 && !parts[1].is_empty() { parts[1].parse().unwrap_or(file_size - 1) } else { file_size - 1 };
                let end = end.min(file_size - 1);
                let length = end - start + 1;

                match tokio::fs::read(&full_path).await {
                    Ok(data) => {
                        let slice = &data[start as usize..=(end as usize).min(data.len() - 1)];
                        return HttpResponse::PartialContent()
                            .insert_header(("Content-Range", format!("bytes {}-{}/{}", start, end, file_size)))
                            .insert_header(("Accept-Ranges", "bytes"))
                            .insert_header(("Content-Length", length.to_string()))
                            .insert_header(("Cache-Control", "public, max-age=7200"))
                            .content_type(mime.to_string())
                            .body(slice.to_vec());
                    }
                    Err(e) => return HttpResponse::InternalServerError().json(json!({"error": e.to_string()})),
                }
            }
        }
        // No range: full file
        match tokio::fs::read(&full_path).await {
            Ok(data) => {
                return HttpResponse::Ok()
                    .insert_header(("Accept-Ranges", "bytes"))
                    .insert_header(("Content-Length", file_size.to_string()))
                    .insert_header(("Cache-Control", "public, max-age=7200"))
                    .content_type(mime.to_string())
                    .body(data);
            }
            Err(e) => return HttpResponse::InternalServerError().json(json!({"error": e.to_string()})),
        }
    }

    // Non-video: serve inline
    match tokio::fs::read(&full_path).await {
        Ok(data) => HttpResponse::Ok()
            .insert_header(("Content-Disposition", "inline"))
            .content_type(mime.to_string())
            .body(data),
        Err(e) => HttpResponse::InternalServerError().json(json!({"error": e.to_string()})),
    }
}

async fn upload_file(req: HttpRequest, state: web::Data<Arc<AppState>>, mut payload: Multipart) -> HttpResponse {
    if require_auth(&req, &state).is_err() {
        return HttpResponse::Unauthorized().json(json!({"error": "Missing token"}));
    }
    let mut path = "/".to_string();
    let mut saved_filename = String::new();

    while let Some(Ok(mut field)) = payload.next().await {
        let disposition = field.content_disposition().clone();
        let field_name = disposition.get_name().unwrap_or("");

        if field_name == "path" {
            let mut bytes = Vec::new();
            while let Some(Ok(chunk)) = field.next().await { bytes.extend_from_slice(&chunk); }
            path = String::from_utf8_lossy(&bytes).to_string();
        } else if field_name == "file" {
            let filename = disposition.get_filename().unwrap_or("upload").to_string();
            let safe_name = sanitize_filename::sanitize(&filename);
            if safe_name.is_empty() {
                return HttpResponse::BadRequest().json(json!({"error": "Invalid filename"}));
            }
            let full_path = match safe_path(&state.files_root, &path) {
                Some(p) => p,
                None => return HttpResponse::BadRequest().json(json!({"error": "Invalid path"})),
            };
            let _ = tokio::fs::create_dir_all(&full_path).await;
            let dest = full_path.join(&safe_name);
            let mut file = match tokio::fs::File::create(&dest).await {
                Ok(f) => f,
                Err(e) => return HttpResponse::InternalServerError().json(json!({"error": e.to_string()})),
            };
            while let Some(Ok(chunk)) = field.next().await {
                if file.write_all(&chunk).await.is_err() {
                    return HttpResponse::InternalServerError().json(json!({"error": "Write failed"}));
                }
            }
            saved_filename = safe_name;
        }
    }
    if saved_filename.is_empty() {
        return HttpResponse::BadRequest().json(json!({"error": "No file provided"}));
    }
    HttpResponse::Ok().json(json!({"success": true, "filename": saved_filename}))
}

async fn delete_file_handler(req: HttpRequest, state: web::Data<Arc<AppState>>, query: web::Query<std::collections::HashMap<String, String>>) -> HttpResponse {
    if require_auth(&req, &state).is_err() {
        return HttpResponse::Unauthorized().json(json!({"error": "Missing token"}));
    }
    let path = query.get("path").map(|s| s.as_str()).unwrap_or("");
    let full_path = match safe_path(&state.files_root, path) {
        Some(p) => p,
        None => return HttpResponse::BadRequest().json(json!({"error": "Invalid path"})),
    };
    if !full_path.exists() {
        return HttpResponse::NotFound().json(json!({"error": "File not found"}));
    }
    let result = if full_path.is_dir() {
        tokio::fs::remove_dir_all(&full_path).await
    } else {
        tokio::fs::remove_file(&full_path).await
    };
    match result {
        Ok(_) => HttpResponse::Ok().json(json!({"success": true})),
        Err(e) => HttpResponse::InternalServerError().json(json!({"error": e.to_string()})),
    }
}

#[derive(Deserialize)]
struct RenameBody { path: String, new_name: String }

async fn rename_file_handler(req: HttpRequest, state: web::Data<Arc<AppState>>, body: web::Json<RenameBody>) -> HttpResponse {
    if require_auth(&req, &state).is_err() {
        return HttpResponse::Unauthorized().json(json!({"error": "Missing token"}));
    }
    let full_path = match safe_path(&state.files_root, &body.path) {
        Some(p) if p.exists() => p,
        _ => return HttpResponse::NotFound().json(json!({"error": "File not found"})),
    };
    let safe_name = sanitize_filename::sanitize(&body.new_name);
    if safe_name.is_empty() {
        return HttpResponse::BadRequest().json(json!({"error": "Invalid filename"}));
    }
    let new_full = full_path.parent().unwrap().join(&safe_name);
    if new_full.exists() {
        return HttpResponse::BadRequest().json(json!({"error": "A file with that name already exists"}));
    }
    match tokio::fs::rename(&full_path, &new_full).await {
        Ok(_) => HttpResponse::Ok().json(json!({"success": true, "new_path": new_full.to_string_lossy()})),
        Err(e) => HttpResponse::InternalServerError().json(json!({"error": e.to_string()})),
    }
}

#[derive(Deserialize)]
struct MkdirBody { path: String, name: String }

async fn mkdir_handler(req: HttpRequest, state: web::Data<Arc<AppState>>, body: web::Json<MkdirBody>) -> HttpResponse {
    if require_auth(&req, &state).is_err() {
        return HttpResponse::Unauthorized().json(json!({"error": "Missing token"}));
    }
    let safe_name = sanitize_filename::sanitize(&body.name);
    if safe_name.is_empty() {
        return HttpResponse::BadRequest().json(json!({"error": "Invalid folder name"}));
    }
    let full_path = match safe_path(&state.files_root, &body.path) {
        Some(p) => p,
        None => return HttpResponse::BadRequest().json(json!({"error": "Invalid path"})),
    };
    let new_folder = full_path.join(&safe_name);
    if new_folder.exists() {
        return HttpResponse::BadRequest().json(json!({"error": "Folder already exists"}));
    }
    match tokio::fs::create_dir_all(&new_folder).await {
        Ok(_) => HttpResponse::Ok().json(json!({"success": true, "path": new_folder.to_string_lossy()})),
        Err(e) => HttpResponse::InternalServerError().json(json!({"error": e.to_string()})),
    }
}

#[derive(Deserialize)]
struct MoveBody { path: String, destination: String }

async fn move_file_handler(req: HttpRequest, state: web::Data<Arc<AppState>>, body: web::Json<MoveBody>) -> HttpResponse {
    if require_auth(&req, &state).is_err() {
        return HttpResponse::Unauthorized().json(json!({"error": "Missing token"}));
    }
    let full_src = match safe_path(&state.files_root, &body.path) {
        Some(p) if p.exists() => p,
        _ => return HttpResponse::NotFound().json(json!({"error": "Source not found"})),
    };
    let mut full_dest = match safe_path(&state.files_root, &body.destination) {
        Some(p) => p,
        None => return HttpResponse::BadRequest().json(json!({"error": "Invalid destination"})),
    };
    if full_dest.is_dir() {
        if let Some(fname) = full_src.file_name() {
            full_dest = full_dest.join(fname);
        }
    }
    if full_dest.exists() {
        return HttpResponse::BadRequest().json(json!({"error": "Destination already exists"}));
    }
    match tokio::fs::rename(&full_src, &full_dest).await {
        Ok(_) => HttpResponse::Ok().json(json!({"success": true, "new_path": full_dest.to_string_lossy()})),
        Err(e) => HttpResponse::InternalServerError().json(json!({"error": e.to_string()})),
    }
}

// ---------------------------------------------------------------------------
// Chunked upload
// ---------------------------------------------------------------------------
async fn upload_chunk(req: HttpRequest, state: web::Data<Arc<AppState>>, mut payload: Multipart) -> HttpResponse {
    if require_auth(&req, &state).is_err() {
        return HttpResponse::Unauthorized().json(json!({"error": "Missing token"}));
    }
    let mut upload_id = String::new();
    let mut index: Option<u64> = None;

    while let Some(Ok(mut field)) = payload.next().await {
        let name = field.content_disposition().get_name().unwrap_or("").to_string();
        match name.as_str() {
            "upload_id" => {
                let mut b = Vec::new();
                while let Some(Ok(c)) = field.next().await { b.extend_from_slice(&c); }
                upload_id = String::from_utf8_lossy(&b).to_string();
            }
            "index" => {
                let mut b = Vec::new();
                while let Some(Ok(c)) = field.next().await { b.extend_from_slice(&c); }
                index = String::from_utf8_lossy(&b).trim().parse().ok();
            }
            "chunk" => {
                if upload_id.is_empty() || index.is_none() {
                    return HttpResponse::BadRequest().json(json!({"error": "missing_parameters"}));
                }
                let safe_id = sanitize_filename::sanitize(&upload_id);
                let tmp_dir = PathBuf::from("/tmp/pincerna_uploads").join(&safe_id);
                let _ = tokio::fs::create_dir_all(&tmp_dir).await;
                let chunk_path = tmp_dir.join(format!("chunk_{}", index.unwrap()));
                let mut file = match tokio::fs::File::create(&chunk_path).await {
                    Ok(f) => f, Err(e) => return HttpResponse::InternalServerError().json(json!({"error": e.to_string()})),
                };
                while let Some(Ok(c)) = field.next().await {
                    let _ = file.write_all(&c).await;
                }
            }
            _ => {
                // skip other fields
                while let Some(Ok(_)) = field.next().await {}
            }
        }
    }
    HttpResponse::Ok().json(json!({"success": true}))
}

#[derive(Deserialize)]
struct UploadCompleteBody { upload_id: String, filename: String, path: Option<String> }

async fn upload_complete(req: HttpRequest, state: web::Data<Arc<AppState>>, body: web::Json<UploadCompleteBody>) -> HttpResponse {
    if require_auth(&req, &state).is_err() {
        return HttpResponse::Unauthorized().json(json!({"error": "Missing token"}));
    }
    let safe_id = sanitize_filename::sanitize(&body.upload_id);
    let path = body.path.as_deref().unwrap_or("/");
    let full_path = match safe_path(&state.files_root, path) {
        Some(p) => p,
        None => return HttpResponse::BadRequest().json(json!({"error": "invalid_path"})),
    };
    let tmp_dir = PathBuf::from("/tmp/pincerna_uploads").join(&safe_id);
    let mut parts: Vec<String> = Vec::new();
    if let Ok(mut entries) = tokio::fs::read_dir(&tmp_dir).await {
        while let Ok(Some(entry)) = entries.next_entry().await {
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with("chunk_") { parts.push(name); }
        }
    }
    parts.sort_by_key(|p| p.strip_prefix("chunk_").and_then(|s| s.parse::<u64>().ok()).unwrap_or(0));

    let safe_filename = sanitize_filename::sanitize(&body.filename);
    let dest = full_path.join(&safe_filename);
    let mut out = match tokio::fs::File::create(&dest).await {
        Ok(f) => f, Err(e) => return HttpResponse::InternalServerError().json(json!({"error": e.to_string()})),
    };
    for p in &parts {
        match tokio::fs::read(tmp_dir.join(p)).await {
            Ok(data) => { let _ = out.write_all(&data).await; }
            Err(e) => return HttpResponse::InternalServerError().json(json!({"error": e.to_string()})),
        }
    }
    let _ = tokio::fs::remove_dir_all(&tmp_dir).await;
    HttpResponse::Ok().json(json!({"success": true, "path": dest.to_string_lossy()}))
}



// ---------------------------------------------------------------------------
// Network
// ---------------------------------------------------------------------------
async fn network_scan(req: HttpRequest, state: web::Data<Arc<AppState>>) -> HttpResponse {
    if require_auth(&req, &state).is_err() {
        return HttpResponse::Unauthorized().json(json!({"error": "Missing token"}));
    }
    let output = tokio::process::Command::new("sh")
        .args(["-c", "ip route get 1.1.1.1 2>/dev/null | awk '/src/{for(i=1;i<=NF;i++) if($i==\"src\") print $(i+1)}'"])
        .output().await;
    let server_ip = output.as_ref().ok().map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string()).unwrap_or("192.168.1.1".into());
    let prefix = server_ip.rsplitn(2, '.').last().unwrap_or("192.168.1");
    let network_range = format!("{}.0/24", prefix);

    let mut devices: Vec<Value> = Vec::new();
    let nmap = tokio::process::Command::new("nmap")
        .args(["-sn", "-oG", "-", &network_range])
        .output().await;
    if let Ok(out) = nmap {
        let stdout = String::from_utf8_lossy(&out.stdout);
        for line in stdout.lines() {
            if line.contains("Host:") && line.contains("Status: Up") {
                let parts: Vec<&str> = line.split_whitespace().collect();
                if parts.len() > 1 {
                    let ip = parts[1].to_string();
                    let hostname = line.split('(').nth(1).and_then(|s| s.split(')').next()).unwrap_or("").to_string();
                    devices.push(json!({"ip": ip, "hostname": hostname, "online": true, "is_server": ip == server_ip, "services": []}));
                }
            }
        }
    }

    let gateway = tokio::process::Command::new("sh")
        .args(["-c", "ip route | awk '/^default/{print $3}'"])
        .output().await.ok()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string()).unwrap_or_default();

    HttpResponse::Ok().json(json!({
        "devices": devices, "network": network_range, "server_ip": server_ip,
        "gateway": gateway, "scanned_at": Utc::now().to_rfc3339(),
    }))
}

async fn scan_ports(req: HttpRequest, state: web::Data<Arc<AppState>>, path: web::Path<String>) -> HttpResponse {
    if require_auth(&req, &state).is_err() {
        return HttpResponse::Unauthorized().json(json!({"error": "Missing token"}));
    }
    let ip = path.into_inner();
    let parts: Vec<&str> = ip.split('.').collect();
    if parts.len() != 4 || parts.iter().any(|p| p.parse::<u8>().is_err()) {
        return HttpResponse::BadRequest().json(json!({"error": "Invalid IP address"}));
    }
    let first: u8 = parts[0].parse().unwrap_or(0);
    let second: u8 = parts[1].parse().unwrap_or(0);
    let is_private = first == 10 || (first == 172 && (16..=31).contains(&second)) || (first == 192 && second == 168) || first == 127;
    if !is_private {
        return HttpResponse::BadRequest().json(json!({"error": "Can only scan private network addresses"}));
    }

    let common_ports = vec![
        (22, "SSH"), (80, "HTTP"), (443, "HTTPS"), (445, "SMB"), (548, "AFP"),
        (3389, "RDP"), (5000, "Synology"), (5001, "Synology SSL"), (8080, "HTTP Alt"),
        (8443, "HTTPS Alt"), (9000, "Portainer"), (32400, "Plex"),
    ];
    let mut open_ports: Vec<Value> = Vec::new();
    for (port, name) in common_ports {
        let addr = format!("{}:{}", ip, port);
        if let Ok(Ok(_)) = tokio::time::timeout(std::time::Duration::from_millis(500),
            tokio::net::TcpStream::connect(&addr)).await {
            open_ports.push(json!({"port": port, "name": name}));
        }
    }
    HttpResponse::Ok().json(json!({"ip": ip, "ports": open_ports}))
}

async fn network_info(req: HttpRequest, state: web::Data<Arc<AppState>>) -> HttpResponse {
    if require_auth(&req, &state).is_err() {
        return HttpResponse::Unauthorized().json(json!({"error": "Missing token"}));
    }
    let output = tokio::process::Command::new("sh")
        .args(["-c", "ip route get 1.1.1.1 2>/dev/null | awk '/src/{for(i=1;i<=NF;i++) if($i==\"src\") print $(i+1)}'"])
        .output().await;
    let server_ip = output.as_ref().ok().map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string()).unwrap_or_default();
    let prefix = server_ip.rsplitn(2, '.').last().unwrap_or("192.168.1");
    let gateway = tokio::process::Command::new("sh")
        .args(["-c", "ip route | awk '/^default/{print $3}'"])
        .output().await.ok()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string()).unwrap_or_default();
    let hostname = hostname::get().map(|h| h.to_string_lossy().to_string()).unwrap_or_default();
    HttpResponse::Ok().json(json!({
        "server_ip": server_ip, "gateway": gateway,
        "network": format!("{}.0/24", prefix), "hostname": hostname,
    }))
}



// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
#[actix_web::main]
async fn main() -> std::io::Result<()> {
    env_logger::init();

    let jwt_secret = std::env::var("JWT_SECRET").unwrap_or_else(|_| "bartendershandbook-change-in-production".into());
    let files_root = std::env::var("FILES_ROOT").unwrap_or_else(|_| "/mnt".into());
    let google_client_id = std::env::var("GOOGLE_CLIENT_ID").unwrap_or_default();
    let google_client_secret = std::env::var("GOOGLE_CLIENT_SECRET").unwrap_or_default();
    let turnstile_sitekey = std::env::var("TURNSTILE_SITEKEY").unwrap_or_default();
    let turnstile_secret = std::env::var("TURNSTILE_SECRET").unwrap_or_default();

    let state = Arc::new(AppState {
        jwt_secret,
        files_root,
        google_client_id,
        google_client_secret,
        turnstile_sitekey,
        turnstile_secret,
        oauth_store: Mutex::new(load_oauth_store()),
    });

    println!("Pincerna API starting on 0.0.0.0:5002");

    HttpServer::new(move || {
        let state = state.clone();
        App::new()
            .app_data(web::Data::new(state))
            // Health
            .route("/health", web::get().to(health))
            // Auth
            .route("/login", web::post().to(login))
            .route("/verify_turnstile", web::post().to(verify_turnstile))
            .route("/verify_google", web::post().to(verify_google))
            .route("/config", web::get().to(config_handler))
            .route("/oauth/start", web::get().to(oauth_start))
            .route("/oauth/callback", web::get().to(oauth_callback))
            .route("/auth/logout", web::post().to(auth_logout))
            // Metrics
            .route("/metrics", web::get().to(metrics_handler))
            .route("/restart", web::post().to(restart_service))
            // Files
            .route("/files", web::get().to(list_files))
            .route("/files", web::delete().to(delete_file_handler))
            .route("/files/download", web::get().to(download_file))
            .route("/files/preview", web::get().to(preview_file))
            .route("/files/upload", web::post().to(upload_file))
            .route("/files/rename", web::post().to(rename_file_handler))
            .route("/files/mkdir", web::post().to(mkdir_handler))
            .route("/files/move", web::post().to(move_file_handler))
            .route("/files/upload_chunk", web::post().to(upload_chunk))
            .route("/files/upload_complete", web::post().to(upload_complete))

            // Network
            .route("/network/scan", web::get().to(network_scan))
            .route("/network/device/{ip}/ports", web::get().to(scan_ports))
            .route("/network/info", web::get().to(network_info))

    })
    .bind("0.0.0.0:5002")?
    .run()
    .await
}
