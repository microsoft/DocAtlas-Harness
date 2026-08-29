"""Secure, dependency-free remote PDF acquisition for the interactive TUI."""

from __future__ import annotations

import hashlib
import http.client
import ipaddress
import json
import os
import re
import socket
import ssl
import tempfile
import time
import unicodedata
from dataclasses import dataclass
from email.message import Message
from pathlib import Path
from typing import Any
from urllib.parse import quote, unquote, urljoin, urlsplit, urlunsplit

from .preprocess._io import atomic_write_json

DEFAULT_MAX_PDF_BYTES = 100 * 1024 * 1024
DEFAULT_TIMEOUT_SECONDS = 30.0
DEFAULT_TOTAL_TIMEOUT_SECONDS = 120.0
DEFAULT_MAX_REDIRECTS = 5
_ALLOWED_CONTENT_TYPES = {
    "application/pdf",
    "application/x-pdf",
    "application/octet-stream",
    "binary/octet-stream",
}
_REDIRECT_STATUSES = {301, 302, 303, 307, 308}
_DOWNLOAD_SCHEMA_VERSION = 1
_USER_AGENT = "DocAtlas/0.3 remote-pdf"
_HTTP_URL_TOKEN_RE = re.compile(r"https?://[^\s]+", re.IGNORECASE)
_WINDOWS_RESERVED_NAMES = {
    "CON",
    "PRN",
    "AUX",
    "NUL",
    *(f"COM{number}" for number in range(1, 10)),
    *(f"LPT{number}" for number in range(1, 10)),
}


class RemotePDFError(ValueError):
    """A remote document was unsafe, unavailable, or not a valid PDF."""


@dataclass(frozen=True)
class DownloadedPDF:
    path: Path
    display_url: str
    size: int
    from_cache: bool


def mask_url_query_values(value: str) -> str:
    """Mask URL query values for terminal echo while preserving cursor offsets."""
    characters = list(value)
    for match in _HTTP_URL_TOKEN_RE.finditer(value):
        query_offset = match.group(0).find("?")
        if query_offset < 0:
            continue
        start = match.start() + query_offset + 1
        for index in range(start, match.end()):
            characters[index] = "*"
    return "".join(characters)


def is_http_url(value: str) -> bool:
    try:
        return urlsplit(value.strip()).scheme.casefold() in {"http", "https"}
    except ValueError:
        return False


def safe_display_url(value: str) -> str:
    """Return a URL without credentials, query parameters, or fragments."""
    try:
        parts = urlsplit(value)
    except ValueError:
        return "remote PDF"
    hostname = parts.hostname or "remote"
    try:
        port = parts.port
    except ValueError:
        port = None
    default_port = 443 if parts.scheme.casefold() == "https" else 80
    display_host = f"[{hostname}]" if ":" in hostname else hostname
    netloc = display_host if port in {None, default_port} else f"{display_host}:{port}"
    raw_name = Path(unquote(parts.path)).name
    safe_name = "".join(
        char
        for char in raw_name
        if unicodedata.category(char) not in {"Cc", "Cf", "Cs"} and char not in {"/", "\\"}
    )
    path = f"/{safe_name}" if safe_name else "/"
    return urlunsplit((parts.scheme.casefold(), netloc, path, "", ""))


def _validated_url(value: str) -> str:
    if len(value) > 8_192:
        raise RemotePDFError("remote PDF URL is too long")
    if any(unicodedata.category(char) in {"Cc", "Cf", "Cs"} for char in value):
        raise RemotePDFError("remote PDF URL contains unsupported control characters")
    try:
        parts = urlsplit(value.strip())
        port = parts.port
    except ValueError as exc:
        raise RemotePDFError("remote PDF URL is invalid") from exc
    scheme = parts.scheme.casefold()
    if scheme not in {"http", "https"}:
        raise RemotePDFError("remote PDFs must use an HTTP or HTTPS URL")
    if not parts.hostname:
        raise RemotePDFError("remote PDF URL is missing a hostname")
    try:
        parts.hostname.encode("idna")
    except UnicodeError as exc:
        raise RemotePDFError("remote PDF URL has an invalid hostname") from exc
    if parts.username is not None or parts.password is not None:
        raise RemotePDFError("credentials embedded in remote PDF URLs are unsupported")
    if port is not None and not 1 <= port <= 65_535:
        raise RemotePDFError("remote PDF URL has an invalid port")
    path = parts.path or "/"
    return urlunsplit((scheme, parts.netloc, path, parts.query, ""))


