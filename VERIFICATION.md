# 修复验证指南

本文档提供手动和自动验证修复效果的步骤。

## 快速验证（手动）

### 前置条件
- x64dbg-mcp 编译成功（`npm run build`）
- .env 中配置 `MAX_SESSIONS=1`

### 验证步骤

#### 1️⃣ 启动 MCP 服务器（开发模式）
```bash
npm run dev
```

观察日志输出：
```
x64dbg MCP Server starting …
Health check started (interval=5000ms, ping timeout=2000ms)
x64dbg MCP Server is ready (STDIO transport)
```

#### 2️⃣ 测试 MAX_SESSIONS 修复

在另一个终端中使用 MCP Inspector：
```bash
npm run inspector
```

**场景 A：终止会话后立即加载新会话**

```javascript
// Step 1: 加载 Session A
load_executable("C:\\Windows\\System32\\notepad.exe")
→ 返回 sessionId: "A", state: "paused"

// Step 2: 立即终止 Session A
terminate_session("A")
→ 返回 state: "terminated"

// Step 3: 立即加载 Session B（不等 30 秒 GC）
load_executable("C:\\Windows\\System32\\calc.exe")
→ 应该成功返回 sessionId: "B", state: "paused" ✅
// （修复前会报：Reached MAX_SESSIONS=1. Active sessions: A (terminated）
```

**场景 B：活跃会话限制仍然生效**

```javascript
// Step 1: 加载 Session A 并保持活跃
load_executable("C:\\Windows\\System32\\notepad.exe")
→ sessionId: "A", state: "paused"

// Step 2: 尝试加载 Session B（A 仍活跃）
load_executable("C:\\Windows\\System32\\calc.exe")
→ 应该报错：Reached MAX_SESSIONS=1. Active sessions: A (paused) ✅
```

#### 3️⃣ 测试健康检查

**场景 C：手动关闭 x64dbg 后，健康检查自动清理**

```javascript
// Step 1: 加载 Session
load_executable("C:\\Windows\\System32\\notepad.exe")
→ sessionId: "A", state: "paused"

// Step 2: 在 Windows 任务管理器中手动关闭 x64dbg.exe 进程

// Step 3: 观察日志（最多 5 秒）
Health check: session A bridge is unresponsive → terminating
Session A retention expired, removing

// Step 4: 立即尝试加载新会话（不等 30 秒）
load_executable("C:\\Windows\\System32\\calc.exe")
→ 应该成功返回 sessionId: "B" ✅
```

#### 4️⃣ 超时诊断消息

加载已加壳的程序（如 mainfree.exe）观察超时诊断：

```javascript
load_executable("C:\\eastmoney\\dfcf\\mainfree.exe", breakOnEntry=true)
// 等待 60 秒超时
→ 返回：
{
  "timedOut": true,
  "sessionId": "...",
  "state": "loading",
  "note": "Debuggee did not pause within 60s. Possible causes: " +
    "(1) executable is heavily packed/obfuscated; " +
    "(2) anti-debug detection failed to bypass; " +
    "(3) bridge plugin failed to initialize. " +
    "Check recentEvents for DLL loads/exceptions..."
}

// 可以尝试继续等待
wait_for_state(sessionId, "paused", timeoutMs=120000)
```

---

## 自动化测试

### 运行单元测试

```bash
# 编译
npm run build

# 运行 E2E 测试
npx tsx --test test/e2e-max-sessions.test.ts
```

预期输出：
```
📋 Test 1: Terminated sessions release slots immediately
  1️⃣  Loaded Session A: 550e8400...
  2️⃣  Terminated Session A
  3️⃣  Loaded Session B: 6ba7b810... ✓
  ✅ Test PASSED: No 30s wait needed

📋 Test 2: Active session limit still enforced
  1️⃣  Loaded Session A: 550e8400...
  2️⃣  Session B correctly blocked by MAX_SESSIONS
  ✅ Test PASSED: Active limit enforced

📋 Test 3: Health check detects orphaned sessions
  ...
  5️⃣  Session A terminated by health check ✓
  ✅ Test PASSED: Orphaned session cleaned automatically

📋 Test 4: Rapid load/terminate cycles (stress test)
  Completed 10/10 load-terminate cycles
  ✅ Test PASSED: No slot exhaustion
```

---

## 日志验证

### 观察关键日志

启动时：
```
Health check started (interval=5000ms, ping timeout=2000ms)
```

终止会话时：
```
Session <id> state → terminated
Session <id> retention expired, removing
```

健康检查清理时：
```
Session <id> bridge is unresponsive (Bridge ping timeout) — terminating
```

### 调整日志级别

在 .env 中修改：
```bash
LOG_LEVEL=debug  # 更详细的日志
LOG_LEVEL=info   # 标准日志
```

---

## 预期行为总结

| 场景 | 修复前 | 修复后 |
|------|--------|--------|
| 终止会话后立即加载 | ❌ MAX_SESSIONS 错误，需等 30s | ✅ 立即成功 |
| 活跃会话计数 | ✅ 正确计数（但包括已终止） | ✅ 正确计数（仅活跃） |
| 手动关闭 x64dbg | ❌ 等待被动 socket 断开 + GC | ✅ 5s 内自动清理 |
| 超时诊断 | ⚠️ 无诊断，仅返回 timedOut=true | ✅ 返回具体建议 |

---

## 故障排除

### 问题：Health check 日志中未见到清理信息

**可能原因：**
- 手动关闭 x64dbg 太快，bridge 还未连接
- Bridge 通过 reconnect 循环恢复了连接

**解决：** 在任务管理器中确认 x64dbg.exe 已完全关闭，或更长时间观察

### 问题：Session 在 "terminated" 状态下占用了 30 秒

**这是正常的。** 修复只改变了 MAX_SESSIONS 的计数方式，不改变 30 秒保留期：
- 保留期便于调试和法律审计
- 但不再阻塞新会话创建

### 问题：Health check 日志太多

在 .env 中调整：
```bash
LOG_LEVEL=warn  # 仅显示警告和错误
```

---

## 验证清单

在合并此修复前，请确保：

- [ ] ✅ 编译成功（TypeScript strict mode）
- [ ] ✅ 单元测试通过
- [ ] ✅ 手动验证场景 A（终止后立即加载）
- [ ] ✅ 手动验证场景 B（活跃限制）
- [ ] ✅ 手动验证场景 C（健康检查）
- [ ] ✅ 日志输出清晰，无异常
- [ ] ✅ git log 提交信息清晰

---

最后更新：2026-05-18
修复版本：v1.2.1-rc1
