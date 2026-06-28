"""Entry point for ``python -m lythea``."""
from __future__ import annotations

from lythea.env import bootstrap_env  # noqa: F401 — must run first

import argparse

from lythea.config import DEFAULT_HOST, DEFAULT_PORT
from lythea.logging_setup import configure_logging


def main() -> None:
    parser = argparse.ArgumentParser(description="Lythéa V3 — Taëlys")
    parser.add_argument("--host", default=DEFAULT_HOST)
    parser.add_argument("--port", type=int, default=DEFAULT_PORT)
    parser.add_argument("--log-level", default="INFO")
    args = parser.parse_args()

    configure_logging(args.log_level)

    import uvicorn
    from lythea.server.app import create_app

    app = create_app()
    uvicorn.run(app, host=args.host, port=args.port, log_level="info")


if __name__ == "__main__":
    main()
