"""`/profile/me/appearance/background-image`: upload validation, private serving, tuning, reset."""

import struct
import zlib

import httpx
import pytest

from tests.crypto.test_identity_api import _register_user

URL = "/profile/me/appearance"
IMG = f"{URL}/background-image"
TUNING = {
    "fit": "cover",
    "position_x": 50,
    "position_y": 50,
    "zoom": 100,
    "dim": 0,
    "blur": 0,
}


def _png(width: int = 2, height: int = 2) -> bytes:
    def chunk(tag: bytes, body: bytes) -> bytes:
        return (
            struct.pack(">I", len(body))
            + tag
            + body
            + struct.pack(">I", zlib.crc32(tag + body))
        )

    row = b"\x00" + b"\xff\x00\x00" * width
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(row * height))
        + chunk(b"IEND", b"")
    )


def _jpeg(width: int = 4, height: int = 3, salt: int = 0) -> bytes:
    sof = b"\xff\xc0" + struct.pack(">HBHHB", 11, 8, height, width, 1) + b"\x01\x11\x00"
    return b"\xff\xd8" + b"\xff\xfe" + struct.pack(">H", 3) + bytes([salt]) + sof + b"\xff\xd9"


def _files(data: bytes, name: str = "bg.png", ctype: str = "image/png"):
    return {"file": (name, data, ctype)}


def _image_doc(**over):
    return {
        "background": {
            "kind": "image",
            "color": None,
            "gradient": None,
            "image": {**TUNING, **over},
        }
    }


async def test_upload_get_and_etag():
    alice, _ = await _register_user()
    try:
        png = _png()
        r = await alice.put(IMG, files=_files(png))
        assert r.status_code == 200, r.text
        data = r.json()["data"]
        version = data["background_image_version"]
        assert len(version) == 16
        assert data["background"]["kind"] == "default"  # upload alone does not switch kind

        g = await alice.get(IMG)
        assert g.status_code == 200
        assert g.content == png
        assert g.headers["content-type"] == "image/png"
        assert g.headers["etag"] == f'"{version}"'
        assert g.headers["cache-control"] == "private, max-age=3600"

        cached = await alice.get(IMG, headers={"If-None-Match": f'"{version}"'})
        assert cached.status_code == 304

        # Re-upload overwrites and changes the version.
        j = await alice.put(IMG, files=_files(_jpeg(), "x.jpg", "image/jpeg"))
        assert j.status_code == 200, j.text
        assert j.json()["data"]["background_image_version"] != version
        assert (await alice.get(IMG)).headers["content-type"] == "image/jpeg"
    finally:
        await alice.aclose()


@pytest.mark.parametrize(
    "data,name,ctype",
    [
        (b"just some text", "bg.png", "image/png"),
        (b"<svg xmlns='http://www.w3.org/2000/svg'/>", "bg.svg", "image/svg+xml"),
        (b"GIF89a\x01\x00\x01\x00", "bg.gif", "image/gif"),
        (b"", "bg.png", "image/png"),
    ],
)
async def test_wrong_type_by_magic_bytes_rejected(data, name, ctype):
    alice, _ = await _register_user()
    try:
        r = await alice.put(IMG, files=_files(data, name, ctype))
        assert r.status_code == 415, r.text
        assert (await alice.get(IMG)).status_code == 404
    finally:
        await alice.aclose()


async def test_png_content_type_cannot_launder_html():
    alice, _ = await _register_user()
    try:
        r = await alice.put(IMG, files=_files(b"<html><script>1</script></html>"))
        assert r.status_code == 415, r.text
    finally:
        await alice.aclose()


async def test_oversize_rejected():
    alice, _ = await _register_user()
    try:
        big = _png() + b"\x00" * (5 * 1024 * 1024)
        r = await alice.put(IMG, files=_files(big))
        assert r.status_code == 413, r.text
    finally:
        await alice.aclose()


async def test_absurd_dimensions_rejected():
    alice, _ = await _register_user()
    try:
        assert (await alice.put(IMG, files=_files(_png(8001, 1)))).status_code == 415
        assert (await alice.put(IMG, files=_files(_png(1, 8001)))).status_code == 415
        r = await alice.put(IMG, files=_files(_jpeg(9000, 9000), "x.jpg", "image/jpeg"))
        assert r.status_code == 415
        assert (await alice.get(IMG)).status_code == 404
    finally:
        await alice.aclose()


