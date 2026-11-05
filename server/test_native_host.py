"""
Lifecycle test for the native messaging host, driving it the way Chrome does.

1. Start the host with a stdin/stdout pipe; expect {"type": "ready"}.
2. Run one analysis so the search workers spawn.
3. Close stdin (Chrome disconnecting); expect the server and every worker to exit.
4. Start again, then kill the host outright (a crash); expect the same cleanup.

    .venv\\Scripts\\python.exe server\\test_native_host.py <abs path to replay.json>
"""

import json
import os
import struct
import subprocess
import sys
import time
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
BAT = os.path.join(HERE, "native_host.bat")
URL = "http://127.0.0.1:8770"


def up():
    try:
        with urllib.request.urlopen(URL + "/health", timeout=0.5):
            return True
    except OSError:
        return False


def server_processes():
    out = subprocess.run(
        ["powershell", "-NoProfile", "-Command",
         "Get-CimInstance Win32_Process -Filter \"Name='python.exe'\" | Where-Object { $_.CommandLine -match 'overlay_server|multiprocessing' } | Measure-Object | Select-Object -ExpandProperty Count"],
        capture_output=True, text=True,
    )
    return int(out.stdout.strip() or 0)


def read_message(proc):
    n = struct.unpack("<I", proc.stdout.read(4))[0]
    return json.loads(proc.stdout.read(n))


def analyze_once(replay_path):
    log = json.load(open(replay_path, encoding="utf-8"))["log"].split("\n")
    up_to = log.index("|turn|3") + 1
    body = json.dumps({"log": log, "side": "p1", "upTo": up_to, "searchMs": 300, "worlds": 4}).encode()
    req = urllib.request.Request(URL + "/analyze", data=body, headers={"Content-Type": "application/json", "X-FPO": "1"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.load(r)


def wait_until(cond, seconds):
    end = time.time() + seconds
    while time.time() < end:
        if cond():
            return True
        time.sleep(0.2)
    return False


def start_host():
    t0 = time.time()
    proc = subprocess.Popen(["cmd", "/c", BAT], stdin=subprocess.PIPE, stdout=subprocess.PIPE)
    msg = read_message(proc)
    print(f"host says {msg} after {time.time() - t0:.1f}s")
    assert msg["type"] == "ready" and msg["owner"] == "host", msg
    return proc


def main():
    assert not up(), "stop any running server first"

    proc = start_host()
    res = analyze_once(sys.argv[1])
    assert res["ok"], res
    print(f"analysis ok; server processes running: {server_processes()}")

    proc.stdin.close()  # Chrome disconnects
    assert wait_until(lambda: not up() and server_processes() == 0, 10), "server still running after disconnect"
    print("disconnect: server and workers gone")

    proc = start_host()
    analyze_once(sys.argv[1])
    subprocess.run(["taskkill", "/F", "/T", "/PID", str(proc.pid)], capture_output=True)
    # kill only the host chain (cmd + python host), as a crash would; the job does the rest
    assert wait_until(lambda: not up() and server_processes() == 0, 10), "server survived a host crash"
    print("host crash: server and workers gone")


if __name__ == "__main__":
    main()
