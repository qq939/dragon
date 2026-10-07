# DRAGON · 失业青年怒杀龙虎榜

段落式 AI 小说写作服务，由 mythos 优化而来。

## 与 mythos 的区别

| | mythos | dragon |
|---|---|---|
| 写作粒度 | 按章（2000字/章） | 按段（300-500字/段） |
| prompt 传递 | `spawn(..., {shell:true})` 命令行参数 | `shell:false` + stdin 管道 |
| 输出方式 | 等待完成一次性返回 | SSE 流式输出，实时可见 |
| 并发控制 | 无 | 生成锁，409 拒绝重入 |
| 超时 | 50 分钟写死 | 环境变量可配，默认 10 分钟 |
| 上下文 | 全量章节拼接 | 滑动窗口（默认最近 12 段） |
| 主题 | Mythos AI 逃逸 | 失业青年怒杀龙虎榜 |

## 核心 bug 修复

旧实现：
```js
spawn('claude', ['--dangerously-skip-permissions', '--print', '-p', fullPrompt], { shell: true })
```
prompt 经 shell 拼进命令行。中文里的引号/反引号等字符会破坏 shell
引用配对，shell 一直等待闭合 → 子进程卡死 → 页面无限转圈。
且用户输入直接进 shell 命令，有注入风险。

新实现：
```js
const child = spawn('claude', ['--dangerously-skip-permissions', '--print'],
  { stdio: ['pipe','pipe','pipe'], shell: false, env: {...} });
child.stdin.write(fullPrompt, 'utf8');
child.stdin.end();
```
`shell:false` + stdin 管道，彻底绕开 shell。

## 接口

- `GET /api/paragraphs` —— 段落列表
- `GET /api/paragraph/:num` —— 读一段
- `PUT /api/paragraph/:num` —— 改一段（自动存版本）
- `POST /api/paragraph/continue` —— 续写一段（非流式）
- `POST /api/paragraph/continue-stream` —— 续写一段（SSE 流式）
- `GET /api/manuscript` —— 全文拼接
- `GET/POST /api/system-prompt` —— 主题设定
- `GET/POST /api/style-prompt` —— 风格参考
- `GET /api/status` —— 服务状态

## 环境变量

- `PORT` —— 监听端口（默认 8082）
- `GENERATE_TIMEOUT_MS` —— 生成超时毫秒（默认 600000）
- `CONTEXT_PARAGRAPHS` —— 上下文段数（默认 12）
- `PARA_TARGET` —— 每段目标字数描述（默认 `300-500字`）

## 启动

```bash
bash user_start.sh
# 或
node server.js
```
