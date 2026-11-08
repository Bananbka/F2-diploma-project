"""`/profile/me/appearance`: defaults, full-document replace, validation, reset, isolation."""

import httpx
import pytest

from tests.crypto.test_identity_api import _register_user

URL = "/profile/me/appearance"
DEFAULTS = {
    "font_size": 15,
    "font_family": "inter",
    "bubble_radius": 19,
    "own_bubble_color": None,
    "other_bubble_color": None,
    "background": {"kind": "default", "color": None, "gradient": None, "image": None},
    "background_image_version": None,
    "version": 1,
}


def _doc(**over):
    return {**DEFAULTS, **over}


async def test_get_returns_defaults_when_nothing_saved():
    alice, _ = await _register_user()
    try:
        r = await alice.get(URL)
        assert r.status_code == 200, r.text
        assert r.json()["data"] == DEFAULTS
    finally:
        await alice.aclose()


async def test_put_round_trip():
    alice, _ = await _register_user()
    try:
        doc = _doc(
            font_size=18,
            font_family="serif",
            own_bubble_color="#AABBCC",
            background={"kind": "gradient", "color": None, "gradient": "ocean", "image": None},
        )
        r = await alice.put(URL, json=doc)
        assert r.status_code == 200, r.text
        assert r.json()["data"] == doc
        assert (await alice.get(URL)).json()["data"] == doc
    finally:
        await alice.aclose()


async def test_put_replaces_whole_document():
    alice, _ = await _register_user()
    try:
        await alice.put(URL, json=_doc(font_size=20, own_bubble_color="#112233"))
        r = await alice.put(URL, json={"font_size": 13})
        assert r.status_code == 200, r.text
        assert (await alice.get(URL)).json()["data"] == _doc(font_size=13)
    finally:
        await alice.aclose()


@pytest.mark.parametrize(
    "bad",
    [
        {"own_bubble_color": "red"},
        {"other_bubble_color": "#12345"},
        {"font_size": 11},
        {"font_size": 23},
        {"font_size": "15"},
        {"font_family": "comic"},
        {"bubble_radius": -1},
        {"bubble_radius": 29},
        {"bubble_radius": "12"},
        {"background": {"kind": "color"}},
        {"background": {"kind": "gradient"}},
        {"background": {"kind": "default", "color": "#ffffff"}},
        {"background": {"kind": "color", "color": "#ffffff", "gradient": "dusk"}},
        {"background": {"kind": "gradient", "gradient": "neon"}},
        {"version": 2},
        {"surprise": 1},
    ],
)
async def test_invalid_documents_are_422(bad):
    alice, _ = await _register_user()
    try:
        r = await alice.put(URL, json=_doc(**bad))
        assert r.status_code == 422, r.text
        assert (await alice.get(URL)).json()["data"] == DEFAULTS
    finally:
        await alice.aclose()


async def test_delete_resets_to_defaults():
    alice, _ = await _register_user()
    try:
        await alice.put(URL, json=_doc(font_size=21))
        r = await alice.delete(URL)
        assert r.status_code == 200, r.text
        assert r.json()["data"] == DEFAULTS
        assert (await alice.get(URL)).json()["data"] == DEFAULTS
    finally:
        await alice.aclose()


async def test_appearance_is_per_user():
    alice, _ = await _register_user()
    bob, _ = await _register_user()
    try:
        await alice.put(URL, json=_doc(font_size=22, font_family="mono"))
        assert (await bob.get(URL)).json()["data"] == DEFAULTS
        assert (await alice.get(URL)).json()["data"]["font_size"] == 22
    finally:
        await alice.aclose()
        await bob.aclose()


async def test_requires_authentication():
    async with httpx.AsyncClient(base_url="http://localhost:8000") as anon:
        assert (await anon.get(URL)).status_code == 401


@pytest.mark.parametrize("radius", [0, 19, 28])
async def test_bubble_radius_bounds_round_trip(radius):
    alice, _ = await _register_user()
    try:
        r = await alice.put(URL, json=_doc(bubble_radius=radius))
        assert r.status_code == 200, r.text
        assert r.json()["data"]["bubble_radius"] == radius
        assert (await alice.get(URL)).json()["data"]["bubble_radius"] == radius
    finally:
        await alice.aclose()
