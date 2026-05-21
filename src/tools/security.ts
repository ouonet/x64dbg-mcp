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

  server.registerTool(
    "detect_packing",
    {
      description: "Scan a PE module for signs of packing or obfuscation. " +
      "Checks: section entropy (>7.0 = likely packed), section name anomalies, " +
      "import table size (very few imports = packer stub), entry-point section location, known packer signatures. " +
      "Returns: { isPacked, confidence (0–1), packerName, overallEntropy, " +
      "indicators: [{type, description, severity}], sectionEntropies, importCount, entryPointSection }.",
      inputSchema: {
      sessionId: z.string().describe("Session ID"),
      module: z
        .string()
        .optional()
        .describe("Module name (default: main executable)"),
    },
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

  server.registerTool(
    "analyze_suspicious_apis",
    {
      description: "Cross-reference the module's import table against a database of Windows APIs commonly used by malware. " +
      "Categories covered: process_injection, process_manipulation, file_system, registry, " +
      "network, crypto, anti_debug, privilege_escalation, hooking, service. " +
      "Returns: { riskLevel (low/medium/high/critical), suspiciousCount, categoriesMatched, " +
      "findings: { <category>: { description, matches: [{function, module, address}] } } }. " +
      "includeAll=true: also include all non-suspicious imports in the response.",
      inputSchema: {
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

  server.registerTool(
    "detect_anti_debug",
    {
      description: "Scan the module for common anti-debugging techniques. " +
      "Detects: API checks (IsDebuggerPresent, CheckRemoteDebuggerPresent, NtQueryInformationProcess), " +
      "timing attacks (GetTickCount, QueryPerformanceCounter), PEB flag reads, int 2d/int 3 traps, " +
      "NtSetInformationThread (hide-from-debugger), TLS callbacks. " +
      "Returns: { hasAntiDebug, totalTechniques, " +
      "techniques: [{name, description, addresses, severity, bypass}], tlsCallbacks }.",
      inputSchema: {
      sessionId: z.string().describe("Session ID"),
      module: z
        .string()
        .optional()
        .describe("Module name (default: main executable)"),
    },
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

  server.registerTool(
    "check_section_anomalies",
    {
      description: "Check PE sections for structural anomalies. " +
      "Detects: WX (writable+executable) sections, unusual names, high entropy (>7.0 = packed/encrypted), " +
      "virtual/raw size mismatches (common in unpacking stubs). " +
      "Returns: { sections: [{name, entropy, isExecutable, isWritable, anomalies[]}], totalAnomalies, summary }.",
      inputSchema: {
      sessionId: z.string().describe("Session ID"),
      module: z
        .string()
        .optional()
        .describe("Module name (default: main executable)"),
    },
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

  server.registerTool(
    "generate_security_report",
    {
      description: "START HERE for malware triage. Run all four security checks in parallel and produce a consolidated report. " +
      "Covers: packing detection, suspicious API analysis, anti-debug detection, section anomaly checks. " +
      "Returns a single JSON with: packing, suspiciousApis, antiDebug, sectionAnomalies, totalImports, generatedAt. " +
      "Use this as the first step when analyzing an unknown or potentially malicious PE, " +
      "then call individual tools for deeper investigation of flagged areas.",
      inputSchema: {
      sessionId: z.string().describe("Session ID"),
      module: z
        .string()
        .optional()
        .describe("Module name (default: main executable)"),
    },
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
