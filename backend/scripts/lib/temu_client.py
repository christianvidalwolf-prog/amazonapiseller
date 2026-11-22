"""Small, deliberately non-retrying client for the Temu Open Platform."""
from __future__ import annotations

import hashlib
import json
import time
from dataclasses import dataclass
from typing import Any, Mapping

import requests


class TemuApiError(RuntimeError):
    def __init__(self, code: str, message: str, status_code: int | None = None):
        self.code = code
        self.message = message
        self.status_code = status_code
        super().__init__(f"Temu API error {code}: {message}")

    @property
    def is_ip_whitelist_error(self) -> bool:
        return self.code == "5000003" or "NOT_IN_IP_WHITE_LIST" in self.message


@dataclass(frozen=True)
class TemuCredentials:
    app_key: str
    app_secret: str
    access_token: str
    api_base_url: str

    @classmethod
    def from_mapping(cls, values: Mapping[str, Any]) -> "TemuCredentials":
        names = {
            "app_key": "TEMU_APP_KEY",
            "app_secret": "TEMU_APP_SECRET",
            "access_token": "TEMU_ACCESS_TOKEN",
            "api_base_url": "TEMU_API_BASE_URL",
        }
        missing = [env_name for attr, env_name in names.items() if not values.get(env_name)]
        if missing:
            raise ValueError("Missing Temu configuration keys: " + ", ".join(missing))
        return cls(**{attr: str(values[env_name]) for attr, env_name in names.items()})


def _signature(params: Mapping[str, Any], app_secret: str) -> str:
    pieces = []
    for key in sorted(params):
        value = json.dumps(params[key], ensure_ascii=False, separators=(",", ":"))
        pieces.append(key + value.strip('"'))
    source = app_secret + "".join(pieces) + app_secret
    return hashlib.md5(source.encode("utf-8")).hexdigest().upper()


class TemuClient:
    """Signed JSON POST client. It applies a 200 ms minimum gap and never retries."""

    def __init__(
        self,
        credentials: TemuCredentials,
        *,
        session: requests.Session | None = None,
        min_interval_seconds: float = 0.2,
        timeout_seconds: float = 30,
    ):
        self.credentials = credentials
        base = credentials.api_base_url.rstrip("/")
        self.url = base if base.endswith("/openapi/router") else base + "/openapi/router"
        self.session = session or requests.Session()
        self.min_interval_seconds = max(0.15, min(0.25, min_interval_seconds))
        self.timeout_seconds = timeout_seconds
        self._last_request_at = 0.0

    def request(self, api_type: str, params: Mapping[str, Any] | None = None) -> dict[str, Any]:
        elapsed = time.monotonic() - self._last_request_at
        if self._last_request_at and elapsed < self.min_interval_seconds:
            time.sleep(self.min_interval_seconds - elapsed)

        body: dict[str, Any] = {
            **(params or {}),
            "type": api_type,
            "app_key": self.credentials.app_key,
            "access_token": self.credentials.access_token,
            "data_type": "JSON",
            "timestamp": str(int(time.time())),
        }
        body["sign"] = _signature(body, self.credentials.app_secret)
        try:
            response = self.session.post(self.url, json=body, timeout=self.timeout_seconds)
        except requests.RequestException as exc:
            # Do not propagate request objects, URLs, headers, or payloads.
            raise TemuApiError("TRANSPORT", type(exc).__name__) from None
        finally:
            self._last_request_at = time.monotonic()

        try:
            payload = response.json()
        except ValueError:
            raise TemuApiError("INVALID_RESPONSE", f"HTTP {response.status_code}", response.status_code) from None
        code = str(payload.get("errorCode", ""))
        message = str(payload.get("errorMsg", ""))
        if not response.ok or payload.get("success") is False:
            # Never include response/request bodies; API responses can echo credentials.
            for secret in (self.credentials.app_key, self.credentials.app_secret, self.credentials.access_token):
                message = message.replace(secret, "[REDACTED]")
            raise TemuApiError(code or "HTTP_ERROR", message[:500], response.status_code)
        return payload

    def list_goods(self, status_filter: int, *, page_no: int = 1, page_size: int = 100) -> dict[str, Any]:
        return self.request(
            "bg.local.goods.list.query",
            {"goodsStatusFilterType": status_filter, "pageNo": page_no, "pageSize": page_size},
        )

    def goods_detail(self, goods_id: int | str) -> dict[str, Any]:
        return self.request("bg.local.goods.detail.query", {"goodsId": goods_id})
