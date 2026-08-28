"""DocAtlas harness package."""

from importlib.metadata import PackageNotFoundError, version

try:
    __version__ = version("docatlas")
except PackageNotFoundError:  # source tree without an installed distribution
    __version__ = "0.3.0"

__all__ = ["__version__"]
