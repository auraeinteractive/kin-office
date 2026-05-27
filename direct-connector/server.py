#!/usr/bin/env python3
import base64
import json
import os
import re
import ssl
import time
import urllib.error
import urllib.request
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import quote, urlparse, urlunparse


HOST = os.environ.get("DIRECT_CONNECTOR_HOST", "0.0.0.0")
PORT = int(os.environ.get("DIRECT_CONNECTOR_PORT", "8000"))
PUBLIC_BASE_URL = os.environ.get("DIRECT_PUBLIC_BASE_URL", "").rstrip("/")
DOCUMENT_BASE_URL = os.environ.get("DIRECT_DOCUMENT_BASE_URL", "").rstrip("/")
DOCUMENT_SERVER_PUBLIC_URL = os.environ.get("DOCUMENT_SERVER_PUBLIC_URL", "/ds/").rstrip("/") + "/"
DOCUMENT_SERVER_INTERNAL_URL = os.environ.get("DOCUMENT_SERVER_INTERNAL_URL", "http://onlyoffice/").rstrip("/") + "/"
SESSION_TTL_SECONDS = int(os.environ.get("DIRECT_SESSION_TTL_SECONDS", str(8 * 60 * 60)))
MAX_UPLOAD_BYTES = int(os.environ.get("DIRECT_MAX_UPLOAD_BYTES", str(64 * 1024 * 1024)))
EDITOR_HTML = Path(__file__).with_name("editor.html").read_text(encoding="utf-8")
TEMPLATE_DIR = Path(os.environ.get("DIRECT_TEMPLATE_DIR", "/app/templates"))

SESSIONS = {}
_TEMPLATE_CACHE = {}


def now():
    return int(time.time())


def json_bytes(data):
    return json.dumps(data, separators=(",", ":")).encode("utf-8")


def clean_filename(filename, file_type):
    value = str(filename or "").strip().replace("\\", "/").split("/")[-1]
    if not value:
        value = "Document." + file_type
    value = re.sub(r"[^A-Za-z0-9._ -]+", "_", value).strip(" .")
    if "." not in value:
        value += "." + file_type
    return value or ("Document." + file_type)


def file_type_for(filename, requested):
    requested = str(requested or "").lower().strip().lstrip(".")
    if requested in {"docx", "xlsx", "pptx"}:
        return requested
    ext = str(filename or "").rsplit(".", 1)
    if len(ext) == 2 and ext[1].lower() in {"docx", "xlsx", "pptx"}:
        return ext[1].lower()
    return "docx"


def document_type_for(file_type):
    if file_type == "xlsx":
        return "cell"
    if file_type == "pptx":
        return "slide"
    return "word"


def content_type_for(file_type):
    if file_type == "xlsx":
        return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    if file_type == "pptx":
        return "application/vnd.openxmlformats-officedocument.presentationml.presentation"
    return "application/vnd.openxmlformats-officedocument.wordprocessingml.document"


def blank_bytes(file_type):
    """Return OnlyOffice's own default blank template bytes for the requested format.

    Templates are baked into the connector image by the Dockerfile, copied from
    /var/www/onlyoffice/documentserver/document-templates/new/default/ of the
    upstream onlyoffice/documentserver image so that new docs always match what
    stock OnlyOffice itself produces."""
    ft = file_type if file_type in {"docx", "xlsx", "pptx"} else "docx"
    cached = _TEMPLATE_CACHE.get(ft)
    if cached is not None:
        return cached
    data = (TEMPLATE_DIR / f"new.{ft}").read_bytes()
    _TEMPLATE_CACHE[ft] = data
    return data


def public_base(handler):
    if PUBLIC_BASE_URL:
        return PUBLIC_BASE_URL
    proto = handler.headers.get("X-Forwarded-Proto") or "https"
    host = handler.headers.get("X-Forwarded-Host") or handler.headers.get("Host") or "localhost"
    prefix = (handler.headers.get("X-Forwarded-Prefix") or "").strip().rstrip("/")
    if prefix and not prefix.startswith("/"):
        prefix = "/" + prefix
    return f"{proto}://{host}{prefix}/direct"


def session_public_urls(handler, session):
    base = public_base(handler)
    document_base = DOCUMENT_BASE_URL or base
    sid = session["id"]
    filename = quote(session["filename"])
    version = session["version"]
    return {
        "download": f"{document_base}/download/{sid}/{filename}?v={version}",
        "callback": f"{document_base}/callback/{sid}",
        "editor": f"{base}/editor?session={sid}",
    }


