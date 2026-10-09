"""DocAtlas DSH document sidecar."""

from .protocol import (
    DOCUMENT_RPC_VERSION,
    PROTOCOL_VERSION,
    SERVICE_NAME,
    capabilities_result,
    handle_request,
)

__all__ = [
    "DOCUMENT_RPC_VERSION",
    "PROTOCOL_VERSION",
    "SERVICE_NAME",
    "capabilities_result",
    "handle_request",
]
