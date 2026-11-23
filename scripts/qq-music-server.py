#!/usr/bin/env python3
"""Lightweight async HTTP wrapper around L-1124/QQMusicApi for Claudio."""

from __future__ import annotations

import asyncio
import base64
import ipaddress
import json
import os
import random
import sys
import time
import uuid
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

# 宿主常带 Clash 全局代理 env（ALL_PROXY=socks5://…）。QQMusicApi 底层 niquests
# 会拾取它走 SOCKS，缺依赖时报错、走代理还易触发腾讯风控；QQ 接口直连即可。
# 必须在 import aiohttp / qqmusic_api 之前剥，不然它们 import 时就读走了 env。
# 设 QQ_WRAPPER_ALLOW_PROXY=1 可显式放行代理 env。
if os.environ.get("QQ_WRAPPER_ALLOW_PROXY", "") != "1":
    for _k in ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"):
        os.environ.pop(_k, None)

from aiohttp import web

DEFAULT_PORT = 33402
DEFAULT_CDN = "https://isure.stream.qqmusic.qq.com/"
CDN_TTL_SECONDS = 600
REQUEST_TIMEOUT_SECONDS = 8.0


def resolve_qq_api_dir() -> Path:
    raw = os.environ.get("QQ_API_DIR", "").strip()
    if raw:
        return Path(raw).resolve()
    return (Path(__file__).resolve().parent.parent.parent / "QQMusicApi").resolve()


QQ_API_DIR = resolve_qq_api_dir()
if str(QQ_API_DIR) not in sys.path:
    sys.path.insert(0, str(QQ_API_DIR))

from qqmusic_api import Client, Credential  # noqa: E402
from qqmusic_api.models.login import QRCodeLoginEvents, QRLoginType  # noqa: E402
from qqmusic_api.modules.search import SearchType  # noqa: E402
from qqmusic_api.modules.song import SongFileInfo, SongFileType, SongQueryInfo  # noqa: E402


def credential_file_path() -> Path:
    raw = os.environ.get("QQ_CREDENTIAL_FILE", "").strip()
    if raw:
        return Path(raw).resolve()
    return QQ_API_DIR / ".qq-credential.json"


def device_file_path() -> Path:
    raw = os.environ.get("QQ_DEVICE_FILE", "").strip()
    if raw:
        return Path(raw).resolve()
    return QQ_API_DIR / ".qq-device.json"


def load_initial_credential() -> tuple[Credential, int]:
    musicid = os.environ.get("QQ_MUSICID", "").strip()
    musickey = os.environ.get("QQ_MUSICKEY", "").strip()
    if musicid.isdigit() and musickey:
        return Credential(musicid=int(musicid), musickey=musickey), int(time.time())

    cred_path = credential_file_path()
    if cred_path.exists():
        try:
            stat_mtime = int(cred_path.stat().st_mtime)
            data = json.loads(cred_path.read_text(encoding="utf-8"))
            cred = Credential.model_validate(data)
            if cred.is_valid():
                return cred, stat_mtime
        except Exception as exc:  # pragma: no cover - defensive fallback
            print(f"[qq-wrapper] failed to read credential file: {exc}", file=sys.stderr)

    return Credential(), 0


def save_credential(cred: Credential) -> int:
    cred_path = credential_file_path()
    cred_path.parent.mkdir(parents=True, exist_ok=True)
    cred_path.write_text(cred.model_dump_json(by_alias=True, indent=2), encoding="utf-8")
    return int(time.time())


def quality_candidates(quality: str) -> list[tuple[SongFileType, str]]:
    q = (quality or "").strip().lower()
    if q in {"viper_clear", "viper_atmos", "high", "flac"}:
        return [
            (SongFileType.FLAC, "flac"),
            (SongFileType.MP3_320, "320"),
            (SongFileType.MP3_128, "128"),
            (SongFileType.ACC_192, "128"),
            (SongFileType.ACC_96, "128"),
        ]
    if q == "320":
        return [
            (SongFileType.MP3_320, "320"),
            (SongFileType.MP3_128, "128"),
            (SongFileType.ACC_192, "128"),
            (SongFileType.ACC_96, "128"),
        ]
    return [
        (SongFileType.MP3_128, "128"),
        (SongFileType.ACC_192, "128"),
        (SongFileType.ACC_96, "128"),
    ]


