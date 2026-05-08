/**
 * Security analysis tools — packing detection, suspicious API analysis,
 * anti-debug detection, section anomaly checks.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { bridgeFor } from "../bridgeRegistry.js";
import { sessions } from "../session.js";

/** Windows APIs commonly associated with malicious behaviour, grouped by category. */
const SUSPICIOUS_API_DB: Record<string, { apis: string[]; description: string }> = {
  process_injection: {
    apis: [
      "VirtualAllocEx", "WriteProcessMemory", "CreateRemoteThread",
      "NtCreateThreadEx", "RtlCreateUserThread", "QueueUserAPC",
      "NtQueueApcThread", "SetThreadContext", "NtUnmapViewOfSection",
    ],
    description: "Process injection / code injection primitives",
  },
  process_manipulation: {
    apis: [
      "OpenProcess", "CreateProcessA", "CreateProcessW",
      "CreateProcessInternalW", "WinExec", "ShellExecuteA", "ShellExecuteW",
      "NtCreateProcess", "NtCreateProcessEx",
    ],
    description: "Process creation / manipulation",
  },
  file_system: {
    apis: [
      "CreateFileA", "CreateFileW", "DeleteFileA", "DeleteFileW",
      "MoveFileA", "MoveFileW", "CopyFileA", "CopyFileW",
      "WriteFile", "NtCreateFile", "NtWriteFile",
    ],
    description: "File system operations",
  },
  registry: {
    apis: [
      "RegCreateKeyExA", "RegCreateKeyExW", "RegSetValueExA",
      "RegSetValueExW", "RegOpenKeyExA", "RegOpenKeyExW",
      "RegDeleteKeyA", "RegDeleteKeyW", "RegDeleteValueA", "RegDeleteValueW",
    ],
    description: "Registry modification (persistence, configuration)",
  },
  network: {
    apis: [
      "WSAStartup", "socket", "connect", "send", "recv",
      "InternetOpenA", "InternetOpenW", "InternetOpenUrlA", "InternetOpenUrlW",
      "HttpOpenRequestA", "HttpOpenRequestW", "HttpSendRequestA",
      "URLDownloadToFileA", "URLDownloadToFileW",
      "WinHttpOpen", "WinHttpConnect", "WinHttpSendRequest",
    ],
    description: "Network communication",
  },
  crypto: {
    apis: [
      "CryptEncrypt", "CryptDecrypt", "CryptCreateHash",
      "CryptHashData", "CryptDeriveKey", "CryptGenKey",
      "BCryptEncrypt", "BCryptDecrypt",
    ],
    description: "Cryptographic operations (may indicate ransomware)",
  },
  anti_debug: {
    apis: [
      "IsDebuggerPresent", "CheckRemoteDebuggerPresent",
      "NtQueryInformationProcess", "OutputDebugStringA",
      "GetTickCount", "QueryPerformanceCounter",
      "NtSetInformationThread", "NtQuerySystemInformation",
    ],
    description: "Anti-debugging / anti-analysis techniques",
  },
  privilege_escalation: {
    apis: [
      "AdjustTokenPrivileges", "OpenProcessToken",
      "LookupPrivilegeValueA", "LookupPrivilegeValueW",
      "ImpersonateLoggedOnUser", "SetTokenInformation",
    ],
    description: "Privilege escalation / token manipulation",
  },
  hooking: {
    apis: [
      "SetWindowsHookExA", "SetWindowsHookExW",
      "GetAsyncKeyState", "GetKeyState", "GetKeyboardState",
      "SetWinEventHook",
    ],
    description: "Hooking / keylogging",
  },
  service: {
    apis: [
      "CreateServiceA", "CreateServiceW",
      "StartServiceA", "StartServiceW",
      "ChangeServiceConfigA", "ChangeServiceConfigW",
      "OpenSCManagerA", "OpenSCManagerW",
    ],
    description: "Windows service manipulation (persistence)",
  },
};