def _resolve_public_addresses(hostname: str, port: int) -> list[str]:
    """Resolve a host once and reject every non-global result before connecting."""
    try:
        records = socket.getaddrinfo(hostname, port, type=socket.SOCK_STREAM)
    except socket.gaierror as exc:
        raise RemotePDFError(f"could not resolve remote PDF host {hostname}") from exc
    addresses: list[str] = []
    for record in records:
        raw_address = str(record[4][0]).split("%", 1)[0]
        try:
            address = ipaddress.ip_address(raw_address)
        except ValueError as exc:
            raise RemotePDFError("remote PDF host resolved to an invalid address") from exc
        if not address.is_global:
            raise RemotePDFError(
                "remote PDF URL resolves to a local, private, reserved, or non-routable address"
            )
        rendered = str(address)
        if rendered not in addresses:
            addresses.append(rendered)
    if not addresses:
        raise RemotePDFError("remote PDF host did not resolve to a usable address")
    return addresses


def _request_target(path: str, query: str) -> str:
    safe_path = quote(path or "/", safe="/%:@!$&'()*+,;=-._~")
    safe_query = quote(query, safe="=&;%:@!$'()*+,/?-._~")
    return safe_path + (f"?{safe_query}" if safe_query else "")


def _open_response(
    url: str,
    headers: dict[str, str],
    *,
    timeout: float,
) -> tuple[http.client.HTTPConnection, http.client.HTTPResponse]:
    """Open one request pinned to an address that passed the SSRF policy."""
    parts = urlsplit(url)
    hostname = parts.hostname or ""
    ascii_hostname = hostname.encode("idna").decode("ascii")
    scheme = parts.scheme.casefold()
    port = parts.port or (443 if scheme == "https" else 80)
    addresses = _resolve_public_addresses(ascii_hostname, port)
    last_error: OSError | ssl.SSLError | None = None
    for address in addresses:
        raw_socket: socket.socket | None = None
        connection: http.client.HTTPConnection | None = None
        try:
            raw_socket = socket.create_connection((address, port), timeout=timeout)
            transport: socket.socket
            if scheme == "https":
                context = ssl.create_default_context()
                transport = context.wrap_socket(raw_socket, server_hostname=ascii_hostname)
            else:
                transport = raw_socket
            connection = http.client.HTTPConnection(ascii_hostname, port, timeout=timeout)
            connection.sock = transport
            default_port = 443 if scheme == "https" else 80
            if ":" in ascii_hostname:
                host_header = f"[{ascii_hostname}]"
            else:
                host_header = ascii_hostname
            if port != default_port:
                host_header += f":{port}"
            request_headers = {"Host": host_header, **headers}
            connection.request(
                "GET",
                _request_target(parts.path, parts.query),
                headers=request_headers,
            )
            return connection, connection.getresponse()
        except (OSError, ssl.SSLError) as exc:
            last_error = exc
            if connection is not None:
                connection.close()
            elif raw_socket is not None:
                raw_socket.close()
    raise RemotePDFError(f"could not connect to remote PDF host {hostname}") from last_error


