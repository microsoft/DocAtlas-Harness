"""PostNoteHooks: archive + tree annotate after Note calls."""
from harness.agent.post_note import PostNoteHooks, ArchiveResult


def test_default_archive_set_is_read_only():
    h = PostNoteHooks()
    assert h.skills_to_archive == {"Read"}


def test_tree_annotate_enabled_by_default():
    h = PostNoteHooks()
    assert h.tree_annotate_enabled is True


def test_archive_enabled_by_default():
    h = PostNoteHooks()
    assert h.archive_enabled is True


def test_no_trigger_without_note():
    h = PostNoteHooks()
    result = h.maybe_process([], [("Read", {})], None)
    assert result is None


def test_both_disabled_returns_none_on_note():
    h = PostNoteHooks(archive_enabled=False, tree_annotate_enabled=False)
    result = h.maybe_process([], [("Note", {})], None)
    assert result is None
