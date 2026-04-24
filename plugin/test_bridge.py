"""Quick integration test for the MCP bridge TCP protocol."""
import json
import socket
import subprocess
import sys
import time
import os

BRIDGE_HOST = "127.0.0.1"
BRIDGE_PORT = 27042

def send_request(sock, method, params=None):
    req = {"id": f"test-{method}", "method": method, "params": params or {}}
    payload = json.dumps(req) + "\n"
    sock.sendall(payload.encode("utf-8"))
    data = b""
    while b"\n" not in data:
        chunk = sock.recv(4096)
        if not chunk:
            break
        data += chunk
    return json.loads(data.decode("utf-8").strip())

def main():
    # Start bridge in subprocess
    bridge_script = os.path.join(os.path.dirname(__file__), "x64dbg_mcp_bridge.py")
    print(f"[TEST] Starting bridge: {bridge_script}")
    proc = subprocess.Popen(
        [sys.executable, bridge_script],
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
    )

    # Wait for it to start
    time.sleep(2)

    if proc.poll() is not None:
        out = proc.stdout.read().decode() if proc.stdout else ""
        print(f"[TEST] Bridge exited early (code {proc.returncode}): {out}")
        return 1

    print(f"[TEST] Bridge started (pid={proc.pid}), connecting...")

    try:
        sock = socket.create_connection((BRIDGE_HOST, BRIDGE_PORT), timeout=5)
        print("[TEST] Connected to bridge")

        # Test 1: Unknown method
        resp = send_request(sock, "nonexistent.method")
        assert not resp["success"], "Expected failure for unknown method"
        print(f"[TEST] PASS: unknown method -> error: {resp['error']}")

        # Test 2: debug.continue (will fail -- no x64dbg, but tests dispatch)
        resp = send_request(sock, "debug.continue")
        assert not resp["success"], "Expected failure without x64dbg"
        assert "running x64dbg" in resp["error"], f"Unexpected error: {resp['error']}"
        print(f"[TEST] PASS: debug.continue -> error: {resp['error']}")

        # Test 3: registers.get (same -- tests handler routing)
        resp = send_request(sock, "registers.get")
        assert not resp["success"]
        print(f"[TEST] PASS: registers.get -> error: {resp['error']}")

        # Test 4: memory.read
        resp = send_request(sock, "memory.read", {"address": "0x401000", "size": 16})
        assert not resp["success"]
        print(f"[TEST] PASS: memory.read -> error: {resp['error']}")

        # Test 5: analysis.disassemble
        resp = send_request(sock, "analysis.disassemble", {"address": "0x401000"})
        assert not resp["success"]
        print(f"[TEST] PASS: analysis.disassemble -> error: {resp['error']}")

        sock.close()
        print("\n[TEST] All 5 protocol tests PASSED")
        return 0

    except ConnectionRefusedError:
        print("[TEST] FAIL: Could not connect to bridge")
        return 1
    except Exception as e:
        print(f"[TEST] FAIL: {e}")
        return 1
    finally:
        proc.terminate()
        proc.wait(timeout=5)
        print("[TEST] Bridge process terminated")

if __name__ == "__main__":
    sys.exit(main())
