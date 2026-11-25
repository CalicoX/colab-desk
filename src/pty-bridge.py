#!/usr/bin/env python3
"""Minimal POSIX PTY bridge for Colab Desk interactive terminals.

Protocol (newline-delimited JSON on stdin/stdout):
  stdin:  {"t": "i", "d": "<base64 bytes>"}  -> write to PTY master
          {"t": "r", "c": 120, "r": 34}      -> resize PTY (TIOCSWINSZ + SIGWINCH)
  stdout: {"t": "o", "d": "<base64 bytes>"}  -> output from PTY master
          {"t": "x", "code": 0}              -> child exited
"""
import base64
import errno
import fcntl
import json
import os
import pty
import select
import signal
import struct
import sys
import termios


def set_winsize(fd: int, rows: int, cols: int) -> None:
    rows = max(4, min(500, int(rows)))
    cols = max(10, min(500, int(cols)))
    winsize = struct.pack("HHHH", rows, cols, 0, 0)
    fcntl.ioctl(fd, termios.TIOCSWINSZ, winsize)


def emit(obj: dict) -> None:
    try:
        sys.stdout.write(json.dumps(obj, separators=(",", ":")) + "\n")
        sys.stdout.flush()
    except BrokenPipeError:
        pass


def main() -> int:
    if len(sys.argv) < 2:
        sys.stderr.write("usage: pty-bridge.py <cmd> [args...]\n")
        return 2

    cmd = sys.argv[1:]
    init_cols = int(os.environ.get("COLAB_DESK_COLS", "100"))
    init_rows = int(os.environ.get("COLAB_DESK_ROWS", "30"))

    pid, master_fd = pty.fork()
    if pid == 0:
        os.environ["TERM"] = "xterm-256color"
        os.environ["COLORTERM"] = "truecolor"
        os.environ.setdefault("LANG", "en_US.UTF-8")
        try:
            os.execvp(cmd[0], cmd)
        except Exception as exc:
            sys.stderr.write(f"exec failed: {exc}\n")
            os._exit(127)

    try:
        set_winsize(master_fd, init_rows, init_cols)
    except OSError:
        pass

    stdin_fd = sys.stdin.fileno()
    os.set_blocking(master_fd, False)
    os.set_blocking(stdin_fd, False)

    stdin_buf = b""
    stdin_open = True
    exit_code = None

    def cleanup(*_args):
        try:
            os.killpg(pid, signal.SIGTERM)
        except OSError:
            try:
                os.kill(pid, signal.SIGTERM)
            except OSError:
                pass

    signal.signal(signal.SIGTERM, cleanup)
    signal.signal(signal.SIGINT, cleanup)

    while True:
        watch = [master_fd]
        if stdin_open:
            watch.append(stdin_fd)
        try:
            readable, _, _ = select.select(watch, [], [], 0.15)
        except (select.error, InterruptedError):
            readable = []

        if master_fd in readable:
            try:
                chunk = os.read(master_fd, 16384)
            except OSError as err:
                if err.errno in (errno.EIO, errno.EBADF):
                    chunk = b""
                elif err.errno in (errno.EAGAIN, errno.EWOULDBLOCK):
                    chunk = None
                else:
                    chunk = b""
            if chunk:
                emit({"t": "o", "d": base64.b64encode(chunk).decode("ascii")})
            elif chunk == b"":
                break

        if stdin_open and stdin_fd in readable:
            try:
                data = os.read(stdin_fd, 16384)
            except OSError:
                data = b""
            if not data:
                stdin_open = False
                cleanup()
                break
            stdin_buf += data
            while b"\n" in stdin_buf:
                line, stdin_buf = stdin_buf.split(b"\n", 1)
                if not line.strip():
                    continue
                try:
                    msg = json.loads(line.decode("utf-8"))
                except Exception:
                    continue
                kind = msg.get("t")
                if kind == "i" and isinstance(msg.get("d"), str):
                    try:
                        raw = base64.b64decode(msg["d"])
                        if raw:
                            os.write(master_fd, raw)
                    except OSError:
                        pass
                elif kind == "r":
                    try:
                        set_winsize(master_fd, msg.get("r", 30), msg.get("c", 100))
                        os.killpg(pid, signal.SIGWINCH)
                    except OSError:
                        pass

        try:
            done_pid, status = os.waitpid(pid, os.WNOHANG)
            if done_pid == pid:
                if os.WIFEXITED(status):
                    exit_code = os.WEXITSTATUS(status)
                elif os.WIFSIGNALED(status):
                    exit_code = 128 + os.WTERMSIG(status)
                else:
                    exit_code = 0
                # Drain any remaining buffered output from PTY master
                while True:
                    try:
                        tail = os.read(master_fd, 16384)
                        if not tail:
                            break
                        emit({"t": "o", "d": base64.b64encode(tail).decode("ascii")})
                    except OSError:
                        break
                break
        except ChildProcessError:
            exit_code = 0
            break

    if exit_code is None:
        try:
            _, status = os.waitpid(pid, 0)
            exit_code = os.WEXITSTATUS(status) if os.WIFEXITED(status) else 0
        except ChildProcessError:
            exit_code = 0

    try:
        os.close(master_fd)
    except OSError:
        pass

    emit({"t": "x", "code": exit_code})
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
