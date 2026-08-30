#!/usr/bin/python3
import ctypes, errno, os, signal, subprocess, sys, time

if len(sys.argv) < 2 or not os.path.isabs(sys.argv[1]):
    raise SystemExit(64)
if sys.platform == "linux" and ctypes.CDLL(None, use_errno=True).prctl(36, 1, 0, 0, 0) != 0:
    raise OSError(ctypes.get_errno(), "PR_SET_CHILD_SUBREAPER")
child = subprocess.Popen(sys.argv[1:], start_new_session=True)
requested = 0
def request(signum, _frame):
    global requested
    requested = signum
for caught in (signal.SIGHUP, signal.SIGINT, signal.SIGTERM): signal.signal(caught, request)
def group_exists():
    try: os.killpg(child.pid, 0); return True
    except ProcessLookupError: return False
    except PermissionError: return True
def reap():
    while True:
        try:
            pid, _ = os.waitpid(-1, os.WNOHANG)
            if pid == 0: return
        except ChildProcessError: return
while child.poll() is None and not requested:
    reap(); time.sleep(0.02)
if requested:
    try: os.killpg(child.pid, signal.SIGTERM)
    except ProcessLookupError: pass
    deadline=time.monotonic()+3
    while group_exists() and time.monotonic()<deadline: reap();time.sleep(0.02)
    if group_exists():
        try: os.killpg(child.pid, signal.SIGKILL)
        except ProcessLookupError: pass
    child.wait();reap();raise SystemExit(128+requested)
result=child.wait();reap()
if group_exists():
    try: os.killpg(child.pid, signal.SIGKILL)
    except ProcessLookupError: pass
    for _ in range(100): reap();time.sleep(0.01)
    raise SystemExit(70)
raise SystemExit(result)
