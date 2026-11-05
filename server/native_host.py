"""
Chrome native messaging host: runs the analysis server only while the extension
needs it.

Chrome starts this when the extension calls connectNative(), and closes our stdin
when it disconnects (FP turned off everywhere, or the last Showdown tab closed).
We then exit. The server and its search workers run inside a Windows job object
that kills them when this process ends for any reason, crash included, so
nothing is left running.

If a server is already running on the port (started by hand with
start-server.ps1), we leave it alone and just report ready.
"""

import ctypes
import json
import os
import struct
import subprocess
import sys
import threading
import time
import urllib.request
from ctypes import wintypes

HERE = os.path.dirname(os.path.abspath(__file__))
PORT = 8770
HEALTH = f"http://127.0.0.1:{PORT}/health"


def send(msg: dict):
    data = json.dumps(msg).encode()
    sys.stdout.buffer.write(struct.pack("<I", len(data)) + data)
    sys.stdout.buffer.flush()


def server_up() -> bool:
    try:
        with urllib.request.urlopen(HEALTH, timeout=0.5) as r:
            return r.status == 200
    except OSError:
        return False


def kill_on_close_job():
    """A job object whose processes all die when its last handle (ours) closes."""
    k32 = ctypes.WinDLL("kernel32", use_last_error=True)

    class BASIC(ctypes.Structure):
        _fields_ = [
            ("PerProcessUserTimeLimit", ctypes.c_int64),
            ("PerJobUserTimeLimit", ctypes.c_int64),
            ("LimitFlags", wintypes.DWORD),
            ("MinimumWorkingSetSize", ctypes.c_size_t),
            ("MaximumWorkingSetSize", ctypes.c_size_t),
            ("ActiveProcessLimit", wintypes.DWORD),
            ("Affinity", ctypes.c_size_t),
            ("PriorityClass", wintypes.DWORD),
            ("SchedulingClass", wintypes.DWORD),
        ]

    class IO(ctypes.Structure):
        _fields_ = [(n, ctypes.c_uint64) for n in ("r", "w", "o", "rb", "wb", "ob")]

    class EXTENDED(ctypes.Structure):
        _fields_ = [
            ("BasicLimitInformation", BASIC),
            ("IoInfo", IO),
            ("ProcessMemoryLimit", ctypes.c_size_t),
            ("JobMemoryLimit", ctypes.c_size_t),
            ("PeakProcessMemoryUsed", ctypes.c_size_t),
            ("PeakJobMemoryUsed", ctypes.c_size_t),
        ]

    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000
    JobObjectExtendedLimitInformation = 9
    k32.CreateJobObjectW.restype = wintypes.HANDLE
    job = k32.CreateJobObjectW(None, None)
    info = EXTENDED()
    info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
    k32.SetInformationJobObject(job, JobObjectExtendedLimitInformation, ctypes.byref(info), ctypes.sizeof(info))
    return k32, job


def start_server():
    k32, job = kill_on_close_job()
    log = open(os.path.join(HERE, "..", "server.log"), "a", encoding="utf-8")
    proc = subprocess.Popen(
        [sys.executable, os.path.join(HERE, "overlay_server.py"), "--port", str(PORT)],
        stdin=subprocess.DEVNULL,
        stdout=log,
        stderr=log,
        creationflags=subprocess.CREATE_NO_WINDOW,
    )
    k32.OpenProcess.restype = wintypes.HANDLE
    handle = k32.OpenProcess(0x1F0FFF, False, proc.pid)  # PROCESS_ALL_ACCESS
    k32.AssignProcessToJobObject(job, handle)
    # Workers the server spawns later inherit the job, so they die with it too
    return proc, job


def wait_for_stdin_close():
    # Chrome may send messages; we don't need them. EOF means "disconnected".
    while True:
        header = sys.stdin.buffer.read(4)
        if len(header) < 4:
            return
        (length,) = struct.unpack("<I", header)
        sys.stdin.buffer.read(length)


def main():
    proc = job = None
    if server_up():
        send({"type": "ready", "owner": "external"})
    else:
        proc, job = start_server()
        for _ in range(300):  # up to 30 s
            if server_up():
                send({"type": "ready", "owner": "host"})
                break
            if proc.poll() is not None:
                send({"type": "error", "error": "Server exited; see server.log"})
                return
            time.sleep(0.1)
        else:
            send({"type": "error", "error": "Server didn't start in 30 s; see server.log"})

    reader = threading.Thread(target=wait_for_stdin_close, daemon=True)
    reader.start()
    reader.join()
    # Returning closes our job handle, which kills the server and its workers


if __name__ == "__main__":
    main()
