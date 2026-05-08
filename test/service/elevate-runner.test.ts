import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildElevatedArgs,
  runWithTranscript,
  sweepStaleTranscripts,
} from "../../src/service/elevate.js";

describe("elevate-runner", () => {
  test("buildElevatedArgs strips --elevate and adds --transcript", () => {
    const result = buildElevatedArgs(
      ["service", "install", "--port", "3602", "--elevate"],
      "C:\\TestTemp\\x64dbg-mcp-elevated-abc.log"
    );
    assert.deepEqual(result, [
      "service",
      "install",
      "--port",
      "3602",
      "--transcript",
      "C:\\TestTemp\\x64dbg-mcp-elevated-abc.log",
    ]);
  });

  test("runWithTranscript writes captured stdout/stderr from transcript file", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "x64dbg-mcp-elevate-"));
    const transcript = path.join(tmp, "x64dbg-mcp-elevated-test.log");

    let printed = "";
    const fakeSpawn = async () => {
      // Simulate the elevated child writing transcript while running.
      fs.writeFileSync(transcript, "first line\n");
      await new Promise((r) => setTimeout(r, 300));
      fs.appendFileSync(transcript, "second line\n");
      return { exitCode: 0 };
    };

    try {
      const exitCode = await runWithTranscript({
        transcriptPath: transcript,
        spawn: fakeSpawn,
        write: (line) => {
          printed += line;
        },
        pollIntervalMs: 50,
      });
      assert.equal(exitCode, 0);
      assert.match(printed, /first line/);
      assert.match(printed, /second line/);
      assert.equal(fs.existsSync(transcript), false, "transcript should be cleaned up");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("runWithTranscript propagates non-zero exit code", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "x64dbg-mcp-elevate-"));
    const transcript = path.join(tmp, "x64dbg-mcp-elevated-test.log");
    const fakeSpawn = async () => ({ exitCode: 3 });

    try {
      const exitCode = await runWithTranscript({
        transcriptPath: transcript,
        spawn: fakeSpawn,
        write: () => {},
        pollIntervalMs: 50,
      });
      assert.equal(exitCode, 3);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("sweepStaleTranscripts removes files older than threshold", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "x64dbg-mcp-sweep-"));
    const oldFile = path.join(tmp, "x64dbg-mcp-elevated-old.log");
    const newFile = path.join(tmp, "x64dbg-mcp-elevated-new.log");
    const otherFile = path.join(tmp, "unrelated.log");

    fs.writeFileSync(oldFile, "");
    fs.writeFileSync(newFile, "");
    fs.writeFileSync(otherFile, "");

    const old = Date.now() - 2 * 60 * 60 * 1000; // 2 hours ago
    fs.utimesSync(oldFile, new Date(old), new Date(old));

    sweepStaleTranscripts(tmp, 60 * 60 * 1000); // 1 hour threshold

    assert.equal(fs.existsSync(oldFile), false);
    assert.equal(fs.existsSync(newFile), true);
    assert.equal(fs.existsSync(otherFile), true);
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});