def serialize_song(song: Any) -> dict[str, Any]:
    singers = getattr(song, "singer", None) or []
    artist = ", ".join(s.name for s in singers if getattr(s, "name", ""))
    album_obj = getattr(song, "album", None)
    album = getattr(album_obj, "name", "") or getattr(album_obj, "title", "") or ""
    cover = ""
    if hasattr(song, "cover_url"):
        try:
            cover = song.cover_url(300) or ""
        except Exception:
            cover = ""
    file_obj = getattr(song, "file", None)
    pay_obj = getattr(song, "pay", None)
    return {
        "id": str(getattr(song, "id", "") or ""),
        "mid": str(getattr(song, "mid", "") or ""),
        "title": str(getattr(song, "title", "") or getattr(song, "name", "") or ""),
        "name": str(getattr(song, "name", "") or getattr(song, "title", "") or ""),
        "artist": artist,
        "album": album,
        "duration": int(getattr(song, "interval", 0) or 0),
        "cover": cover,
        "mediaMid": str(getattr(file_obj, "media_mid", "") or ""),
        "songType": int(getattr(song, "type", 0) or 0),
        "payPlay": int(getattr(pay_obj, "pay_play", 0) or 0),
    }


def join_cdn_url(cdn: str, purl: str) -> str:
    if purl.startswith("http://") or purl.startswith("https://"):
        return purl
    return f"{cdn.rstrip('/')}/{purl.lstrip('/')}"


def is_allowed_cdn_url(url: str) -> bool:
    try:
        parsed = urlparse(url)
    except ValueError:
        return False
    if parsed.scheme not in {"http", "https"}:
        return False
    host = (parsed.hostname or "").strip().lower()
    if not host:
        return False
    try:
        ipaddress.ip_address(host)
        return False
    except ValueError:
        pass
    return host.endswith(".qq.com") or host == "qq.com"


