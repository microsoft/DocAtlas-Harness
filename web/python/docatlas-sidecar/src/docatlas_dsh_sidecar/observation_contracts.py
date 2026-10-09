"""Observation contract semantics only. Python never owns browser sessions or event streams."""

from typing import Any, cast

from .product_control import ProductControlValue, product_control_issues


def conversation_observation_issues(value: dict[str, Any]) -> list[str]:
    issues: list[str] = []
    if value["kind"] == "conversation-observation":
        if value["update"]["type"] == "receipt":
            receipt = value["update"]["receipt"]
            if (
                receipt["conversationId"] != value["conversationId"]
                or receipt["generation"] != value["generation"]
            ):
                issues.append("receipt-scope")
            issues.extend(product_control_issues(cast(ProductControlValue, receipt)))
        return issues
    binding, runs, history = value["binding"], value["runs"], value["history"]
    issues.extend(product_control_issues(cast(ProductControlValue, binding)))
    if any(
        run["receipt"]["conversationId"] != binding["conversationId"]
        or run["receipt"]["generation"] > binding["generation"]
        for run in runs
    ):
        issues.append("receipt-scope")
    if len({run["receipt"]["submissionId"] for run in runs}) != len(runs):
        issues.append("duplicate-run")
    for run in runs:
        issues.extend(product_control_issues(cast(ProductControlValue, run["receipt"])))
    if history["checkpoint"]:
        if history["checkpoint"]["runtimeSessionId"] != binding["runtimeSessionId"]:
            issues.append("history-scope")
        issues.extend(product_control_issues(cast(ProductControlValue, history["checkpoint"])))
    elif history["messages"]:
        issues.append("unverified-history")
    if len({message["entryId"] for message in history["messages"]}) != len(history["messages"]):
        issues.append("duplicate-entry")
    if len({message["messageId"] for message in value["live"]}) != len(value["live"]):
        issues.append("duplicate-live")
    if len({(item["submissionId"], item["toolCallId"]) for item in value["activity"]}) != len(
        value["activity"]
    ):
        issues.append("duplicate-activity")
    return issues
