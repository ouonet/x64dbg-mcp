import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');

// Start the MCP server.
const server = spawn('node', ['dist/server.js'], {
  cwd: repoRoot,
  stdio: ['pipe', 'pipe', 'inherit']
});

let responseBuffer = '';
let attachSessionId = null;

server.stdout.on('data', (data) => {
  const text = data.toString();
  console.log('[Server]', text.trim());
  responseBuffer += text;
  
  // Process complete JSON responses as they arrive.
  const lines = responseBuffer.split('\n');
  for (let i = 0; i < lines.length - 1; i++) {
    try {
      const json = JSON.parse(lines[i]);
      if (json.result && json.result.content) {
        const content = json.result.content[0]?.text;
        if (content) {
          const parsed = JSON.parse(content);
          if (parsed.sessionId) {
            attachSessionId = parsed.sessionId;
            console.log('\nAttach succeeded.');
            console.log('SessionId:', parsed.sessionId);
            console.log('PID:', parsed.pid);
            console.log('Architecture:', parsed.architecture);
            console.log('Entry Point:', parsed.entryPoint);
          }
        }
      }
    } catch (e) {
      // Ignore non-JSON lines.
    }
  }
  responseBuffer = lines[lines.length - 1];
});

// Wait for the server to start, then send the request.
setTimeout(() => {
  console.log('\nSending attach_to_process request...\n');
  const request = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: {
      name: 'attach_to_process',
      arguments: {
        pid: 32056,
        breakOnEntry: true,
        autoAnalyze: true
      }
    }
  });
  
  server.stdin.write(request + '\n');
  
  // Shut down after the response window.
  setTimeout(() => {
    console.log('\nStopping server...\n');
    server.kill();
  }, 60000);
}, 2000);