def _safe_filename(url: str, content_disposition: str | None, url_digest: str) -> str:
    filename = ""
    if content_disposition:
        message = Message()
        message["content-disposition"] = content_disposition
        filename = message.get_filename() or ""
    if not filename:
        filename = Path(unquote(urlsplit(url).path)).name
    filename = unicodedata.normalize("NFC", filename)
    filename = "".join(
        "_"
        if char in {"<", ">", ":", '"', "/", "\\", "|", "?", "*"}
        or unicodedata.category(char) in {"Cc", "Cf", "Cs"}
        else char
        for char in filename
    )
    filename = filename.strip(" .")
    if not filename or filename in {".", ".."}:
        filename = f"remote-{url_digest[:12]}.pdf"
    if Path(filename).suffix.casefold() != ".pdf":
        filename = f"{filename}.pdf"
    if Path(filename).stem.upper() in _WINDOWS_RESERVED_NAMES:
        filename = f"_{filename}"
    if len(filename) > 120:
        filename = filename[:116].rstrip(" .") + ".pdf"
    return filename


def _valid_cached_pdf(
    path: Path,
    *,
    max_bytes: int,
    expected_size: Any = None,
    expected_digest: Any = None,
) -> bool:
    try:
        if path.is_symlink() or not path.is_file():
            return False
        size = path.stat().st_size
        if size <= 0 or size > max_bytes:
            return False
        if isinstance(expected_size, int) and size != expected_size:
            return False
        with path.open("rb") as handle:
            if b"%PDF-" not in handle.read(1_024):
                return False
            if isinstance(expected_digest, str) and len(expected_digest) == 64:
                digest = hashlib.sha256()
                handle.seek(0)
                for chunk in iter(lambda: handle.read(64 * 1024), b""):
                    digest.update(chunk)
                if digest.hexdigest() != expected_digest:
                    return False
            return True
    except OSError:
        return False


def _load_metadata(entry_dir: Path, *, max_bytes: int) -> tuple[dict[str, Any], Path | None]:
    metadata_path = entry_dir / "metadata.json"
    try:
        metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError):
        return {}, None
    if not isinstance(metadata, dict) or metadata.get("schema_version") != _DOWNLOAD_SCHEMA_VERSION:
        return {}, None
    filename = metadata.get("filename")
    if not isinstance(filename, str) or Path(filename).name != filename:
        return {}, None
    candidate = entry_dir / filename
    return (
        metadata,
        candidate
        if _valid_cached_pdf(
            candidate,
            max_bytes=max_bytes,
            expected_size=metadata.get("size"),
            expected_digest=metadata.get("sha256"),
        )
        else None,
    )


def _content_length(response: http.client.HTTPResponse) -> int | None:
    raw = response.getheader("Content-Length")
    if raw is None:
        return None
    try:
        value = int(raw)
    except ValueError as exc:
        raise RemotePDFError("remote PDF returned an invalid Content-Length") from exc
    if value < 0:
        raise RemotePDFError("remote PDF returned an invalid Content-Length")
    return value


