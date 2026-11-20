import sqlite3
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import patch

import pytest

from assistant.engine import Engine
from assistant.linking import Linking, code_digest


class Provider:
    def complete(self, messages):
        return str(messages)


ALICE = "web:a"
BOB = "web:b"
QQ = "qq:123:users:one:one"
GROUP = "qq:123:groups:group:one"


@pytest.fixture
def app(tmp_path):
    engine = Engine(tmp_path / "db.sqlite", Provider(), lambda _: [])
    return engine, Linking(engine)


def test_pair_private_workspace_and_unlink(app):
    engine, links = app
    engine.add_memory(ALICE, "红苹果")
    engine.add_document(ALICE, "手记.md", "小镇的旧桥叫橄榄桥。")
    old_route = links.route(QQ)
    assert links.linked_owner(QQ) is None
    pairing = links.issue(ALICE)
    assert len(pairing["code"]) == 26
    with sqlite3.connect(engine.path) as db:
        assert db.execute("SELECT digest FROM pairing_codes").fetchone()[0] == code_digest(pairing["code"])
    with pytest.raises(ValueError):
        links.bind(GROUP, pairing["code"])
    links.bind_digest(QQ, code_digest(pairing["code"].lower()))
    assert links.status(ALICE) == {"linked": True}
    assert links.linked_owner(QQ) == ALICE
    with pytest.raises(ValueError):
        links.issue(ALICE)
    route = links.route(QQ)
    assert route[0] == ALICE and route[1] != old_route[1]
    assert links.still_linked(QQ, route[1])
    assert links.route(QQ) == route
    answer = engine.reply(*route, "小镇的旧桥叫什么")
    assert "红苹果" in answer["content"] and "橄榄桥" in answer["content"]
    group_route = links.route(GROUP)
    assert group_route[0] == GROUP
    assert not links.still_linked(GROUP, route[1])
    assert "红苹果" not in engine.reply(*group_route, "小镇的旧桥叫什么")["content"]
    links.unlink(ALICE)
    assert not links.still_linked(QQ, route[1])
    assert links.route(QQ) == old_route
    assert links.status(ALICE) == {"linked": False}
    assert engine.messages(*route)[-1] == answer


def test_old_codes_expiry_conflicting_pairs_and_rotation(app):
    engine, links = app
    stale = links.issue(ALICE)["code"]
    good = links.issue(ALICE)["code"]
    with pytest.raises(ValueError):
        links.bind(QQ, stale)
    with patch("assistant.linking.time.time", return_value=10**10), pytest.raises(ValueError):
        links.bind(QQ, good)
    links.bind(QQ, good)
    with pytest.raises(ValueError):
        links.bind("qq:123:users:two:two", good)
    for owner in (GROUP, "qq:123:users:one:other", "web:a"):
        with pytest.raises(ValueError):
            links.unbind_qq(owner)
    bob_code = links.issue(BOB)["code"]
    with pytest.raises(ValueError):
        links.bind(QQ, bob_code)
    owner, cid = links.route(QQ)
    engine.delete_conversation(owner, cid)
    assert not links.still_linked(QQ, cid)
    assert links.route(QQ)[1] != cid
    links.unbind_qq(QQ)
    links.unlink(BOB)
    with pytest.raises(ValueError):
        links.bind(QQ, bob_code)
    links.bind(QQ, links.issue(BOB)["code"])
    assert links.route(QQ)[0] == BOB


def test_code_consumption_is_atomic_across_workers(app):
    _, links = app
    candidate = links.issue(ALICE)["code"]

    def bind(sender):
        owner = f"qq:123:users:{sender}:{sender}"
        try:
            links.bind(owner, candidate)
            return True
        except ValueError:
            return False

    with ThreadPoolExecutor(max_workers=5) as workers:
        successes = list(workers.map(bind, range(8)))
    assert sum(successes) == 1