async def test_other_user_cannot_read_yours():
    alice, _ = await _register_user()
    bob, _ = await _register_user()
    try:
        await alice.put(IMG, files=_files(_png()))
        assert (await bob.get(IMG)).status_code == 404
        await bob.put(IMG, files=_files(_jpeg(), "b.jpg", "image/jpeg"))
        assert (await alice.get(IMG)).headers["content-type"] == "image/png"
        assert (await bob.get(IMG)).headers["content-type"] == "image/jpeg"
    finally:
        await alice.aclose()
        await bob.aclose()


async def test_select_and_tune_image():
    alice, _ = await _register_user()
    try:
        version = (await alice.put(IMG, files=_files(_png()))).json()["data"][
            "background_image_version"
        ]
        r = await alice.put(URL, json=_image_doc(fit="tile", zoom=200, dim=40, blur=5))
        assert r.status_code == 200, r.text
        image = r.json()["data"]["background"]["image"]
        assert image["version"] == version
        assert (image["fit"], image["zoom"], image["dim"], image["blur"]) == ("tile", 200, 40, 5)
    finally:
        await alice.aclose()


async def test_client_cannot_forge_version():
    alice, _ = await _register_user()
    try:
        version = (await alice.put(IMG, files=_files(_png()))).json()["data"][
            "background_image_version"
        ]
        r = await alice.put(URL, json=_image_doc(version="deadbeefdeadbeef"))
        assert r.status_code == 200, r.text
        assert r.json()["data"]["background"]["image"]["version"] == version
        r = await alice.put(
            URL, json={**_image_doc(), "background_image_version": "deadbeefdeadbeef"}
        )
        assert r.json()["data"]["background_image_version"] == version
    finally:
        await alice.aclose()


@pytest.mark.parametrize(
    "bad",
    [
        {"fit": "stretch"},
        {"position_x": -1},
        {"position_y": 101},
        {"zoom": 99},
        {"zoom": 301},
        {"dim": 81},
        {"dim": -1},
        {"blur": 21},
        {"blur": "3"},
        {"version": "NOT-HEX"},
        {"surprise": 1},
    ],
)
async def test_tuning_validation_422(bad):
    alice, _ = await _register_user()
    try:
        await alice.put(IMG, files=_files(_png()))
        r = await alice.put(URL, json=_image_doc(**bad))
        assert r.status_code == 422, r.text
    finally:
        await alice.aclose()


async def test_image_kind_without_upload_is_422():
    alice, _ = await _register_user()
    try:
        r = await alice.put(URL, json=_image_doc())
        assert r.status_code == 422, r.text
        assert (await alice.get(URL)).json()["data"]["background"]["kind"] == "default"
    finally:
        await alice.aclose()


async def test_image_present_with_other_kind_or_missing_for_image_is_422():
    alice, _ = await _register_user()
    try:
        await alice.put(IMG, files=_files(_png()))
        other = {"background": {"kind": "color", "color": "#ffffff", "image": TUNING}}
        assert (await alice.put(URL, json=other)).status_code == 422
        missing = {"background": {"kind": "image"}}
        assert (await alice.put(URL, json=missing)).status_code == 422
    finally:
        await alice.aclose()


async def test_delete_resets_background_and_object():
    alice, _ = await _register_user()
    try:
        await alice.put(IMG, files=_files(_png()))
        await alice.put(URL, json=_image_doc())
        r = await alice.delete(IMG)
        assert r.status_code == 200, r.text
        data = r.json()["data"]
        assert data["background"] == {
            "kind": "default",
            "color": None,
            "gradient": None,
            "image": None,
        }
        assert data["background_image_version"] is None
        assert (await alice.get(IMG)).status_code == 404
    finally:
        await alice.aclose()


async def test_delete_keeps_other_background_kind():
    alice, _ = await _register_user()
    try:
        await alice.put(IMG, files=_files(_png()))
        await alice.put(URL, json={"background": {"kind": "color", "color": "#123456"}})
        data = (await alice.delete(IMG)).json()["data"]
        assert data["background"]["kind"] == "color"
        assert data["background_image_version"] is None
    finally:
        await alice.aclose()


async def test_full_reset_removes_image():
    alice, _ = await _register_user()
    try:
        await alice.put(IMG, files=_files(_png()))
        await alice.delete(URL)
        assert (await alice.get(IMG)).status_code == 404
    finally:
        await alice.aclose()


async def test_requires_authentication():
    async with httpx.AsyncClient(base_url="http://localhost:8000") as anon:
        assert (await anon.get(IMG)).status_code == 401
        assert (await anon.put(IMG, files=_files(_png()))).status_code == 401
        assert (await anon.delete(IMG)).status_code == 401