def _write_response(
    response: http.client.HTTPResponse,
    destination_dir: Path,
    *,
    filename: str,
    max_bytes: int,
    cached_path: Path | None = None,
    cached_digest: str = "",
    deadline: float | None = None,
) -> tuple[Path, int, str, bool]:
    content_type = (response.getheader("Content-Type") or "").partition(";")[0].strip().casefold()
    if content_type and content_type not in _ALLOWED_CONTENT_TYPES:
        raise RemotePDFError(f"remote URL returned {content_type}, not a PDF")
    content_encoding = (response.getheader("Content-Encoding") or "identity").casefold()
    if content_encoding not in {"", "identity"}:
        raise RemotePDFError("compressed remote PDF responses are unsupported")
    declared_length = _content_length(response)
    if declared_length is not None and declared_length > max_bytes:
        raise RemotePDFError(f"remote PDF exceeds the {max_bytes // (1024 * 1024)} MB limit")

    descriptor, temporary_name = tempfile.mkstemp(
        prefix=".download-", suffix=".tmp", dir=str(destination_dir)
    )
    temporary = Path(temporary_name)
    digest = hashlib.sha256()
    total = 0
    prefix = bytearray()
    try:
        with os.fdopen(descriptor, "wb") as handle:
            while True:
                if deadline is not None and time.monotonic() >= deadline:
                    raise RemotePDFError("remote PDF download exceeded its time limit")
                chunk = response.read(64 * 1024)
                if not chunk:
                    break
                total += len(chunk)
                if total > max_bytes:
                    raise RemotePDFError(
                        f"remote PDF exceeds the {max_bytes // (1024 * 1024)} MB limit"
                    )
                if len(prefix) < 1_024:
                    prefix.extend(chunk[: 1_024 - len(prefix)])
                digest.update(chunk)
                handle.write(chunk)
            handle.flush()
            os.fsync(handle.fileno())
        if b"%PDF-" not in prefix:
            raise RemotePDFError("remote response does not contain a valid PDF header")
        if total == 0:
            raise RemotePDFError("remote PDF response was empty")
        content_digest = digest.hexdigest()
        if (
            cached_path is not None
            and cached_digest == content_digest
            and _valid_cached_pdf(
                cached_path,
                max_bytes=max_bytes,
                expected_size=total,
                expected_digest=content_digest,
            )
        ):
            temporary.unlink()
            return cached_path, total, content_digest, True
        destination = destination_dir / filename
        os.replace(temporary, destination)
        try:
            destination.chmod(0o600)
        except OSError:
            pass
        return destination, total, content_digest, False
    except BaseException:
        try:
            temporary.unlink()
        except OSError:
            pass
        raise