class QQMusicService:
    def __init__(self) -> None:
        initial_cred, saved_at_sec = load_initial_credential()
        dev_path = device_file_path()
        try:
            dev_path.parent.mkdir(parents=True, exist_ok=True)
        except Exception:
            pass
        self.client = Client(credential=initial_cred, device_path=str(dev_path))
        self._cred_saved_at_sec: int = saved_at_sec
        self._refresh_lock = asyncio.Lock()
        self._cdn_hosts: list[str] = [DEFAULT_CDN]
        self._cdn_expires_at: float = 0.0
        self._qr_sessions: dict[str, Any] = {}

    @property
    def logged_in(self) -> bool:
        return bool(self.client.credential.is_valid())

    def credential_meta(self) -> dict[str, Any]:
        cred = self.client.credential
        logged_in = bool(cred.is_valid())
        if not logged_in:
            return {
                "loggedIn": False,
                "musicid": 0,
                "loginType": 0,
                "canRefresh": False,
                "credentialCreatedAt": None,
                "credentialAgeMs": None,
                "keyExpiresIn": 0,
                "expiresAt": None,
                "expiresInMs": None,
                "expired": False,
            }

        now_ms = int(time.time() * 1000)
        created_sec = int(cred.musickey_create_time or 0) or int(self._cred_saved_at_sec or 0)
        created_ms = created_sec * 1000 if created_sec > 0 else None
        age_ms = max(0, now_ms - created_ms) if created_ms is not None else None
        key_expires_in = int(cred.key_expires_in or 0)
        expires_at_ms: int | None = None
        if int(cred.musickey_create_time or 0) > 0 and key_expires_in > 0:
            expires_at_ms = (int(cred.musickey_create_time) + key_expires_in) * 1000
        elif created_sec > 0 and key_expires_in > 0:
            expires_at_ms = (created_sec + key_expires_in) * 1000
        expires_in_ms = (expires_at_ms - now_ms) if expires_at_ms is not None else None
        expired = bool(cred.is_expired()) if (cred.musickey_create_time > 0 and cred.key_expires_in > 0) else False

        return {
            "loggedIn": True,
            "musicid": int(cred.musicid or 0),
            "loginType": int(cred.login_type or 0),
            "canRefresh": bool(cred.refresh_key or cred.refresh_token),
            "credentialCreatedAt": created_ms,
            "credentialAgeMs": age_ms,
            "keyExpiresIn": key_expires_in,
            "expiresAt": expires_at_ms,
            "expiresInMs": expires_in_ms,
            "expired": expired,
        }

    async def get_cdn_base(self) -> str:
        now = time.monotonic()
        if now < self._cdn_expires_at and self._cdn_hosts:
            return random.choice(self._cdn_hosts)
        try:
            dispatch = await asyncio.wait_for(self.client.song.get_cdn_dispatch(), timeout=4.0)
            sip = [u for u in (getattr(dispatch, "sip", None) or []) if isinstance(u, str) and is_allowed_cdn_url(u)]
            https_sip = [u for u in sip if u.startswith("https://")]
            chosen = https_sip or sip
            if chosen:
                self._cdn_hosts = chosen
                self._cdn_expires_at = now + CDN_TTL_SECONDS
                return random.choice(self._cdn_hosts)
        except Exception:
            pass
        return DEFAULT_CDN

    async def health(self) -> dict[str, Any]:
        meta = self.credential_meta()
        return {
            "ok": True,
            **meta,
            "detail": (
                f"logged in ({meta['musicid']})"
                if meta["loggedIn"]
                else "unauthenticated (search only / free tracks)"
            ),
        }

    async def search(self, keywords: str, num: int = 15) -> list[dict[str, Any]]:
        last_exc: Exception | None = None

        async def _via_general() -> list[dict[str, Any]]:
            resp = await asyncio.wait_for(
                self.client.search.general_search(keywords, page=1, num=num),
                timeout=REQUEST_TIMEOUT_SECONDS,
            )
            songs = getattr(getattr(resp, "song", None), "items", None) or []
            return [serialize_song(s) for s in songs if getattr(s, "mid", "")]

        async def _via_type() -> list[dict[str, Any]]:
            resp = await asyncio.wait_for(
                self.client.search.search_by_type(keywords, search_type=SearchType.SONG, num=num),
                timeout=REQUEST_TIMEOUT_SECONDS,
            )
            songs = getattr(resp, "song", None) or []
            return [serialize_song(s) for s in songs if getattr(s, "mid", "")]

        async def _via_quick() -> list[dict[str, Any]]:
            resp = await asyncio.wait_for(
                self.client.search.quick_search(keywords),
                timeout=REQUEST_TIMEOUT_SECONDS,
            )
            items = getattr(getattr(resp, "song", None), "itemlist", None) or []
            out: list[dict[str, Any]] = []
            for item in items:
                mid = str(getattr(item, "mid", "") or "").strip()
                title = str(getattr(item, "name", "") or "").strip()
                if not mid or not title:
                    continue
                out.append({
                    "id": str(getattr(item, "id", "") or ""),
                    "mid": mid,
                    "title": title,
                    "name": title,
                    "artist": str(getattr(item, "singer", "") or "").strip(),
                    "album": "",
                    "duration": 0,
                    "cover": str(getattr(item, "pic", "") or "").strip(),
                    "mediaMid": "",
                    "songType": 0,
                    "payPlay": 0,
                })
            return out

        methods = (_via_type, _via_general, _via_quick) if self.logged_in else (_via_general, _via_type, _via_quick)
        for fn in methods:
            try:
                tracks = await fn()
                if tracks:
                    return tracks[:num]
            except Exception as exc:
                last_exc = exc

        if last_exc is not None:
            raise last_exc
        return []

    async def song_url(
        self,
        mid: str,
        *,
        quality: str = "flac",
        media_mid: str = "",
        song_type: int | None = None,
    ) -> dict[str, Any]:
        resolved_media_mid = media_mid.strip() or None
        resolved_song_type = song_type

        if not resolved_media_mid:
            try:
                q_resp = await asyncio.wait_for(
                    self.client.song.query_song([SongQueryInfo(mid=mid)]),
                    timeout=5.0,
                )
                tracks = getattr(q_resp, "tracks", None) or []
                if tracks:
                    resolved_media_mid = getattr(tracks[0].file, "media_mid", "") or None
                    if resolved_song_type is None:
                        resolved_song_type = getattr(tracks[0], "type", None)
            except Exception:
                pass

        cdn = await self.get_cdn_base()
        for file_type, label in quality_candidates(quality):
            try:
                resp = await asyncio.wait_for(
                    self.client.song.get_song_urls(
                        [
                            SongFileInfo(
                                mid=mid,
                                file_type=file_type,
                                song_type=resolved_song_type,
                                media_mid=resolved_media_mid,
                            )
                        ],
                        file_type=file_type,
                    ),
                    timeout=5.0,
                )
            except Exception:
                continue

            items = getattr(resp, "data", None) or []
            if not items:
                continue
            item = items[0]
            purl = str(getattr(item, "purl", "") or "").strip()
            if not purl:
                continue
            # Ignore encrypted or trial fragments if any slip through
            if purl.startswith("RS02") or ".mflac" in purl or ".mgg" in purl:
                continue
            return {
                "ok": True,
                "url": join_cdn_url(cdn, purl),
                "quality": label,
                "loggedIn": self.logged_in,
                "reason": None,
            }

        return {
            "ok": True,
            "url": None,
            "quality": None,
            "loggedIn": self.logged_in,
            "reason": "unavailable" if self.logged_in else "login_required",
        }

    async def lyric(self, mid: str) -> str | None:
        resp = await asyncio.wait_for(self.client.lyric.get_lyric(mid), timeout=REQUEST_TIMEOUT_SECONDS)
        text = str(getattr(resp, "lyric", "") or "").strip()
        return text or None

    async def playlist(self, playlist_id: int, limit: int = 300) -> dict[str, Any]:
        tracks: list[dict[str, Any]] = []
        page = 1
        per_page = min(100, max(1, limit))
        total_count = 0
        name = ""

        while len(tracks) < limit:
            resp = await asyncio.wait_for(
                self.client.songlist.get_detail(playlist_id, num=per_page, page=page),
                timeout=REQUEST_TIMEOUT_SECONDS,
            )
            if page == 1:
                total_count = int(getattr(resp, "total", 0) or 0)
                info = getattr(resp, "info", None)
                name = str(getattr(info, "title", "") or "")
            songs = getattr(resp, "songs", None) or []
            if not songs:
                break
            tracks.extend(serialize_song(s) for s in songs if getattr(s, "mid", ""))
            if not getattr(resp, "hasmore", 0) or (total_count and len(tracks) >= total_count):
                break
            page += 1

        sliced = tracks[:limit]
        return {
            "ok": True,
            "name": name,
            "tracks": sliced,
            "totalCount": total_count or len(sliced),
            "fetchedCount": len(sliced),
            "truncated": bool(total_count and len(sliced) < total_count),
        }

    async def start_qr_login(self, login_type: str = "qq") -> dict[str, Any]:
        kind = QRLoginType.WX if login_type.strip().lower() == "wx" else QRLoginType.QQ
        qr = await asyncio.wait_for(self.client.login.get_qrcode(kind), timeout=REQUEST_TIMEOUT_SECONDS)
        key = str(uuid.uuid4())
        self._qr_sessions[key] = qr
        b64 = base64.b64encode(qr.data).decode("ascii")
        return {
            "ok": True,
            "key": key,
            "type": kind.value,
            "qrImg": f"data:{qr.mimetype};base64,{b64}",
        }

    async def check_qr_login(self, key: str) -> dict[str, Any]:
        qr = self._qr_sessions.get(key)
        if qr is None:
            return {"ok": False, "error": "invalid or expired qr key"}
        try:
            result = await asyncio.wait_for(self.client.login.check_qrcode(qr), timeout=4.0)
        except TimeoutError:
            return {"ok": True, "status": 1, "statusText": "等扫码", "loggedIn": self.logged_in}

        event = result.event
        if event == QRCodeLoginEvents.DONE and result.credential is not None:
            self.client.credential = result.credential
            self._cred_saved_at_sec = save_credential(result.credential)
            self._qr_sessions.pop(key, None)
            meta = self.credential_meta()
            return {
                "ok": True,
                "status": 4,
                "statusText": "成功",
                **meta,
            }
        if event == QRCodeLoginEvents.CONF:
            return {"ok": True, "status": 2, "statusText": "等确认", "loggedIn": self.logged_in}
        if event in (QRCodeLoginEvents.TIMEOUT, QRCodeLoginEvents.REFUSE):
            self._qr_sessions.pop(key, None)
            return {"ok": True, "status": 0, "statusText": "已过期" if event == QRCodeLoginEvents.TIMEOUT else "已拒绝", "loggedIn": self.logged_in}
        return {"ok": True, "status": 1, "statusText": "等扫码", "loggedIn": self.logged_in}

    async def refresh_login(self) -> dict[str, Any]:
        async with self._refresh_lock:
            cred = self.client.credential
            if not cred.is_valid():
                return {"ok": False, "loggedIn": False, "reason": "not logged in"}
            if not (cred.refresh_key or cred.refresh_token):
                return {
                    "ok": False,
                    "loggedIn": True,
                    "canRefresh": False,
                    "reason": "credential has no refresh_key or refresh_token",
                }
            try:
                refreshed = await asyncio.wait_for(
                    self.client.login.refresh_credential(cred),
                    timeout=REQUEST_TIMEOUT_SECONDS,
                )
            except Exception as exc:
                return {
                    "ok": False,
                    "loggedIn": self.logged_in,
                    "reason": str(exc),
                }
            self.client.credential = refreshed
            self._cred_saved_at_sec = save_credential(refreshed)
            return {
                "ok": True,
                **self.credential_meta(),
            }