export function registerSecurityTools(server: McpServer): void {
  // ── Detect packing ────────────────────────────────────────────────────

  server.tool(
    "detect_packing",
    "Analyse the loaded executable for signs of packing or obfuscation. " +
      "Checks section entropy, section name anomalies, import table size, " +
      "entry-point location, and known packer signatures. " +
      "Returns a confidence score and list of indicators.",
    {
      sessionId: z.string().describe("Session ID"),
      module: z
        .string()
        .optional()
        .describe("Module name (default: main executable)"),
    },
    async ({ sessionId, module }) => {
      try {
        sessions.get(sessionId);

        const result = await bridgeFor(sessionId).call<{
          module: string;
          isPacked: boolean;
          confidence: number;
          packerName: string | null;
          overallEntropy: number;
          indicators: { type: string; description: string; severity: string }[];
          sectionEntropies: Record<string, number>;
          importCount: number;
          entryPointSection: string;
        }>("security.detectPacking", { sessionId, module });

        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text" as const, text: `Error: ${msg}` }], isError: true };
      }
    }
  );

  // ── Suspicious API analysis ───────────────────────────────────────────

  server.tool(
    "analyze_suspicious_apis",
    "Cross-reference the executable's import table against a database of " +
      "Windows APIs commonly used by malware, grouped by category " +
      "(process injection, network, crypto, anti-debug, etc.). " +
      "Returns per-category findings and an overall risk level.",
    {
      sessionId: z.string().describe("Session ID"),
      module: z
        .string()
        .optional()
        .describe("Module name (default: main executable)"),
      includeAll: z
        .boolean()
        .default(false)
        .describe("Include all imports, not just suspicious ones"),
    },
    async ({ sessionId, module, includeAll }) => {
      try {
        sessions.get(sessionId);

        // Fetch the import table from the bridge
        const imports = await bridgeFor(sessionId).call<{
          imports: { function: string; module: string; address: string }[];
        }>("analysis.getImports", { sessionId, module });

        // Cross-reference against our DB
        const findings: Record<
          string,
          { description: string; matches: { function: string; module: string; address: string }[] }
        > = {};
        let suspiciousCount = 0;

        for (const [category, info] of Object.entries(SUSPICIOUS_API_DB)) {
          const matches = imports.imports.filter((imp) =>
            info.apis.some(
              (api) => imp.function.toLowerCase() === api.toLowerCase()
            )
          );
          if (matches.length > 0) {
            findings[category] = { description: info.description, matches };
            suspiciousCount += matches.length;
          }
        }

        // Risk level: weight high-signal categories more than noisy ones.
        // file_system / registry / process_manipulation are common in normal software.
        const HIGH_SIGNAL = new Set([
          "process_injection", "hooking", "privilege_escalation", "anti_debug",
        ]);
        const highSignalCategories = Object.keys(findings).filter((c) => HIGH_SIGNAL.has(c));
        const allCategories = Object.keys(findings);

        let riskLevel: string;
        if (allCategories.length === 0) {
          riskLevel = "low";
        } else if (highSignalCategories.length === 0 && allCategories.length <= 3) {
          riskLevel = "medium";
        } else if (highSignalCategories.length <= 1 && allCategories.length <= 5) {
          riskLevel = "medium";
        } else if (highSignalCategories.length <= 2) {
          riskLevel = "high";
        } else {
          riskLevel = "critical";
        }

        const response: Record<string, unknown> = {
          module: module ?? "(main)",
          totalImports: imports.imports.length,
          suspiciousCount,
          categoriesMatched: allCategories.length,
          riskLevel,
          findings,
        };

        if (includeAll) {
          response.allImports = imports.imports;
        }

        return {
          content: [{ type: "text" as const, text: JSON.stringify(response, null, 2) }],
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text" as const, text: `Error: ${msg}` }], isError: true };
      }
    }
  );

  // ── Anti-debug detection ──────────────────────────────────────────────

  server.tool(
    "detect_anti_debug",
    "Scan the loaded executable for common anti-debugging techniques: " +
      "API checks (IsDebuggerPresent, NtQueryInformationProcess), " +
      "timing checks, PEB flags, int 2d / int 3, TLS callbacks, etc.",
    {
      sessionId: z.string().describe("Session ID"),
      module: z
        .string()
        .optional()
        .describe("Module name (default: main executable)"),
    },
    async ({ sessionId, module }) => {
      try {
        sessions.get(sessionId);

        const result = await bridgeFor(sessionId).call<{
          module: string;
          techniques: {
            name: string;
            description: string;
            addresses: string[];
            severity: string;
            bypass: string;
          }[];
          tlsCallbacks: string[];
          hasAntiDebug: boolean;
          totalTechniques: number;
        }>("security.detectAntiDebug", { sessionId, module });

        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text" as const, text: `Error: ${msg}` }], isError: true };
      }
    }
  );

  // ── Section anomaly check ─────────────────────────────────────────────

  server.tool(
    "check_section_anomalies",
    "Check PE sections for anomalies that may indicate packing, " +
      "code injection, or tampering: writable+executable sections, " +
      "unusual names, zero raw-size with non-zero virtual-size, high entropy.",
    {
      sessionId: z.string().describe("Session ID"),
      module: z
        .string()
        .optional()
        .describe("Module name (default: main executable)"),
    },
    async ({ sessionId, module }) => {
      try {
        sessions.get(sessionId);

        const result = await bridgeFor(sessionId).call<{
          module: string;
          sections: {
            name: string;
            virtualAddress: string;
            virtualSize: string;
            rawSize: string;
            entropy: number;
            isExecutable: boolean;
            isWritable: boolean;
            anomalies: string[];
          }[];
          totalAnomalies: number;
          summary: string;
        }>("security.checkSectionAnomalies", { sessionId, module });

        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text" as const, text: `Error: ${msg}` }], isError: true };
      }
    }
  );

  // ── Full security report ──────────────────────────────────────────────

  server.tool(
    "generate_security_report",
    "Run all security analysis tools and produce a consolidated report: " +
      "packing detection, suspicious API analysis, anti-debug detection, " +
      "and section anomaly checks. Useful as a first-pass triage.",
    {
      sessionId: z.string().describe("Session ID"),
      module: z
        .string()
        .optional()
        .describe("Module name (default: main executable)"),
    },
    async ({ sessionId, module }) => {
      try {
        sessions.get(sessionId);

        type ImportsResult = { imports: { function: string; module: string; address: string }[] };
        const [packing, antiDebug, sectionAnomalies, importsResult] = await Promise.all([
          bridgeFor(sessionId).call("security.detectPacking", { sessionId, module }),
          bridgeFor(sessionId).call("security.detectAntiDebug", { sessionId, module }),
          bridgeFor(sessionId).call("security.checkSectionAnomalies", { sessionId, module }),
          bridgeFor(sessionId).call<ImportsResult>("analysis.getImports", { sessionId, module }),
        ]);

        // Build suspicious API summary inline
        const findings: Record<string, number> = {};
        let suspiciousCount = 0;
        for (const [category, info] of Object.entries(SUSPICIOUS_API_DB)) {
          const imps = importsResult.imports ?? [];
          const count = imps.filter((imp) =>
            info.apis.some(
              (api) => imp.function.toLowerCase() === api.toLowerCase()
            )
          ).length;
          if (count > 0) {
            findings[category] = count;
            suspiciousCount += count;
          }
        }

        const report = {
          module: module ?? "(main)",
          generatedAt: new Date().toISOString(),
          packing,
          suspiciousApis: { suspiciousCount, findings },
          antiDebug,
          sectionAnomalies,
          totalImports: importsResult.imports?.length ?? 0,
        };

        return {
          content: [{ type: "text" as const, text: JSON.stringify(report, null, 2) }],
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text" as const, text: `Error: ${msg}` }], isError: true };
      }
    }
  );
}
