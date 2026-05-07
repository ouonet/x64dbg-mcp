/**
 * Core type definitions for x64dbg MCP Server
 */

// ─── Session ────────────────────────────────────────────────────────────────

export interface Session {
  id: string;
  pid: number;
  executable: string;
  architecture: "x86" | "x64";
  state: DebugState;
  createdAt: number;
  lastActivity: number;
  breakpoints: Map<string, Breakpoint>;
  modules: ModuleInfo[];
}

export type DebugState =
  | "idle"
  | "loading"
  | "paused"
  | "running"
  | "stepping"
  | "terminated"
  | "error";

// ─── Registers ──────────────────────────────────────────────────────────────

export interface Registers64 {
  rax: string;
  rbx: string;
  rcx: string;
  rdx: string;
  rsi: string;
  rdi: string;
  rbp: string;
  rsp: string;
  rip: string;
  r8: string;
  r9: string;
  r10: string;
  r11: string;
  r12: string;
  r13: string;
  r14: string;
  r15: string;
  rflags: string;
}

export interface Registers32 {
  eax: string;
  ebx: string;
  ecx: string;
  edx: string;
  esi: string;
  edi: string;
  ebp: string;
  esp: string;
  eip: string;
  eflags: string;
}

export type Registers = Registers64 | Registers32;

export interface FlagRegister {
  CF: boolean;
  PF: boolean;
  AF: boolean;
  ZF: boolean;
  SF: boolean;
  TF: boolean;
  IF: boolean;
  DF: boolean;
  OF: boolean;
}

// ─── Breakpoints ────────────────────────────────────────────────────────────

export interface Breakpoint {
  address: string;
  type: BreakpointType;
  enabled: boolean;
  hitCount: number;
  condition?: string;
  logText?: string;
  name?: string;
  module?: string;
}

export type BreakpointType =
  | "software"
  | "hardware_execute"
  | "hardware_read"
  | "hardware_write"
  | "hardware_access"
  | "memory_read"
  | "memory_write"
  | "memory_access";

// ─── Disassembly ────────────────────────────────────────────────────────────

export interface Instruction {
  address: string;
  bytes: string;
  mnemonic: string;
  operands: string;
  comment?: string;
  isCall: boolean;
  isJump: boolean;
  isRet: boolean;
  isNop: boolean;
  refAddress?: string;
}

export interface DisassemblyBlock {
  startAddress: string;
  endAddress: string;
  instructions: Instruction[];
  functionName?: string;
}

// ─── Memory ─────────────────────────────────────────────────────────────────

export interface MemoryRegion {
  baseAddress: string;
  size: string;
  protection: string;
  type: string;
  module?: string;
}

export interface MemoryDump {
  address: string;
  size: number;
  hex: string;
  ascii: string;
  bytes: number[];
}

export interface MemoryMap {
  regions: MemoryRegion[];
  totalMapped: string;
}

// ─── Modules ────────────────────────────────────────────────────────────────

export interface ModuleInfo {
  name: string;
  path: string;
  base: string;
  size: string;
  entry: string;
  sections: SectionInfo[];
  imports?: ImportEntry[];
  exports?: ExportEntry[];
}

export interface SectionInfo {
  name: string;
  virtualAddress: string;
  virtualSize: string;
  rawSize: string;
  characteristics: string;
  entropy?: number;
}

export interface ImportEntry {
  module: string;
  function: string;
  ordinal?: number;
  address: string;
}

export interface ExportEntry {
  name: string;
  ordinal: number;
  address: string;
  forwarder?: string;
}

// ─── Analysis ───────────────────────────────────────────────────────────────

export interface FunctionInfo {
  address: string;
  endAddress: string;
  name: string;
  size: number;
  instructionCount: number;
  callCount: number;
  isLeaf: boolean;
  callers: string[];
  callees: string[];
}

export interface CrossReference {
  from: string;
  to: string;
  type: "call" | "jump" | "data_read" | "data_write" | "unknown";
  instruction?: string;
  module?: string;
}

export interface StringReference {
  address: string;
  value: string;
  type: "ascii" | "unicode";
  length: number;
  module?: string;
  referencedBy: string[];
}

export interface StackFrame {
  index: number;
  address: string;
  returnAddress: string;
  module?: string;
  function?: string;
  offset?: string;
  args: string[];
}

export interface ThreadInfo {
  id: number;
  handle: string;
  entry: string;
  teb: string;
  state: string;
  priority: string;
  name?: string;
}

// ─── Security Analysis ──────────────────────────────────────────────────────

export interface PackingAnalysis {
  isPacked: boolean;
  confidence: number;
  packerName?: string;
  indicators: PackingIndicator[];
  sectionEntropies: Record<string, number>;
  overallEntropy: number;
}

export interface PackingIndicator {
  type: string;
  description: string;
  severity: "low" | "medium" | "high";
}

export interface SuspiciousApiAnalysis {
  totalImports: number;
  suspiciousCount: number;
  categories: Record<string, SuspiciousApiEntry[]>;
  riskLevel: "low" | "medium" | "high" | "critical";
  summary: string;
}

export interface SuspiciousApiEntry {
  function: string;
  module: string;
  address: string;
  category: string;
  description: string;
  riskLevel: "low" | "medium" | "high" | "critical";
}

// ─── Bridge Protocol ────────────────────────────────────────────────────────
//
// Field naming convention across the TS ↔ Python boundary:
//   TypeScript uses camelCase  (e.g. breakOnEntry, entryPoint, hitCount)
//   Python uses snake_case     (e.g. break_on_entry, entry_point, hit_count)
//
// The Python bridge converts outgoing dict keys to camelCase before sending
// and converts incoming JSON keys from camelCase to snake_case internally.
// When adding new fields, update both sides and keep this mapping in sync.
// Key mappings in use (TS camelCase → Python snake_case):
//   breakOnEntry      → break_on_entry
//   entryPoint        → entry_point
//   hitCount          → hit_count
//   logText           → log_text
//   sessionId         → session_id
//   moduleBase        → module_base
//   protocolVersion   → protocol_version (checked server-side only)

export const BRIDGE_PROTOCOL_VERSION = "1" as const;

export interface BridgeRequest {
  id: string;
  method: string;
  params: Record<string, unknown>;
  authToken?: string;
  protocolVersion: typeof BRIDGE_PROTOCOL_VERSION;
}

export interface BridgeResponse {
  id: string;
  success: boolean;
  data?: unknown;
  error?: string;
}

export interface BridgeEvent {
  event: string;
  data: Record<string, unknown>;
  sessionId?: string;
  timestamp: number;
}

// ─── Configuration ──────────────────────────────────────────────────────────

export interface ServerConfig {
  x64dbgPath: string;
  bridgeHost: string;
  bridgePort: number;
  bridgeAuthToken: string;
  mcpTransport: "stdio" | "streamable-http";
  mcpHttpHost: string;
  mcpHttpPort: number;
  logLevel: "error" | "warn" | "info" | "debug";
  sessionTimeoutMs: number;
  maxDisasmInstructions: number;
  maxTraceInstructions: number;
  maxSearchResults: number;
  maxStringLength: number;
}
