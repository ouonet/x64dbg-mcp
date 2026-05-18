# x64dbg-mcp 问题诊断与修复报告

## 问题 1：Debuggee 无法从 "loading" 状态进入 "paused"

### 根本原因

调试器在加载可执行文件后，应该在入口点或 TLS 回调处暂停，并通过 TCP bridge 发送 `stateChange` 事件回到 Node.js MCP 服务器。但如果以下任何情况发生，bridge 永远不会发送状态转换消息：

1. **可执行文件过度加壳或混淆** — 许多壳（如 UPX、商业加壳工具、虚拟机保护等）会干扰调试器的正常暂停机制
2. **异常入口点地址** — `0x0000000076FF8499` 位于系统区域（ntdll），说明入口点计算可能错误，或程序直接跳转到异常处理
3. **反调试检测失败** — 如果可执行文件有反调试代码，且 bridge 没有正确清除相关标志，程序可能会自杀或行为异常
4. **Bridge 插件未正确初始化** — Python bridge plugin 可能因 Python 环境问题或 x64dbg 脚本引擎问题而失败

### 当前行为

- `load_executable()` 创建会话，状态为 `"loading"`
- 在 bridge 响应超时（60 秒）后返回 `timedOut: true, state: "loading"`
- 缺乏足够的诊断信息，用户无法判断是加壳问题还是网络问题

### 修复方案

#### 修复 1.1：改进超时错误消息（已实施）

在 `src/tools/debug.ts` 中，当 `load_executable()` 或 `attach_to_process()` 超时时，现在返回诊断信息：

```json
{
  "timedOut": true,
  "sessionId": "...",
  "state": "loading",
  "note": "Debuggee did not pause within 60s. Possible causes: (1) executable is heavily packed/obfuscated " +
    "(prevent debugger from pausing); (2) anti-debug detection failed to bypass; (3) bridge plugin failed to initialize. " +
    "Check recentEvents for DLL loads/exceptions. Use wait_for_state to continue waiting, or terminate_session to clean up."
}
```

#### 修复 1.2：诊断步骤（用户手动操作）

若遇到此问题，用户应：

1. **检查 recentEvents** — 查看是否有异常堆栈跟踪或 DLL 加载失败的迹象
2. **检查 bridge 日志** — 在 x64dbg 的 debug 窗口查看 bridge plugin 是否正常初始化
3. **使用 `wait_for_state`** — 若某些程序需要更长的初始化时间，调用 `wait_for_state(sessionId, "paused", timeoutMs: 120000)` 继续等待
4. **尝试非加壳程序** — 用简单的 C++ 程序（如 `MessageBox` 或 `exit()` 调用）验证 bridge 是否正常工作
5. **检查架构匹配** — 确保使用正确的 x32dbg/x64dbg（根据可执行文件位数）

---

## 问题 2：已终止会话仍占用 MAX_SESSIONS 槽位

### 根本原因

会话的生命周期管理中存在设计缺陷（src/session.ts:71-159）：

- `createLoading()` 和 `create()` 检查 `this.sessions.size >= config.maxSessions`
- 当用户调用 `terminate_session()` 时，session 进入 `state: "terminated"`
- **关键问题**：`terminate()` 方法不会立即从 `sessions` Map 中删除会话记录
- 只有垃圾回收（GC）在 `terminatedAt + 30秒` 后才会删除（D15 / T9）
- 在这 30 秒的保留期间，已终止的 session 仍然占用一个槽位

### 当前行为

```
Session 1 加载 → state: "loading" → 后来 state: "terminated"  ← 仍占用 1 个 slot
尝试加载 Session 2 → 检查 this.sessions.size (= 1) >= MAX_SESSIONS (= 1)  ← 拒绝！
等待 30 秒 → GC 删除 Session 1 → 现在能加载 Session 2
```

### 修复方案（已实施）

修改 `src/session.ts` 中的 `create()` 和 `createLoading()` 方法，使其只计数**活跃**会话（非 "terminated" 状态）：

```typescript
// 修复前：
if (this.sessions.size >= config.maxSessions) { ... }

// 修复后：
const activeSessions = this.list().filter((s) => s.state !== "terminated");
if (activeSessions.length >= config.maxSessions) { ... }
```

### 效果

- 用户调用 `terminate_session(id)` 后，该会话立即停止计入 MAX_SESSIONS 限制
- 无需等待 30 秒 GC，可立即加载新会话
- 保留期仍然存在（D15），便于调试和法律审计，但不再阻塞新会话

---

## 修复汇总

### 文件改动

- `src/session.ts`
  - `create()`：改用 `activeSessions.length` 替代 `this.sessions.size`
  - `createLoading()`：改用 `activeSessions.length` 替代 `this.sessions.size`

- `src/tools/debug.ts`
  - `load_executable()` 超时处理：添加诊断消息（指出加壳/反调试/bridge 初始化问题）
  - `attach_to_process()` 超时处理：添加诊断消息

### 构建状态

✅ 编译通过（TypeScript strict mode）

### 测试建议

1. **测试 MAX_SESSIONS 修复**
   ```bash
   # 1. 加载 Session A
   load_executable(exe1)  → sessionId: A, state: "paused"
   
   # 2. 加载 Session B (MAX_SESSIONS=2)
   load_executable(exe2)  → sessionId: B, state: "paused"
   
   # 3. 终止 Session A
   terminate_session(A)   → sessionId: A, state: "terminated"
   
   # 4. 立即加载 Session C（不应报错）
   load_executable(exe3)  → sessionId: C, state: "paused"  ✓ 成功
   ```

2. **测试诊断消息**
   - 加载已加壳的可执行文件（如 `mainfree.exe`）
   - 观察 60 秒超时后的 `note` 字段，应包含诊断建议

---

## 后续建议

### 短期（已实施）

- ✅ MAX_SESSIONS 槽位计数修复
- ✅ 超时诊断消息改进

### 中期（建议）

1. **提高 load 超时时间** — 对于加壳程序，可能需要 120 秒或更长
2. **添加可配置入口点超时** — 允许用户指定 breakOnEntry 的等待时间
3. **实现 bridge healthcheck** — 在创建会话前验证 bridge 是否就绪

### 长期（架构改进）

1. **删除 30 秒保留期** — 改为立即删除 terminated 会话（日志已足够审计）
2. **会话复用池** — 对于频繁加载/卸载的场景，考虑会话复用机制
3. **异步加载 API** — 允许 `load_executable()` 返回立即响应，用 `wait_for_state` 来轮询
