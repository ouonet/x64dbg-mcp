"""End-to-end MCP server verification.

Uses threaded readers to avoid blocking on Windows pipes.
"""
import json
import subprocess
import sys
import time
import os
import threading
import queue


class StdoutReader(threading.Thread):
    """Background thread that reads MCP framed messages from stdout."""

    def __init__(self, pipe):
        super().__init__(daemon=True)
        self.pipe = pipe
        self.q = queue.Queue()

    def run(self):
        try:
            while True:
                # Read headers byte by byte until \r\n\r\n
                headers = b""
                while not headers.endswith(b"\r\n\r\n"):
                    ch = self.pipe.read(1)
                    if not ch:
                        return
                    headers += ch
                # Parse Content-Length
                cl = 0
                for hdr in headers.decode("utf-8", errors="replace").split("\r\n"):
                    if hdr.lower().startswith("content-length:"):
                        cl = int(hdr.split(":", 1)[1].strip())
                if cl > 0:
                    body = self.pipe.read(cl)
                    self.q.put(json.loads(body.decode("utf-8")))
        except Exception:
            pass

    def get(self, timeout=5):
        try:
            return self.q.get(timeout=timeout)
        except queue.Empty:
            return None


def send_mcp(proc, method, params=None, id_val=1):
    req = {"jsonrpc": "2.0", "id": id_val, "method": method}
    if params is not None:
        req["params"] = params
    body = json.dumps(req).encode("utf-8")
    header = "Content-Length: {}\r\n\r\n".format(len(body)).encode("utf-8")
    proc.stdin.write(header + body)
    proc.stdin.flush()


def main():
    project = os.path.dirname(os.path.abspath(__file__))
    bridge_py = os.path.join(project, "plugin", "x64dbg_mcp_bridge.py")
    server_js = os.path.join(project, "dist", "server.js")
    passed = 0
    failed = 0
    procs = []

    print("=" * 60)
    print("x64dbg MCP End-to-End Verification")
    print("=" * 60)

    # --- Step 1: Bridge standalone test ---
    print("\n[1/4] Starting bridge in standalone mode...")
    bridge = subprocess.Popen(
        [sys.executable, bridge_py],
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
    )
    procs.append(bridge)
    time.sleep(2)
    if bridge.poll() is not None:
        print("  FAIL: Bridge exited early")
        failed += 1
        return cleanup(procs, passed, failed)
    print("  OK: Bridge running (pid={})".format(bridge.pid))
    passed += 1

    # Quick TCP test
    import socket
    try:
        s = socket.create_connection(("127.0.0.1", 27042), timeout=3)
        req = json.dumps({"id": "t1", "method": "ping", "params": {}})
        s.sendall((req + "\n").encode())
        s.settimeout(3)
        resp = s.recv(4096).decode().strip()
        s.close()
        data = json.loads(resp)
        print("  OK: TCP protocol works (response id={})".format(data.get("id")))
        passed += 1
    except Exception as e:
        print("  FAIL: TCP test: {}".format(e))
        failed += 1
        return cleanup(procs, passed, failed)

    # --- Step 2: Check MCP server build ---
    print("\n[2/4] Checking MCP server build...")
    if not os.path.isfile(server_js):
        print("  FAIL: dist/server.js not found")
        failed += 1
        return cleanup(procs, passed, failed)
    print("  OK: dist/server.js exists")
    passed += 1

    # --- Step 3: Start MCP server ---
    print("\n[3/4] Starting MCP server (STDIO transport)...")
    env = os.environ.copy()
    env["BRIDGE_PORT"] = "27042"
    env["BRIDGE_HOST"] = "127.0.0.1"
    mcp = subprocess.Popen(
        ["node", server_js],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        env=env,
    )
    procs.append(mcp)
    time.sleep(2)
    if mcp.poll() is not None:
        err = mcp.stderr.read().decode() if mcp.stderr else ""
        print("  FAIL: MCP server exited: {}".format(err[:500]))
        failed += 1
        return cleanup(procs, passed, failed)
    print("  OK: MCP server running (pid={})".format(mcp.pid))
    passed += 1

    # Start background reader for MCP stdout
    reader = StdoutReader(mcp.stdout)
    reader.start()

    # --- Step 4: MCP protocol handshake ---
    print("\n[4/4] MCP protocol handshake...")
    try:
        # Initialize
        send_mcp(mcp, "initialize", {
            "protocolVersion": "2024-11-05",
            "capabilities": {},
            "clientInfo": {"name": "test-verify", "version": "1.0"},
        }, id_val=1)
        resp = reader.get(timeout=5)
        if resp and "result" in resp:
            name = resp["result"].get("serverInfo", {}).get("name", "?")
            print("  OK: Server='{}', protocol='{}'".format(
                name, resp["result"].get("protocolVersion", "?")))
            passed += 1
        else:
            print("  FAIL: Bad initialize response: {}".format(resp))
            failed += 1

        # Send initialized notification (no id for notifications)
        body = json.dumps({"jsonrpc": "2.0", "method": "notifications/initialized"}).encode()
        header = "Content-Length: {}\r\n\r\n".format(len(body)).encode()
        mcp.stdin.write(header + body)
        mcp.stdin.flush()
        time.sleep(0.5)

        # List tools
        send_mcp(mcp, "tools/list", {}, id_val=3)
        resp = reader.get(timeout=5)
        if resp and "result" in resp:
            tools = resp["result"].get("tools", [])
            names = sorted([t["name"] for t in tools])
            print("  OK: {} tools registered:".format(len(tools)))
            for n in names:
                print("      - {}".format(n))
            passed += 1
        else:
            print("  FAIL: tools/list response: {}".format(resp))
            failed += 1

    except Exception as e:
        print("  FAIL: MCP handshake error: {}".format(e))
        import traceback; traceback.print_exc()
        failed += 1

    return cleanup(procs, passed, failed)


def cleanup(procs, passed, failed):
    print("\n" + "=" * 60)
    for p in procs:
        try:
            p.terminate()
            p.wait(timeout=3)
        except Exception:
            p.kill()
    total = passed + failed
    status = "PASSED" if failed == 0 else "FAILED"
    print("Result: {}/{} checks passed  [{}]".format(passed, total, status))
    print("=" * 60)
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
