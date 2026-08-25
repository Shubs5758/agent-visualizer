"""Command line entry point: ``agent-visualizer <command>``."""

from __future__ import annotations

import argparse
import logging
import sys
import threading
import webbrowser
from typing import List, Optional

from . import __version__
from .client import DEFAULT_SERVER_URL


def _cmd_serve(args: argparse.Namespace) -> int:
    try:
        from .bridge import DEFAULT_PORT, dashboard_available, serve
    except ImportError as exc:
        print(f"\n  {exc}\n", file=sys.stderr)
        return 1

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(message)s",
    )

    if args.open and dashboard_available() and not args.no_dashboard:
        url = f"http://localhost:{args.port}/"
        # Fire after the loop is up; a failure to open a browser is never fatal.
        threading.Timer(1.0, lambda: webbrowser.open(url)).start()

    try:
        serve(
            port=args.port,
            host=args.host,
            buffer_size=args.buffer,
            cors_origin=args.cors_origin,
            serve_dashboard=not args.no_dashboard,
        )
    except OSError as exc:
        if getattr(exc, "errno", None) in (48, 98, 10048):  # EADDRINUSE
            print(
                f"\n  Port {args.port} is already in use.\n"
                f"  Another bridge is probably still running.\n\n"
                f"  Stop it, or pick another port:\n"
                f"      agent-visualizer serve --port {args.port + 1}\n",
                file=sys.stderr,
            )
            return 1
        raise
    except KeyboardInterrupt:
        print("\n  stopped")
    return 0


def _cmd_demo(args: argparse.Namespace) -> int:
    from .demo import run

    try:
        run(args.url, pace=args.pace)
    except KeyboardInterrupt:
        print("\n  interrupted")
    return 0


def _cmd_info(args: argparse.Namespace) -> int:
    from .bridge import WEB_ROOT, dashboard_available

    try:
        import aiohttp  # noqa: F401

        server_extra = "installed"
    except ImportError:
        server_extra = 'missing  (pip install "agent-visualizer[server]")'
    try:
        import websocket  # noqa: F401

        ws_extra = "installed"
    except ImportError:
        ws_extra = 'missing  (pip install "agent-visualizer[ws]") — HTTP fallback in use'

    print(f"agent-visualizer      {__version__}")
    print(f"python                {sys.version.split()[0]}")
    print(f"server extra          {server_extra}")
    print(f"websocket extra       {ws_extra}")
    print(f"bundled dashboard     {'yes' if dashboard_available() else 'no'}  ({WEB_ROOT})")
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="agent-visualizer",
        description="Watch your multi-agent AI workflow as a 2D retro game.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=(
            "examples:\n"
            "  agent-visualizer serve              start bridge + dashboard on :8765\n"
            "  agent-visualizer serve --port 9000  use a different port\n"
            "  agent-visualizer demo               play a scripted 3-agent run\n"
            "  agent-visualizer info               show install / extras status\n"
        ),
    )
    parser.add_argument("-V", "--version", action="version", version=f"%(prog)s {__version__}")
    sub = parser.add_subparsers(dest="command")

    serve_p = sub.add_parser("serve", help="run the bridge and serve the dashboard")
    serve_p.add_argument("-p", "--port", type=int, default=8765, help="listen port (default 8765)")
    serve_p.add_argument("--host", default="0.0.0.0", help="bind address (default 0.0.0.0)")
    serve_p.add_argument(
        "--buffer", type=int, default=500, help="replay buffer size (default 500)"
    )
    serve_p.add_argument("--cors-origin", default="*", help="Access-Control-Allow-Origin value")
    serve_p.add_argument(
        "--no-dashboard", action="store_true", help="serve only the API, not the bundled UI"
    )
    serve_p.add_argument(
        "--no-open", dest="open", action="store_false", help="do not open a browser on start"
    )
    serve_p.add_argument("-v", "--verbose", action="store_true", help="debug logging")
    serve_p.set_defaults(func=_cmd_serve, open=True)

    demo_p = sub.add_parser("demo", help="play a scripted multi-agent scenario")
    demo_p.add_argument("--url", default=DEFAULT_SERVER_URL, help="bridge URL")
    demo_p.add_argument(
        "--pace", type=float, default=1.0, help="speed multiplier for pauses (default 1.0)"
    )
    demo_p.set_defaults(func=_cmd_demo)

    info_p = sub.add_parser("info", help="show version, extras and dashboard status")
    info_p.set_defaults(func=_cmd_info)

    return parser


def main(argv: Optional[List[str]] = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    if not getattr(args, "command", None):
        parser.print_help()
        return 0
    return args.func(args)


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
