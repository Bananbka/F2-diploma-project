"""Optional folder icon (lucide kebab-case name) and Unicode/emoji titles."""

from tests.crypto.test_identity_api import _register_user


async def _create(client, **body):
    return await client.post("/chat-folder/", json={"chat_ids": [], **body})


async def test_create_with_icon_and_default_none():
    alice, _ = await _register_user()
    try:
        r = await _create(alice, title="Work", icon="briefcase-business")
        assert r.status_code == 200, r.text
        assert r.json()["data"]["icon"] == "briefcase-business"

        r = await _create(alice, title="Plain")
        assert r.status_code == 200, r.text
        assert r.json()["data"]["icon"] is None
    finally:
        await alice.aclose()


async def test_update_icon_keep_and_clear():
    alice, _ = await _register_user()
    try:
        folder = (await _create(alice, title="F", icon="star")).json()["data"]
        url = f"/chat-folder/{folder['id']}"

        r = await alice.patch(url, json={"icon": "heart"})
        assert r.status_code == 200, r.text
        assert r.json()["data"]["icon"] == "heart"

        r = await alice.patch(url, json={"title": "Renamed"})
        assert r.json()["data"]["icon"] == "heart", "omitted icon must be unchanged"

        r = await alice.patch(url, json={"icon": None})
        assert r.status_code == 200, r.text
        assert r.json()["data"]["icon"] is None

        r = await alice.get(url)
        assert r.json()["data"]["icon"] is None
    finally:
        await alice.aclose()


async def test_invalid_icon_is_422():
    alice, _ = await _register_user()
    try:
        for bad in ["Star", "a_b", "-x", "x-", "a--b", "", "has space", "a" * 33]:
            r = await _create(alice, title="X", icon=bad)
            assert r.status_code == 422, (bad, r.text)

        folder = (await _create(alice, title="X")).json()["data"]
        r = await alice.patch(f"/chat-folder/{folder['id']}", json={"icon": "Bad Icon"})
        assert r.status_code == 422, r.text
    finally:
        await alice.aclose()


async def test_emoji_title_round_trip():
    alice, _ = await _register_user()
    try:
        title = "Робота 💼🔥"
        folder = (await _create(alice, title=title)).json()["data"]
        assert folder["title"] == title

        new_title = "Дім 🏠✨"
        r = await alice.patch(f"/chat-folder/{folder['id']}", json={"title": new_title})
        assert r.status_code == 200, r.text
        assert r.json()["data"]["title"] == new_title

        r = await alice.get(f"/chat-folder/{folder['id']}")
        assert r.json()["data"]["title"] == new_title

        # 64 characters, all astral-plane emoji: counted as characters, not bytes.
        r = await _create(alice, title="🔥" * 64)
        assert r.status_code == 200, r.text
        r = await _create(alice, title="🔥" * 65)
        assert r.status_code == 422, r.text
    finally:
        await alice.aclose()
