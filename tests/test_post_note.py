"""PostNoteHooks: archive + tree annotate after Note calls."""

from types import SimpleNamespace

from docatlas.agent.post_note import PostNoteHooks
from docatlas.session.notes import NoteStore


def test_default_archive_set_is_read_only():
    h = PostNoteHooks()
    assert h.skills_to_archive == {"read"}


def test_tree_annotate_enabled_by_default():
    h = PostNoteHooks()
    assert h.tree_annotate_enabled is True


def test_archive_enabled_by_default():
    h = PostNoteHooks()
    assert h.archive_enabled is True


def test_no_trigger_without_note():
    h = PostNoteHooks()
    result = h.maybe_process([], [("read", {})], None)
    assert result is None


def test_both_disabled_returns_none_on_note():
    h = PostNoteHooks(archive_enabled=False, tree_annotate_enabled=False)
    result = h.maybe_process([], [("note", {})], None)
    assert result is None


def test_note_cannot_enable_operator_disabled_side_effects():
    notes = NoteStore(question="test")
    entry = notes.add_analysis(found="checkpoint")
    entry.data["side_effect_policy"] = "save_archive_and_enrich"
    session = SimpleNamespace(notes=notes, tree=[])
    hooks = PostNoteHooks(archive_enabled=False, tree_annotate_enabled=False)

    result = hooks.maybe_process([], [("note", {})], session)

    assert result is None
