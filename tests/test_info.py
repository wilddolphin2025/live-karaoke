"""GET /v1/info and the x-served-by header, against a live server.

Default http://localhost:30800 (override ASR_URL). Skipped if unreachable.
"""
import os

import httpx
import pytest

URL = os.environ.get("ASR_URL", "http://localhost:30800")


@pytest.fixture(scope="module")
def server():
    try:
        httpx.get(f"{URL}/healthz", timeout=3).raise_for_status()
    except httpx.HTTPError:
        pytest.skip(f"ASR server not reachable at {URL}")
    return URL


def test_info(server):
    r = httpx.get(f"{server}/v1/info", timeout=10)
    if r.status_code == 404:
        pytest.skip("server predates /v1/info (redeploy with deploy/deploy.sh)")
    r.raise_for_status()
    body = r.json()
    for key in ("service_version", "model", "nemo_version", "torch_version", "pod", "gpu"):
        assert key in body, key
    assert body["model"]
    assert body["pod"] and body["pod"] != "unknown"
    assert r.headers.get("x-served-by") == body["pod"]
