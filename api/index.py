"""Vercel entrypoint for the Rami 104 Flask application."""
import os
import sys

# Make the project root importable when Vercel loads this function from /api.
PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if PROJECT_ROOT not in sys.path:
    sys.path.insert(0, PROJECT_ROOT)

from app import app  # noqa: E402

__all__ = ["app"]