class RemotePDFDownloader:
    """Download validated PDFs into a private URL-keyed cache."""

    def __init__(
        self,
        cache_root: str | Path,
        *,
        max_bytes: int = DEFAULT_MAX_PDF_BYTES,
        timeout: float = DEFAULT_TIMEOUT_SECONDS,
        total_timeout: float = DEFAULT_TOTAL_TIMEOUT_SECONDS,
        max_redirects: int = DEFAULT_MAX_REDIRECTS,
    ) -> None:
        if max_bytes < 1:
            raise ValueError("max_bytes must be positive")
        if timeout <= 0:
            raise ValueError("timeout must be positive")
        if total_timeout <= 0:
            raise ValueError("total_timeout must be positive")
        if max_redirects < 0:
            raise ValueError("max_redirects must not be negative")
        self.cache_root = Path(cache_root).expanduser().absolute()
        self.max_bytes = max_bytes
        self.timeout = timeout
        self.total_timeout = total_timeout
        self.max_redirects = max_redirects

    def _entry(self, url: str) -> tuple[str, Path]:
        url_digest = hashlib.sha256(url.encode("utf-8")).hexdigest()
        directories = (
            self.cache_root,
            self.cache_root / url_digest[:2],
            self.cache_root / url_digest[:2] / url_digest,
        )
        for index, directory in enumerate(directories):
            if directory.is_symlink():
                raise RemotePDFError("remote PDF cache may not contain symbolic links")
            directory.mkdir(parents=index == 0, exist_ok=True, mode=0o700)
            try:
                directory.chmod(0o700)
            except OSError:
                pass
        entry_dir = directories[-1]
        return url_digest, entry_dir

    def download(self, value: str) -> DownloadedPDF:
        initial_url = _validated_url(value)
        deadline = time.monotonic() + self.total_timeout
        display_url = safe_display_url(initial_url)
        url_digest, entry_dir = self._entry(initial_url)
        metadata, cached_path = _load_metadata(entry_dir, max_bytes=self.max_bytes)
        conditional_headers = {}
        if cached_path is not None:
            if isinstance(metadata.get("etag"), str) and metadata["etag"]:
                conditional_headers["If-None-Match"] = metadata["etag"]
            if isinstance(metadata.get("last_modified"), str) and metadata["last_modified"]:
                conditional_headers["If-Modified-Since"] = metadata["last_modified"]

        current_url = initial_url
        previous_scheme = urlsplit(initial_url).scheme.casefold()
        headers = {
            "Accept": "application/pdf, application/octet-stream;q=0.8",
            "Accept-Encoding": "identity",
            "Connection": "close",
            "User-Agent": _USER_AGENT,
            **conditional_headers,
        }
        for redirect_count in range(self.max_redirects + 1):
            connection: http.client.HTTPConnection | None = None
            response: http.client.HTTPResponse | None = None
            try:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise RemotePDFError("remote PDF download exceeded its time limit")
                connection, response = _open_response(
                    current_url,
                    headers,
                    timeout=min(self.timeout, max(0.001, remaining)),
                )
                if response.status in _REDIRECT_STATUSES:
                    if redirect_count >= self.max_redirects:
                        raise RemotePDFError("remote PDF exceeded the redirect limit")
                    location = response.getheader("Location")
                    if not location:
                        raise RemotePDFError("remote PDF redirect omitted its destination")
                    redirected = _validated_url(urljoin(current_url, location))
                    next_scheme = urlsplit(redirected).scheme.casefold()
                    if previous_scheme == "https" and next_scheme != "https":
                        raise RemotePDFError("remote PDF redirect attempted to downgrade HTTPS")
                    previous_parts = urlsplit(current_url)
                    redirected_parts = urlsplit(redirected)
                    previous_origin = (
                        previous_parts.scheme.casefold(),
                        previous_parts.hostname,
                        previous_parts.port,
                    )
                    redirected_origin = (
                        redirected_parts.scheme.casefold(),
                        redirected_parts.hostname,
                        redirected_parts.port,
                    )
                    if previous_origin != redirected_origin:
                        headers.pop("If-None-Match", None)
                        headers.pop("If-Modified-Since", None)
                    current_url = redirected
                    previous_scheme = next_scheme
                    continue
                if response.status == 304:
                    if cached_path is None:
                        raise RemotePDFError("remote PDF cache validation returned no usable file")
                    return DownloadedPDF(
                        path=cached_path,
                        display_url=display_url,
                        size=cached_path.stat().st_size,
                        from_cache=True,
                    )
                if response.status != 200:
                    raise RemotePDFError(f"remote PDF request failed with HTTP {response.status}")

                filename = _safe_filename(
                    current_url,
                    response.getheader("Content-Disposition"),
                    url_digest,
                )
                path, size, content_digest, reused = _write_response(
                    response,
                    entry_dir,
                    filename=filename,
                    max_bytes=self.max_bytes,
                    cached_path=cached_path,
                    cached_digest=(
                        str(metadata.get("sha256"))
                        if isinstance(metadata.get("sha256"), str)
                        else ""
                    ),
                    deadline=deadline,
                )
                metadata_payload = {
                    "schema_version": _DOWNLOAD_SCHEMA_VERSION,
                    "source": safe_display_url(initial_url),
                    "final_source": safe_display_url(current_url),
                    "filename": path.name,
                    "size": size,
                    "sha256": content_digest,
                    "etag": response.getheader("ETag") or "",
                    "last_modified": response.getheader("Last-Modified") or "",
                }
                atomic_write_json(entry_dir / "metadata.json", metadata_payload)
                try:
                    (entry_dir / "metadata.json").chmod(0o600)
                except OSError:
                    pass
                return DownloadedPDF(path, display_url, size, reused)
            except (http.client.HTTPException, TimeoutError, OSError) as exc:
                raise RemotePDFError(f"could not download {display_url}") from exc
            finally:
                if response is not None:
                    response.close()
                if connection is not None:
                    connection.close()
        raise RemotePDFError("remote PDF exceeded the redirect limit")


__all__ = [
    "DEFAULT_MAX_PDF_BYTES",
    "DEFAULT_TOTAL_TIMEOUT_SECONDS",
    "DownloadedPDF",
    "RemotePDFDownloader",
    "RemotePDFError",
    "is_http_url",
    "mask_url_query_values",
    "safe_display_url",
]
