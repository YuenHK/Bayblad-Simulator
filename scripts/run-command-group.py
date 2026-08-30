#!/usr/bin/python3
import os, signal, subprocess, sys, time

if len(sys.argv) < 3 or sys.argv[1] != "--":
    raise SystemExit(64)
child = subprocess.Popen(sys.argv[2:], start_new_session=True)
stopping = False

def stop(signum, _frame):
    global stopping
    if stopping:
        return
    stopping = True
    for caught in (signal.SIGHUP, signal.SIGINT, signal.SIGTERM):
        signal.signal(caught, signal.SIG_IGN)
    try:
        os.killpg(child.pid, signal.SIGTERM)
    except ProcessLookupError:
        pass
    except PermissionError:
        child.terminate()
    deadline = time.monotonic() + 0.75
    while child.poll() is None and time.monotonic() < deadline:
        time.sleep(0.02)
    if child.poll() is None:
        try:
            os.killpg(child.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        except PermissionError:
            child.kill()
    child.wait()
    raise SystemExit(128 + signum)

for sig in (signal.SIGHUP, signal.SIGINT, signal.SIGTERM):
    signal.signal(sig, stop)
raise SystemExit(child.wait())