def create_app() -> web.Application:
    service = QQMusicService()
    app = web.Application()

    async def on_cleanup(_app: web.Application) -> None:
        await service.client.close()

    app.on_cleanup.append(on_cleanup)

    async def handle_health(_request: web.Request) -> web.Response:
        return web.json_response(await service.health())

    async def handle_search(request: web.Request) -> web.Response:
        keywords = request.query.get("keywords", "").strip() or request.query.get("q", "").strip()
        if not keywords:
            return web.json_response({"ok": False, "error": "keywords required"}, status=400)
        try:
            num = max(1, min(30, int(request.query.get("num", "15"))))
        except ValueError:
            num = 15
        try:
            tracks = await service.search(keywords, num=num)
            return web.json_response({"ok": True, "tracks": tracks})
        except Exception as exc:
            return web.json_response({"ok": False, "error": str(exc)}, status=502)

    async def handle_song_url(request: web.Request) -> web.Response:
        mid = request.query.get("mid", "").strip()
        if not mid:
            return web.json_response({"ok": False, "error": "mid required"}, status=400)
        quality = request.query.get("quality", "flac").strip()
        media_mid = request.query.get("media_mid", "").strip()
        raw_st = request.query.get("song_type", "").strip()
        song_type = int(raw_st) if raw_st.isdigit() else None
        try:
            data = await service.song_url(mid, quality=quality, media_mid=media_mid, song_type=song_type)
            return web.json_response(data)
        except Exception as exc:
            return web.json_response({"ok": False, "error": str(exc)}, status=502)

    async def handle_lyric(request: web.Request) -> web.Response:
        mid = request.query.get("mid", "").strip()
        if not mid:
            return web.json_response({"ok": False, "error": "mid required"}, status=400)
        try:
            text = await service.lyric(mid)
            return web.json_response({"ok": True, "lyric": text})
        except Exception as exc:
            return web.json_response({"ok": False, "error": str(exc)}, status=502)

    async def handle_playlist(request: web.Request) -> web.Response:
        raw_id = request.query.get("id", "").strip()
        if not raw_id.isdigit():
            return web.json_response({"ok": False, "error": "numeric playlist id required"}, status=400)
        try:
            limit = max(1, min(500, int(request.query.get("limit", "300"))))
        except ValueError:
            limit = 300
        try:
            data = await service.playlist(int(raw_id), limit=limit)
            return web.json_response(data)
        except Exception as exc:
            return web.json_response({"ok": False, "error": str(exc)}, status=502)

    async def handle_qr_start(request: web.Request) -> web.Response:
        login_type = request.query.get("type", "qq").strip()
        try:
            data = await service.start_qr_login(login_type)
            return web.json_response(data)
        except Exception as exc:
            return web.json_response({"ok": False, "error": str(exc)}, status=502)

    async def handle_qr_check(request: web.Request) -> web.Response:
        key = request.query.get("key", "").strip()
        if not key:
            return web.json_response({"ok": False, "error": "key required"}, status=400)
        try:
            data = await service.check_qr_login(key)
            status_code = 200 if data.get("ok") else 404
            return web.json_response(data, status=status_code)
        except Exception as exc:
            return web.json_response({"ok": False, "error": str(exc)}, status=502)

    async def handle_login_status(_request: web.Request) -> web.Response:
        return web.json_response({
            "ok": True,
            **service.credential_meta(),
        })

    async def handle_login_refresh(_request: web.Request) -> web.Response:
        return web.json_response(await service.refresh_login())

    app.router.add_get("/health", handle_health)
    app.router.add_get("/search", handle_search)
    app.router.add_get("/song/url", handle_song_url)
    app.router.add_get("/lyric", handle_lyric)
    app.router.add_get("/playlist", handle_playlist)
    app.router.add_post("/login/qr/start", handle_qr_start)
    app.router.add_get("/login/qr/check", handle_qr_check)
    app.router.add_get("/login/status", handle_login_status)
    app.router.add_post("/login/refresh", handle_login_refresh)
    return app


def main() -> None:
    port = int(os.environ.get("PORT", str(DEFAULT_PORT)))
    host = os.environ.get("HOST", "127.0.0.1")
    print(f"[qq-wrapper] listening on http://{host}:{port} (QQ_API_DIR={QQ_API_DIR})", flush=True)
    web.run_app(create_app(), host=host, port=port, print=None)


if __name__ == "__main__":
    main()