def make_config(handler, session):
    urls = session_public_urls(handler, session)
    has_kin_path = bool(str(session.get("file_path") or "").strip())
    return {
        "document": {
            "fileType": session["file_type"],
            "key": session["document_key"],
            "title": session["filename"],
            "url": urls["download"],
            "permissions": {
                "download": True,
                "edit": True,
                "print": True,
                "review": True,
            },
        },
        "documentType": document_type_for(session["file_type"]),
        "editorConfig": {
            "callbackUrl": urls["callback"],
            "lang": "en",
            "mode": "edit",
            "user": {
                "id": session.get("user_id") or "kin-user",
                "name": session.get("user_name") or "Kin User",
            },
            "customization": {
                "autosave": has_kin_path,
                "forcesave": True,
            },
        },
        "type": "desktop",
        "width": "100%",
        "height": "100%",
    }


def cleanup_sessions():
    cutoff = now() - SESSION_TTL_SECONDS
    stale = [sid for sid, data in SESSIONS.items() if data.get("last_seen", 0) < cutoff]
    for sid in stale:
        SESSIONS.pop(sid, None)


def response_for_session(handler, session):
    urls = session_public_urls(handler, session)
    return {
        "response": "success",
        "sessionId": session["id"],
        "documentKey": session["document_key"],
        "fileType": session["file_type"],
        "filename": session["filename"],
        "version": session["version"],
        "editorUrl": urls["editor"],
        "state": session_state(session),
        "info": info_payload(session),
    }


def session_state(session):
    return {
        "sessionId": session["id"],
        "documentKey": session["document_key"],
        "filePath": session.get("file_path") or "",
        "fileType": session["file_type"],
        "filename": session["filename"],
        "version": session["version"],
        "lastSavedAt": session.get("last_saved_at"),
        "lastCallbackStatus": session.get("last_callback_status"),
        "lastCallbackAt": session.get("last_callback_at"),
        "savePending": bool(session.get("save_pending")),
        "users": session.get("users", []),
    }


def info_payload(session):
    return {
        "mode": "direct",
        "sessionId": session["id"],
        "documentKey": session["document_key"],
        "filePath": session.get("file_path") or "",
        "fileType": session["file_type"],
        "updatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "version": session["version"],
    }


def create_session(data):
    filename = data.get("filename") or data.get("name") or ""
    file_type = file_type_for(filename, data.get("file_type") or data.get("fileType"))
    filename = clean_filename(filename, file_type)

    content = None
    encoded = data.get("data_base64") or data.get("dataBase64")
    if encoded:
        content = base64.b64decode(str(encoded), validate=False)
    else:
        content = blank_bytes(file_type)
    if len(content) > MAX_UPLOAD_BYTES:
        raise ValueError("Document is too large for direct editing.")

    session_id = uuid.uuid4().hex
    document_key = "kin-" + uuid.uuid4().hex
    user_id = str(data.get("user_id") or data.get("userId") or "kin-user")
    user_name = str(data.get("user_name") or data.get("userName") or "Kin User")
    session = {
        "id": session_id,
        "document_key": document_key,
        "file_path": str(data.get("path") or data.get("filePath") or ""),
        "file_type": file_type,
        "filename": filename,
        "content": content,
        "version": 1,
        "created_at": now(),
        "last_seen": now(),
        "last_saved_at": None,
        "last_callback_status": None,
        "last_callback_at": None,
        "save_pending": False,
        "user_id": user_id,
        "user_name": user_name,
        "users": [{"id": user_id, "name": user_name}],
    }
    SESSIONS[session_id] = session
    return session


def join_session(data):
    session_id = str(data.get("sessionId") or data.get("session_id") or "").strip()
    if not session_id or session_id not in SESSIONS:
        return None
    session = SESSIONS[session_id]
    expected_path = str(data.get("path") or data.get("filePath") or "")
    if expected_path and session.get("file_path") and expected_path != session.get("file_path"):
        return None
    session["last_seen"] = now()
    user_id = str(data.get("user_id") or data.get("userId") or "kin-user")
    user_name = str(data.get("user_name") or data.get("userName") or "Kin User")
    if not any(user.get("id") == user_id for user in session["users"]):
        session["users"].append({"id": user_id, "name": user_name})
    return session


def resolve_document_fetch_url(url):
    """Rewrite public Document Server URLs to the internal onlyoffice service (Docker)."""
    raw = str(url or "").strip()
    if not raw:
        return raw
    parsed = urlparse(raw)
    if not parsed.scheme:
        return raw
    internal = urlparse(DOCUMENT_SERVER_INTERNAL_URL)
    internal_hosts = {
        (internal.hostname or "onlyoffice").lower(),
        "onlyoffice",
        "onlyofficedocs",
        "onlyoffice-direct",
    }
    if (parsed.hostname or "").lower() in internal_hosts:
        return raw
    path = parsed.path or "/"
    path = re.sub(r"^/kin-office/ds(?=/|$)", "", path, flags=re.I)
    path = re.sub(r"^/ds(?=/|$)", "", path, flags=re.I)
    if not path.startswith("/"):
        path = "/" + path
    netloc = internal.hostname or "onlyoffice"
    if internal.port:
        netloc = "%s:%s" % (netloc, internal.port)
    rewritten = urlunparse((internal.scheme or "http", netloc, path, "", parsed.query, ""))
    print("direct-connector: rewrite save fetch %s -> %s" % (raw, rewritten), flush=True)
    return rewritten


