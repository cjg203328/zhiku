from __future__ import annotations

import argparse
import json
import mimetypes
import posixpath
import shutil
import sys
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib import error, parse, request


REPO_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_DIST_DIR = REPO_ROOT / "apps" / "web" / "dist"
DEFAULT_API_BASE = "http://127.0.0.1:38765"


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Serve the web preview build with local API proxy support.")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=4173)
    parser.add_argument("--dist", default=str(DEFAULT_DIST_DIR))
    parser.add_argument("--api-base", default=DEFAULT_API_BASE)
    return parser


def resolve_static_path(dist_dir: Path, request_path: str) -> Path:
    parsed = parse.urlsplit(request_path)
    raw_path = parse.unquote(parsed.path)
    normalized = posixpath.normpath(raw_path)
    relative = normalized.lstrip("/")
    candidate = (dist_dir / relative).resolve()

    try:
        candidate.relative_to(dist_dir.resolve())
    except ValueError:
        return dist_dir / "index.html"

    if relative and candidate.is_file():
        return candidate

    return dist_dir / "index.html"


class PreviewHandler(BaseHTTPRequestHandler):
    server_version = "ZhikuPreview/1.0"

    def do_GET(self) -> None:  # noqa: N802
        if self.path.startswith("/api/"):
            self._proxy_request()
            return
        self._serve_static(head_only=False)

    def do_HEAD(self) -> None:  # noqa: N802
        if self.path.startswith("/api/"):
            self._proxy_request()
            return
        self._serve_static(head_only=True)

    def do_POST(self) -> None:  # noqa: N802
        self._proxy_request()

    def do_PUT(self) -> None:  # noqa: N802
        self._proxy_request()

    def do_PATCH(self) -> None:  # noqa: N802
        self._proxy_request()

    def do_DELETE(self) -> None:  # noqa: N802
        self._proxy_request()

    def do_OPTIONS(self) -> None:  # noqa: N802
        self._proxy_request()

    def log_message(self, format: str, *args: object) -> None:
        sys.stdout.write("%s - - [%s] %s\n" % (self.address_string(), self.log_date_time_string(), format % args))

    @property
    def dist_dir(self) -> Path:
        return self.server.dist_dir  # type: ignore[attr-defined]

    @property
    def api_base(self) -> str:
        return self.server.api_base  # type: ignore[attr-defined]

    def _serve_static(self, *, head_only: bool) -> None:
        target = resolve_static_path(self.dist_dir, self.path)
        if not target.exists():
            self.send_error(HTTPStatus.NOT_FOUND, "File not found")
            return

        content_type = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
        payload = target.read_bytes()

        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()

        if not head_only:
            self.wfile.write(payload)

    def _proxy_request(self) -> None:
        target_url = f"{self.api_base}{self.path}"
        body = None
        content_length = self.headers.get("Content-Length")
        if content_length:
            body = self.rfile.read(int(content_length))

        proxied = request.Request(target_url, data=body, method=self.command)
        for key, value in self.headers.items():
            lowered = key.lower()
            if lowered in {"host", "connection", "content-length"}:
                continue
            proxied.add_header(key, value)

        try:
            with request.urlopen(proxied, timeout=60) as response:
                self._relay_response(response.status, response.headers, response.read())
        except error.HTTPError as exc:
            self._relay_response(exc.code, exc.headers, exc.read())
        except Exception as exc:  # noqa: BLE001
            payload = json.dumps(
                {
                    "detail": f"本地 API 暂时不可用：{exc}",
                },
                ensure_ascii=False,
            ).encode("utf-8")
            self.send_response(HTTPStatus.BAD_GATEWAY)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

    def _relay_response(self, status: int, headers: object, payload: bytes) -> None:
        self.send_response(status)
        for key, value in headers.items():
            lowered = key.lower()
            if lowered in {"connection", "transfer-encoding", "server", "date"}:
                continue
            self.send_header(key, value)
        self.send_header("Cache-Control", "no-store")
        self.end_headers()

        if self.command != "HEAD":
            self.wfile.write(payload)


def main() -> int:
    args = build_parser().parse_args()
    dist_dir = Path(args.dist).resolve()
    if not dist_dir.exists():
        raise SystemExit(f"Web preview build not found: {dist_dir}")

    httpd = ThreadingHTTPServer((args.host, args.port), PreviewHandler)
    httpd.dist_dir = dist_dir  # type: ignore[attr-defined]
    httpd.api_base = args.api_base.rstrip("/")  # type: ignore[attr-defined]

    print(f"Zhiku preview ready: http://{args.host}:{args.port}")
    print(f"Static dir: {dist_dir}")
    print(f"API proxy: {httpd.api_base}")

    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nStopping Zhiku preview server...")
    finally:
        httpd.server_close()

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
