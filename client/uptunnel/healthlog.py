"""Bounded health log for the agent side of the connection.

The console log tells you what is happening while you are watching. This tells
you what happened at 3am: connect, handshake, and how each session ended. When a
tunnelled device goes unreachable the question is always which end gave up
first, and answering it needs both ends writing to a file rather than to a
terminal nobody was at — so this is on by default.

Written to UPTUNNEL_HEALTH_LOG, defaulting to ./health.log in the working
directory; set the variable to an empty string to turn it off. Capped at
UPTUNNEL_HEALTH_LOG_MAX_LINES (default 1000), trimmed to the newest 80% — the
same shape as the Node agent's healthlog.ts and the server's health log, so one
description in the docs covers all three.

Unlike the Node agent this records no per-ping line: the keepalive lives inside
the websockets library, which never hands the pings back to us.
"""

import logging
import os
import time

DEFAULT_MAX_LINES = 1000
_KEEP_RATIO = 0.8

log = logging.getLogger("uptunnel")

_file = None
_max_lines = DEFAULT_MAX_LINES
_lines = 0
# Set after a write failure, so a bad path is reported once rather than per line.
_broken = False


def _count_lines(path):
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            return sum(1 for _ in f)
    except OSError:
        return 0        # no file yet, which counts as empty


# Relative to the working directory, the same shape as the server's
# HEALTH_LOG_FILE: the log lands next to wherever the agent was started, which is
# where anyone debugging it will look first. Set UPTUNNEL_HEALTH_LOG to an
# absolute path for a service that runs from a directory you'd rather not write
# to.
DEFAULT_PATH = "health.log"


def configure_from_env():
    """Read the env and open the log. Safe to call when neither var is set."""
    global _file, _max_lines, _lines, _broken
    # Unset means "use the default"; set-but-empty is the explicit opt out, the
    # same convention the server's HEALTH_LOG_FILE uses.
    path = os.environ.get("UPTUNNEL_HEALTH_LOG")
    if path is None:
        path = DEFAULT_PATH
    # Nothing expands a ~ out of an env file, and a path set there is exactly
    # where someone reaches for one, so expand it rather than creating a
    # directory literally named ~.
    path = os.path.expanduser(path) if path else None
    _broken = False
    try:
        _max_lines = int(os.environ.get("UPTUNNEL_HEALTH_LOG_MAX_LINES", DEFAULT_MAX_LINES))
    except ValueError:
        _max_lines = DEFAULT_MAX_LINES
    if _max_lines <= 10:
        _max_lines = DEFAULT_MAX_LINES
    _file = path
    if not _file:
        return
    try:
        parent = os.path.dirname(_file)
        if parent:
            os.makedirs(parent, exist_ok=True)
        _lines = _count_lines(_file)
    except OSError as exc:
        _broken = True
        log.warning("health log unavailable (%s)", exc)


def _trim():
    global _lines
    keep = int(_max_lines * _KEEP_RATIO)
    tmp = _file + ".tmp"
    try:
        with open(_file, "r", encoding="utf-8", errors="replace") as src:
            kept = src.readlines()[-keep:]
        # Write-then-rename, so an interrupted trim leaves the previous good log
        # rather than a half-written one.
        with open(tmp, "w", encoding="utf-8") as dst:
            dst.writelines(kept)
        os.replace(tmp, _file)
        _lines = len(kept)
    except OSError as exc:
        log.warning("health log trim failed (%s)", exc)
        _lines = _count_lines(_file)


def health(msg, **fields):
    """Record one health event. Never raises — diagnostics must not kill the agent."""
    global _lines, _broken
    if not _file or _broken:
        return
    tail = "".join(
        " %s=%s" % (k, v) for k, v in sorted(fields.items()) if v is not None
    )
    stamp = time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime()) + "Z"
    try:
        with open(_file, "a", encoding="utf-8") as f:
            f.write("%s %s%s\n" % (stamp, msg, tail))
    except OSError as exc:
        _broken = True
        log.warning("health log write failed, disabling (%s)", exc)
        return
    _lines += 1
    if _lines >= _max_lines:
        _trim()
