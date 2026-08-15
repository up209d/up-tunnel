"""Command line entry point: `python -m uptunnel ...`."""

import argparse
import asyncio
import json
import logging
import os
import socket
import sys

from .client import Agent, AgentConfig, AuthError, TunnelSpec, VERSION
from .healthlog import configure_from_env as configure_health_log

DEFAULT_CONFIG_NAMES = ("up.yaml", "up.yml", "up.json")


def _parse_target(value: str, default_host: str = "127.0.0.1"):
    """Accepts `3000`, `localhost:3000`, or `[::1]:3000`."""
    text = str(value).strip()
    if text.isdigit():
        return default_host, int(text)
    if text.startswith("["):
        close = text.index("]")
        return text[1:close], int(text[close + 2 :])
    if ":" not in text:
        raise ValueError("target %r must include a port" % text)
    host, _, port = text.rpartition(":")
    return host or default_host, int(port)


def _load_config_file(path: str) -> dict:
    with open(path, "r", encoding="utf-8") as fh:
        text = fh.read()
    if path.endswith((".yaml", ".yml")):
        try:
            import yaml  # optional; JSON configs need no dependency at all
        except ImportError:
            raise SystemExit(
                "%s is YAML but PyYAML is not installed. "
                "Run `pip install pyyaml`, or use a .json config." % path
            )
        data = yaml.safe_load(text) or {}
    else:
        data = json.loads(text)
    if not isinstance(data, dict):
        raise SystemExit("%s must contain a mapping at the top level" % path)
    return data


def _find_default_config():
    for name in DEFAULT_CONFIG_NAMES:
        if os.path.isfile(name):
            return name
    return None


def _specs_from_config(raw: dict) -> list:
    specs = []
    for i, entry in enumerate(raw.get("tunnels") or []):
        if not isinstance(entry, dict):
            raise SystemExit("tunnels[%d] must be a mapping" % i)
        kind = entry.get("kind", "http")
        if kind not in ("http", "tcp"):
            raise SystemExit("tunnels[%d].kind must be http or tcp" % i)
        if "target" not in entry:
            raise SystemExit("tunnels[%d] needs a target" % i)
        host, port = _parse_target(entry["target"])
        name = str(entry.get("name") or entry.get("subdomain") or ("%s-%d" % (kind, i)))
        spec = TunnelSpec(
            name=name,
            kind=kind,
            target_host=host,
            target_port=port,
            subdomain=str(entry.get("subdomain", "")),
            remote_port=int(entry.get("remote_port", 0) or 0),
            rewrite_host=bool(entry.get("rewrite_host", False)),
        )
        if kind == "http" and not spec.subdomain:
            raise SystemExit("tunnels[%d] (%s) needs a subdomain" % (i, name))
        specs.append(spec)
    return specs


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="uptunnel",
        description="Expose a local HTTP or TCP service through your own tunnel server.",
    )
    parser.add_argument("--version", action="version", version=VERSION)
    parser.add_argument("-c", "--config", help="path to up.yaml / up.json")
    parser.add_argument("--server", help="control URL, e.g. wss://tunnel.example.com/control")
    parser.add_argument("--token", help="shared secret (or set UPTUNNEL_TOKEN)")
    parser.add_argument("--name", help="label for this device in server logs")
    parser.add_argument(
        "--insecure", action="store_true", help="skip TLS verification (self-signed certs)"
    )
    parser.add_argument(
        "-v",
        "--verbose",
        action="count",
        default=0,
        help="debug logging; repeat (-vv) to include raw WebSocket frames",
    )

    sub = parser.add_subparsers(dest="command")

    http = sub.add_parser("http", help="expose a local HTTP service on a subdomain")
    http.add_argument("target", help="local port or host:port")
    http.add_argument("--subdomain", required=True)
    http.add_argument(
        "--rewrite-host",
        action="store_true",
        help="rewrite the Host header to the local target (needed by Vite, webpack, …)",
    )

    tcp = sub.add_parser("tcp", help="expose a local TCP service on a public port")
    tcp.add_argument("target", help="local port or host:port")
    tcp.add_argument("--remote-port", type=int, default=0, help="preferred public port")

    return parser


def resolve(args) -> AgentConfig:
    raw = {}
    path = args.config or _find_default_config()
    if args.config and not os.path.isfile(args.config):
        raise SystemExit("no such config file: %s" % args.config)
    if path:
        raw = _load_config_file(path)
        logging.getLogger("uptunnel").debug("loaded config from %s", path)

    server = args.server or os.environ.get("UPTUNNEL_SERVER") or raw.get("server")
    token = args.token or os.environ.get("UPTUNNEL_TOKEN") or raw.get("token")
    # gethostname rather than os.uname, so this works on Windows too.
    name = args.name or os.environ.get("UPTUNNEL_NAME") or raw.get("name") or socket.gethostname()

    if not server:
        raise SystemExit("no server URL — pass --server, set UPTUNNEL_SERVER, or add it to the config")
    if not token:
        raise SystemExit("no token — pass --token, set UPTUNNEL_TOKEN, or add it to the config")

    if args.command == "http":
        host, port = _parse_target(args.target)
        specs = [
            TunnelSpec(
                name=args.subdomain,
                kind="http",
                target_host=host,
                target_port=port,
                subdomain=args.subdomain,
                rewrite_host=args.rewrite_host,
            )
        ]
    elif args.command == "tcp":
        host, port = _parse_target(args.target)
        specs = [
            TunnelSpec(
                name="tcp-%d" % port,
                kind="tcp",
                target_host=host,
                target_port=port,
                remote_port=args.remote_port,
            )
        ]
    else:
        specs = _specs_from_config(raw)
        if not specs:
            raise SystemExit(
                "nothing to expose — declare tunnels in the config, or use "
                "`uptunnel http <port> --subdomain <name>`"
            )

    return AgentConfig(
        server=server,
        token=token,
        name=name,
        tunnels=specs,
        insecure=bool(args.insecure or raw.get("insecure")),
    )


def main(argv=None) -> int:
    args = build_parser().parse_args(argv)
    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)-5s %(message)s",
        datefmt="%H:%M:%S",
    )
    # The websockets library logs every frame at DEBUG, which drowns out our own output.
    if args.verbose < 2:
        logging.getLogger("websockets").setLevel(logging.INFO)

    # No-op unless UPTUNNEL_HEALTH_LOG is set.
    configure_health_log()

    cfg = resolve(args)
    try:
        asyncio.run(Agent(cfg).run_forever())
    except KeyboardInterrupt:
        print()
        return 0
    except AuthError as exc:
        logging.getLogger("uptunnel").error("authentication failed — %s", exc)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