def fetch_url(url):
    context = ssl._create_unverified_context()
    target = resolve_document_fetch_url(url)
    request = urllib.request.Request(target, headers={"User-Agent": "kin-onlyoffice-direct/1.0"})
    with urllib.request.urlopen(request, timeout=60, context=context) as response:
        return response.read()


def post_command(payload):
    endpoint = DOCUMENT_SERVER_INTERNAL_URL + "coauthoring/CommandService.ashx"
    body = json_bytes(payload)
    request = urllib.request.Request(
        endpoint,
        data=body,
        method="POST",
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        text = response.read().decode("utf-8", errors="replace")
        return response.status, text


class Handler(BaseHTTPRequestHandler):
    server_version = "KinOnlyOfficeDirect/1.0"

    def log_message(self, fmt, *args):
        print("%s - - [%s] %s" % (self.address_string(), self.log_date_time_string(), fmt % args), flush=True)

    def send_cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Accept")
        self.send_header("Access-Control-Max-Age", "86400")

    def send_json(self, status, data):
        body = json_bytes(data)
        self.send_response(status)
        self.send_cors()
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def send_bytes(self, status, body, content_type, extra_headers=None):
        self.send_response(status)
        self.send_cors()
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        if extra_headers:
            for key, value in extra_headers.items():
                self.send_header(key, value)
        self.end_headers()
        self.wfile.write(body)

    def read_json(self):
        length = int(self.headers.get("Content-Length") or "0")
        if length > MAX_UPLOAD_BYTES * 2:
            raise ValueError("Request is too large.")
        raw = self.rfile.read(length) if length else b"{}"
        if not raw:
            return {}
        return json.loads(raw.decode("utf-8"))

    def route(self):
        path = urlparse(self.path).path
        if path.startswith("/direct/"):
            path = path[len("/direct"):]
        return path or "/"

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_cors()
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self):
        cleanup_sessions()
        path = self.route()
        try:
            if path == "/health":
                self.send_json(200, {"response": "success"})
                return
            if path == "/editor":
                self.send_bytes(200, EDITOR_HTML.encode("utf-8"), "text/html; charset=utf-8")
                return
            match = re.match(r"^/api/session/([^/]+)/config$", path)
            if match:
                session = SESSIONS.get(match.group(1))
                if not session:
                    self.send_json(404, {"response": "fail", "message": "Session not found."})
                    return
                session["last_seen"] = now()
                self.send_json(200, {
                    "response": "success",
                    "api_url": DOCUMENT_SERVER_PUBLIC_URL + "web-apps/apps/api/documents/api.js",
                    "config": make_config(self, session),
                })
                return
            match = re.match(r"^/api/session/([^/]+)/state$", path)
            if match:
                session = SESSIONS.get(match.group(1))
                if not session:
                    self.send_json(404, {"response": "fail", "message": "Session not found."})
                    return
                session["last_seen"] = now()
                self.send_json(200, {"response": "success", "state": session_state(session), "info": info_payload(session)})
                return
            match = re.match(r"^/api/session/([^/]+)/content$", path)
            if match:
                session = SESSIONS.get(match.group(1))
                if not session:
                    self.send_json(404, {"response": "fail", "message": "Session not found."})
                    return
                session["last_seen"] = now()
                self.send_json(200, {
                    "response": "success",
                    "data_base64": base64.b64encode(session["content"]).decode("ascii"),
                    "state": session_state(session),
                    "info": info_payload(session),
                })
                return
            match = re.match(r"^/download/([^/]+)/([^/]+)$", path)
            if match:
                session = SESSIONS.get(match.group(1))
                if not session:
                    self.send_json(404, {"response": "fail", "message": "Session not found."})
                    return
                session["last_seen"] = now()
                self.send_bytes(200, session["content"], content_type_for(session["file_type"]), {
                    "Cache-Control": "no-store",
                    "Content-Disposition": 'inline; filename="%s"' % session["filename"].replace('"', "_"),
                })
                return
            self.send_json(404, {"response": "fail", "message": "Not found."})
        except Exception as error:
            self.send_json(500, {"response": "fail", "message": str(error)})

    def do_POST(self):
        cleanup_sessions()
        path = self.route()
        try:
            if path == "/api/session":
                data = self.read_json()
                encoded = data.get("data_base64") or data.get("dataBase64")
                reload_from_disk = bool(
                    encoded
                    or data.get("reloadFromDisk")
                    or data.get("reload_from_disk")
                )
                session = None
                if not reload_from_disk:
                    info = data.get("info") or {}
                    direct_info = info.get("kinOnlyOffice") if isinstance(info, dict) else None
                    if isinstance(direct_info, dict) and direct_info.get("sessionId"):
                        data["sessionId"] = direct_info.get("sessionId")
                        session = join_session(data)
                if not session:
                    session = create_session(data)
                self.send_json(200, response_for_session(self, session))
                return
            if path == "/api/session/join":
                session = join_session(self.read_json())
                if not session:
                    self.send_json(404, {"response": "fail", "message": "Session not found or stale."})
                    return
                self.send_json(200, response_for_session(self, session))
                return
            match = re.match(r"^/api/session/([^/]+)/document-meta$", path)
            if match:
                session = SESSIONS.get(match.group(1))
                if not session:
                    self.send_json(404, {"response": "fail", "message": "Session not found."})
                    return
                data = self.read_json()
                title = str(data.get("title") or data.get("filename") or "").strip()
                kin_path = str(data.get("path") or data.get("filePath") or "").strip()
                if kin_path:
                    session["file_path"] = kin_path
                if title:
                    session["filename"] = clean_filename(title, session["file_type"])
                elif kin_path:
                    session["filename"] = clean_filename(
                        kin_path.rsplit("/", 1)[-1], session["file_type"]
                    )
                session["last_seen"] = now()
                meta_error = None
                meta_title = session["filename"]
                try:
                    status, text = post_command({
                        "c": "meta",
                        "key": session["document_key"],
                        "meta": {"title": meta_title},
                    })
                    parsed = None
                    try:
                        parsed = json.loads(text)
                    except Exception:
                        parsed = None
                    if not (isinstance(parsed, dict) and parsed.get("error") == 0):
                        meta_error = parsed.get("error") if isinstance(parsed, dict) else text
                except Exception as error:
                    meta_error = str(error)
                self.send_json(200, {
                    "response": "success",
                    "filename": session["filename"],
                    "metaError": meta_error,
                    "state": session_state(session),
                    "info": info_payload(session),
                })
                return
            match = re.match(r"^/api/session/([^/]+)/forcesave$", path)
            if match:
                session = SESSIONS.get(match.group(1))
                if not session:
                    self.send_json(404, {"response": "fail", "message": "Session not found."})
                    return
                status, text = post_command({"c": "forcesave", "key": session["document_key"]})
                parsed = None
                try:
                    parsed = json.loads(text)
                except Exception:
                    parsed = None
                if parsed and parsed.get("error") == 0:
                    session["save_pending"] = True
                ds_error = parsed.get("error") if isinstance(parsed, dict) else None
                self.send_json(200, {
                    "response": "success",
                    "status": status,
                    "body": text,
                    "accepted": bool(parsed and parsed.get("error") == 0),
                    "error": ds_error,
                    "state": session_state(session),
                })
                return
            match = re.match(r"^/callback/([^/]+)$", path)
            if match:
                session = SESSIONS.get(match.group(1))
                callback = self.read_json()
                if not session:
                    self.send_json(200, {"error": 0})
                    return
                status = callback.get("status")
                session["last_callback_status"] = status
                session["last_callback_at"] = now()
                print(
                    "direct-connector: callback session=%s status=%s url=%s"
                    % (match.group(1), status, callback.get("url") or ""),
                    flush=True,
                )
                if status in (3, 7):
                    self.send_json(200, {"error": 1})
                    return
                if status in (2, 6) and callback.get("url"):
                    try:
                        content = fetch_url(str(callback.get("url")))
                    except Exception as error:
                        print(
                            "direct-connector: callback download failed session=%s url=%s error=%s"
                            % (match.group(1), callback.get("url"), error),
                            flush=True,
                        )
                        self.send_json(200, {"error": 1})
                        return
                    if not content:
                        print("direct-connector: callback download returned empty body", flush=True)
                        self.send_json(200, {"error": 1})
                        return
                    session["content"] = content
                    session["version"] += 1
                    session["last_saved_at"] = now()
                    session["save_pending"] = False
                elif status == 1:
                    session["save_pending"] = True
                elif status == 4:
                    session["save_pending"] = False
                self.send_json(200, {"error": 0})
                return
            self.send_json(404, {"response": "fail", "message": "Not found."})
        except (ValueError, json.JSONDecodeError) as error:
            self.send_json(400, {"response": "fail", "message": str(error)})
        except urllib.error.URLError as error:
            self.send_json(502, {"response": "fail", "message": str(error)})
        except Exception as error:
            self.send_json(500, {"response": "fail", "message": str(error)})


if __name__ == "__main__":
    httpd = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"direct connector listening on {HOST}:{PORT}", flush=True)
    httpd.serve_forever()
