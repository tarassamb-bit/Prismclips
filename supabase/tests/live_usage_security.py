#!/usr/bin/env python3
"""Disposable-account checks for the staged usage rollout. Never prints credentials.

Run: python3 supabase/tests/live_usage_security.py expand|gateway|contract
Reads UI/.env.local for the service role key. The gateway phase makes one real AI call.
"""
import datetime
import json
import secrets
import sys
import urllib.error
import urllib.request
import uuid
from pathlib import Path

BASE = "https://isdplhahgggundbohmlr.supabase.co"
PUBLISHABLE = "sb_publishable_ATTcp2-mrca0swMStHHdYQ_Le851b8l"
ROOT = Path(__file__).resolve().parents[2]
settings = {}
for line in (ROOT / "UI/.env.local").read_text().splitlines():
    line = line.strip()
    if line and not line.startswith("#") and "=" in line:
        name, value = line.split("=", 1)
        settings[name.strip()] = value.strip().strip("\"'")
key = settings.get("SUPABASE_SERVICE_ROLE_KEY", "")
if not key:
    raise SystemExit("No Supabase service-role key is available for the disposable test.")
admin = {"apikey": key, "Content-Type": "application/json"}
if key.startswith("eyJ"):
    admin["Authorization"] = "Bearer " + key


def call(path, method="GET", headers=None, body=None):
    request = urllib.request.Request(BASE + path, method=method, headers=headers or {},
                                     data=None if body is None else json.dumps(body).encode())
    try:
        with urllib.request.urlopen(request, timeout=180) as response:
            return response.status, response.read()
    except urllib.error.HTTPError as error:
        return error.code, error.read()


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def reserve(headers, uid, video):
    return call("/rest/v1/rpc/prism_reserve_beta_usage", "POST", headers,
                {"p_user": uid, "p_video": video, "p_minutes": 5})


def main(phase):
    uid = None
    try:
        email = f"prism-security-{uuid.uuid4().hex}@example.invalid"
        password = secrets.token_urlsafe(30)
        status, data = call("/auth/v1/admin/users", "POST", admin,
                            {"email": email, "password": password, "email_confirm": True})
        require(status in (200, 201), f"Could not create disposable test account (HTTP {status}).")
        uid = json.loads(data)["id"]
        status, data = call("/auth/v1/token?grant_type=password", "POST",
                            {"apikey": PUBLISHABLE, "Content-Type": "application/json"},
                            {"email": email, "password": password})
        require(status == 200, f"Disposable account sign-in failed (HTTP {status}).")
        token = json.loads(data)["access_token"]
        user = {"apikey": PUBLISHABLE, "Authorization": "Bearer " + token,
                "Content-Type": "application/json", "Prefer": "return=representation"}
        video = "a" * 64
        if phase in ("expand", "contract"):
            status, data = reserve(user, uid, video)
            require(status in (401, 403, 404), f"User could call service-only reservation (HTTP {status}).")
            status, data = reserve(admin, uid, video)
            if status != 200:
                try:
                    error = json.loads(data)
                    print("Reservation error:", error.get("code"), error.get("message"))
                except (ValueError, AttributeError):
                    print("Reservation returned a non-JSON error.")
            require(status == 200 and json.loads(data) is True,
                    f"Service-only reservation failed (HTTP {status}).")
            print("PASS: reservation is service-only and accepts the disposable account")
        if phase == "gateway":
            headers = {**user, "x-prism-video": video, "x-prism-minutes": "5", "x-prism-day": "2015-01-01"}
            status, data = call("/functions/v1/gemini", "POST", headers,
                                {"contents": [{"role": "user", "parts": [{"text": "Reply with OK."}]}]})
            require(status == 200, f"Live gateway/provider call failed (HTTP {status}); cutover must not proceed.")
            response = json.loads(data)
            require(bool(response.get("candidates")), "Live gateway returned no candidates.")
            status, data = call(f"/rest/v1/usage_videos?video=eq.{video}&select=day,minutes", headers=user)
            rows = json.loads(data) if status == 200 else []
            today = datetime.datetime.now(datetime.timezone.utc).date().isoformat()
            require(len(rows) == 1 and rows[0]["day"] == today and rows[0]["minutes"] == 5,
                    "Live gateway did not record the server UTC day; cutover must not proceed.")
            print("PASS: deployed gateway made a real AI call and recorded the server UTC day")
        if phase == "contract":
            extra = {"video": "b" * 64, "day": "2026-10-27", "minutes": 0.001}
            status, _ = call("/rest/v1/usage_videos", "POST", user, extra)
            require(not (200 <= status < 300), f"User could insert usage (HTTP {status}).")
            status, data = call(f"/rest/v1/usage_videos?video=eq.{video}", "PATCH", user, {"minutes": 1})
            require(not (200 <= status < 300) or json.loads(data or b"[]") == [],
                    f"User could update usage (HTTP {status}).")
            status, data = call(f"/rest/v1/usage_videos?video=eq.{video}", "DELETE", user)
            require(not (200 <= status < 300) or json.loads(data or b"[]") == [],
                    f"User could delete usage (HTTP {status}).")
            status, data = call(f"/rest/v1/usage_videos?video=eq.{video}&select=minutes", headers=user)
            rows = json.loads(data) if status == 200 else []
            require(len(rows) == 1 and rows[0]["minutes"] == 5, "The existing usage row was modified or removed.")
            print("PASS: authenticated user cannot insert, update or delete usage")
    finally:
        if uid:
            status, _ = call(f"/auth/v1/admin/users/{uid}", "DELETE", admin)
            if status not in (200, 204):
                raise RuntimeError(f"Disposable account cleanup failed (HTTP {status}).")
            print("PASS: disposable test account deleted")


if __name__ == "__main__":
    if len(sys.argv) != 2 or sys.argv[1] not in ("expand", "gateway", "contract"):
        raise SystemExit("Choose expand, gateway or contract.")
    main(sys.argv[1])
