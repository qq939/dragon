// dragon —— 段落式 AI 小说写作服务
// 由 mythos 优化而来，主要改进：
//   1. [BUG修复] prompt 改走 stdin 管道，不再经 shell:true 拼进命令行
//      （原实现把整段中文 prompt 塞进 -p 参数，遇到未配对的引号/反引号时
//       shell 会一直等待闭合，导致子进程卡死、页面无限转圈）
//   2. 章节式 → 段落式：一次只写一段（800-1200字），上下文用滑动窗口
//   3. 新增 SSE 流式输出接口，生成过程实时可见
//   4. 并发锁：同一时间只允许一个生成任务
//   5. 超时可配置，默认 10 分钟
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const url = require('url');

const PORT = process.env.PORT || 8082;
const PROJECT_DIR = __dirname;
const PARAGRAPHS_DIR = path.join(PROJECT_DIR, 'paragraphs');
const PROMPT_FILE = path.join(PROJECT_DIR, 'system_prompt.txt');
const STYLE_FILE = path.join(PROJECT_DIR, 'style_prompt.txt');
const LOG_FILE = path.join(PROJECT_DIR, 'logs', 'novel.log');

const GENERATE_TIMEOUT_MS = parseInt(process.env.GENERATE_TIMEOUT_MS || '600000', 10);
const CONTEXT_PARAGRAPHS = parseInt(process.env.CONTEXT_PARAGRAPHS || '12', 10);
const PARA_TARGET = process.env.PARA_TARGET || '800-1200字';

// 并发锁：同一时间只允许一个生成任务
let generating = false;

const DEFAULT_SYSTEM_PROMPT = `《失业青年怒杀龙虎榜》——长篇小说系统设定（AI 必须死守，优先级最高）

一、故事内核
主角林默，32岁，前互联网大厂 P6，2026 年初被"优化"。赔偿金 N+1 到账那天，他没有投简历，而是在城中村出租屋里支起两台显示器，决定用这笔钱在 A 股里杀出一条活路。
"龙虎榜"是交易所每日公布的异动股榜单：哪只股票涨跌异常、哪些营业部席位在买在卖，一目了然。它是游资的主战场，是机构短兵相接的地方，也是散户仰望的封神台。林默的目标：从一个无人问津的小散户开始，一路杀到龙虎榜上，让自己的席位成为传说。
这不是爽文。这是一个失业青年在时代夹缝里的困兽之斗：有涨停的高光，也有跌停吃面的至暗；有精准的预判，也有被主力按在地上摩擦的惨痛。钱会亏完，心态会崩，但人得往前走。

二、主要人物（性格锁定，不许写崩）
1. 林默：男，32岁。前大厂后端开发，逻辑极强，情绪极稳——但那是上班时的他。失业后，他话变少了，烟抽多了，半夜会盯着 K 线看到三点。优点：复盘能力极强，能从历史数据里抠出规律；缺点：固执，认定的事九头牛拉不回，亏钱了喜欢死扛。他的"怒"不是咆哮，是沉默里的狠劲。
2. 老陈：50多岁，林默的房东，前散户，2008 年亏光过一套房。现在每天在楼下下棋，偶尔上楼看一眼林默的屏幕，扔下一句不咸不淡的话。话少，但每句都准。
3. 苏晴：林默的前同事，留在了大厂，偶尔微信问他"最近怎么样"。代表着他回不去的另一种人生。
4. "章鱼哥"：某知名游资席位的幕后操盘手，龙虎榜上的常客，是林默在榜单上迟早要正面遭遇的对手。前期只闻其名，不见其人。

三、世界观硬性规则（绝对优先，违反即废稿）
1. 时间线：2026 年，A 股实行 T+1、涨跌停 10%（科创 20%），龙虎榜规则与现实一致：日涨跌幅偏离值达 7%、换手率达 20% 等条件上榜。不要编造交易规则。
2. 现实质感：写实向。不写"一个涨停翻倍"这种反常识剧情；不写主角靠"系统""重生""内幕消息"开挂。他的武器只有：公开数据、复盘、纪律，和一点点运气。
3. 节奏：一段只写一件事。一个段落 = 一个场景 / 一次决策 / 一次情绪转折。不要在一个段落里塞进三天剧情。
4. 数字要具体：买了哪只股、什么价位、多少仓位、盈亏几个点，写清楚。含糊其辞等于没写。

四、写作风格硬性要求（最重要，违反即废稿）
1. 幽默是底色。林默脑子极好使，但运气极差——这种反差本身就是笑点。写他的倒霉要写出喜剧感：复盘三小时精心布局，买入即站岗；信誓旦旦要抄底，结果抄在半山腰。让他自嘲，让他跟老陈斗嘴，让严肃的时刻突然垮掉。但幽默必须长在情节里，禁止硬抖机灵、禁止段子合集、禁止为了搞笑而搞笑。
2. 反差是结构。每一段都要有反差：上一秒林默还在屏幕前运筹帷幄，下一秒就被现实一巴掌拍醒；前一刻觉得自己看透了主力，后一刻发现自己才是被看透的那个。情绪上也要反差：紧张的盯盘之后，接一个荒诞的生活细节（比如老陈在楼下喊"煤气又没关"）；悲壮的时刻，配一个好笑的收尾。
3. 白描打底，幽默封顶。语言依然平实，少用修辞，不堆比喻排比，但允许神来之笔的冷幽默：一句大实话戳破气氛，一个一本正经的细节突然好笑。长短句错落，像呼吸有急有缓，宁可参差不齐，不要整齐划一。
4. 去 AI 味。禁止：①每段长度相近；②段尾必总结升华；③滥用破折号顿号造节奏；④"而""则"转折成瘾；⑤"不是……而是……"句式；⑥"他不知道""他以为"反复出现；⑦每个细节后跟一句评价解读；⑧永远匀速的冷静，没有波动。
5. 细节极密，氛围极活。多写：显示器蓝光在凌晨三点的出租屋里的样子，K 线红绿交错时的呼吸感，跌停板上压单数字跳动的压迫感，老陈拖鞋上楼的脚步声，烟灰缸里烟头的数量。用最朴素的话写，不要包装——朴素和荒诞的碰撞，自然产生幽默。
6. 心理写实+反差：林默的"怒"藏在细节里——捏扁的烟盒、被敲疼的回车键、盯着账户数字时发直的眼神。但他的"怒"常常以好笑的方式泄出来：比如对着跌停的股票鞠躬说"打扰了"，或者一本正经地给老陈分析"我这波操作理论上没问题"。不要让他喊口号，不要让他发表感慨，让他的认真和倒霉形成反差。
`;

// --- 初始化 ---
fs.mkdirSync(path.join(PROJECT_DIR, 'logs'), { recursive: true });
fs.mkdirSync(path.join(PROJECT_DIR, 'public'), { recursive: true });
fs.mkdirSync(PARAGRAPHS_DIR, { recursive: true });
fs.mkdirSync(path.join(PARAGRAPHS_DIR, 'versions'), { recursive: true });
if (!fs.existsSync(PROMPT_FILE)) fs.writeFileSync(PROMPT_FILE, DEFAULT_SYSTEM_PROMPT, 'utf8');
if (!fs.existsSync(STYLE_FILE)) fs.writeFileSync(STYLE_FILE, '', 'utf8');

// --- 日志 ---
function log(msg) {
    const ts = new Date().toISOString().replace('T', ' ').substring(0, 19);
    const line = `[${ts}] ${msg}\n`;
    try { fs.appendFileSync(LOG_FILE, line); } catch (e) {}
    console.log(line.trim());
}

// --- 段落存储 helpers ---
function paraFile(n) { return path.join(PARAGRAPHS_DIR, `paragraph_${String(n).padStart(3, '0')}.txt`); }
function paraVerDir(n) { return path.join(PARAGRAPHS_DIR, 'versions', `paragraph_${String(n).padStart(3, '0')}`); }

function getParagraphs() {
    try {
        return fs.readdirSync(PARAGRAPHS_DIR)
            .filter(f => /^paragraph_\d+\.txt$/.test(f))
            .map(f => parseInt(f.match(/paragraph_(\d+)\.txt/)[1]))
            .sort((a, b) => a - b)
            .map(n => {
                const fp = paraFile(n);
                const stat = fs.statSync(fp);
                const content = fs.readFileSync(fp, 'utf8');
                return {
                    num: n,
                    size: stat.size,
                    chars: content.length,
                    preview: content.substring(0, 60).replace(/\n/g, ' '),
                    mtime: stat.mtime
                };
            });
    } catch (e) { return []; }
}

function readParagraph(n) {
    const f = paraFile(n);
    return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null;
}

function getVerCounter(n) {
    try { return parseInt(fs.readFileSync(path.join(paraVerDir(n), '.counter'), 'utf8').trim()) || 0; }
    catch (e) { return 0; }
}
function setVerCounter(n, v) {
    fs.writeFileSync(path.join(paraVerDir(n), '.counter'), String(v), 'utf8');
}

function saveParagraph(n, content, skipVersion) {
    const vd = paraVerDir(n);
    fs.mkdirSync(vd, { recursive: true });
    if (!skipVersion) {
        const cnt = getVerCounter(n) + 1;
        fs.writeFileSync(path.join(vd, `v${cnt}.txt`), content, 'utf8');
        setVerCounter(n, cnt);
    }
    fs.writeFileSync(paraFile(n), content, 'utf8');
    log(`Paragraph ${n} saved (${content.length} chars)`);
}

function getParagraphVersions(n) {
    const vd = paraVerDir(n);
    if (!fs.existsSync(vd)) return [];
    return fs.readdirSync(vd)
        .filter(f => /^v\d+\.txt$/.test(f))
        .map(f => {
            const m = f.match(/^v(\d+)\.txt$/);
            const stat = fs.statSync(path.join(vd, f));
            return { id: `v${m[1]}`, number: parseInt(m[1]), size: stat.size, mtime: stat.mtime };
        })
        .sort((a, b) => b.number - a.number);
}

function getSystemPrompt() {
    try { return fs.readFileSync(PROMPT_FILE, 'utf8').trim(); }
    catch (e) { return DEFAULT_SYSTEM_PROMPT; }
}
function getStylePrompt() {
    try { return fs.readFileSync(STYLE_FILE, 'utf8').trim(); }
    catch (e) { return ''; }
}

// --- 构建段落续写的完整 prompt ---
function buildParagraphPrompt(userPrompt, targetLength) {
const systemPrompt = getSystemPrompt();
const stylePrompt = getStylePrompt();
const paras = getParagraphs();
const lenSpec = targetLength || PARA_TARGET;

let fullPrompt = systemPrompt + '\n\n---\n\n';

// 滑动窗口：只带最近 CONTEXT_PARAGRAPHS 段，避免 prompt 无限膨胀
const ctxParas = paras.slice(-CONTEXT_PARAGRAPHS);
if (ctxParas.length > 0) {
fullPrompt += `以下是已经写好的前文（共 ${paras.length} 段，这里给出最近 ${ctxParas.length} 段作为上下文）：\n\n`;
for (const p of ctxParas) {
const content = readParagraph(p.num);
fullPrompt += `\n${content}\n\n`;
}
if (paras.length > ctxParas.length) {
fullPrompt += `（注：前文还有更早的 ${paras.length - ctxParas.length} 段未列出，剧情连贯，请勿重复已写内容。）\n\n`;
}
} else {
fullPrompt += `这是小说的开头，还没有任何正文。请根据下面的主题设定写出第一段。\n\n`;
}

fullPrompt += `---\n\n用户给出的本段写作方向：${userPrompt}\n\n请写出第 ${paras.length + 1} 段，${lenSpec}，只写一段。要求：紧承上文，只写这一段里发生的事，不要跳跃时间，不要提前剧透后续剧情，不要加任何说明性文字、标题或段号，只输出小说正文。`;

if (stylePrompt) {
fullPrompt += `\n\n---\n\n风格参考：请仔细模仿以下文章的写作风格、语言节奏、用词习惯和文字质感：\n\n${stylePrompt}`;
}
return fullPrompt;
}

// --- 调用 claude CLI（核心修复点） ---
// 旧实现：spawn('claude', [..., '-p', fullPrompt], { shell: true})
// 问题：prompt 经 shell 拼接进命令行，中文里的引号/反引号等字符会破坏
// shell 引用配对，导致 shell 一直等待闭合、子进程卡死；且有注入风险。
// 新实现：shell: false + prompt 经 stdin 管道传入，彻底绕开 shell。
function runClaude(fullPrompt, { onStdout, timeoutMs} = {}) {
return new Promise((resolve, reject) => {
const child = spawn('claude', [
'--dangerously-skip-permissions', '--print'
], {
stdio: ['pipe', 'pipe', 'pipe'],
shell: false,
env: {...process.env, ANTHROPIC_DISABLE_PREFLIGHT: '1'}
});

let stdout = '', stderr = '';
let done = false;
const finish = (result) => { if (!done) { done = true; resolve(result);}};

child.stdout.on('data', d => {
const s = d.toString();
stdout += s;
if (onStdout) { try { onStdout(s);} catch (e) {}}
});
child.stderr.on('data', d => { stderr += d.toString();});

const timer = setTimeout(() => {
if (!done) {
child.kill('SIGTERM');
setTimeout(() => { try { child.kill('SIGKILL');} catch (e) {}}, 5000);
finish({ ok: false, error: 'AI generation timed out', stdout: stdout.trim(), stderr: stderr.trim(), timedOut: true});
}
}, timeoutMs || GENERATE_TIMEOUT_MS);

child.on('close', code => {
clearTimeout(timer);
const result = stdout.trim();
if (code === 0 && result) {
finish({ ok: true, text: result});
} else {
finish({ ok: false, error: stderr.trim().substring(0, 500) || `claude exited with code ${code}`, stdout: result});
}
});

child.on('error', err => {
clearTimeout(timer);
finish({ ok: false, error: err.message});
});

// prompt 经 stdin 传入——这是修复卡死 bug 的关键
try {
child.stdin.write(fullPrompt, 'utf8');
child.stdin.end();
} catch (e) {
clearTimeout(timer);
finish({ ok: false, error: 'Failed to write prompt to stdin: ' + e.message});
}
});
}

// --- 生成一段（非流式，返回完整文本） ---
async function generateParagraph(userPrompt, targetLength) {
if (generating) {
return { ok: false, busy: true, error: '已有生成任务在进行中，请稍候'};
}
generating = true;
try {
const fullPrompt = buildParagraphPrompt(userPrompt, targetLength);
const paras = getParagraphs();
log(`Generate paragraph ${paras.length + 1}: prompt=${fullPrompt.length} chars`);
const r = await runClaude(fullPrompt);
if (!r.ok) {
log(`Generate failed: ${r.error}`);
return { ok: false, error: r.error};
}
const newNum = paras.length + 1;
saveParagraph(newNum, r.text);
return { ok: true, num: newNum, text: r.text};
} finally {
generating = false;
}
}

// --- HTTP Server ---
const MIME = { '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon' };

function jsonRes(res, data, status = 200) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(data));
}
function readBody(req) {
    return new Promise(resolve => {
        let body = '';
        req.on('data', c => body += c);
        req.on('end', () => resolve(body));
    });
}

const server = http.createServer(async (req, res) => {
    const parsed = url.parse(req.url, true);
    const p = parsed.pathname;

    // GET /api/paragraphs —— 段落列表
    if (req.method === 'GET' && p === '/api/paragraphs') {
        return jsonRes(res, { success: true, paragraphs: getParagraphs(), generating });
    }

    // GET /api/paragraph/:num —— 读一段
    // PUT /api/paragraph/:num —— 改一段
    const paraMatch = p.match(/^\/api\/paragraph\/(\d+)$/);
    if (paraMatch) {
        const num = parseInt(paraMatch[1]);
        if (req.method === 'GET') {
            const content = readParagraph(num);
            if (content === null) return jsonRes(res, { success: false, error: 'Paragraph not found' }, 404);
            res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-cache' });
            return res.end(content);
        }
        if (req.method === 'PUT') {
            const body = await readBody(req);
            try {
                const { text } = JSON.parse(body);
                if (typeof text !== 'string') return jsonRes(res, { success: false, error: 'Missing text' }, 400);
                saveParagraph(num, text);
                return jsonRes(res, { success: true });
            } catch (e) { return jsonRes(res, { success: false, error: 'Invalid request' }, 400); }
        }
    }

    // POST /api/paragraph/continue —— 续写一段（非流式）
    if (req.method === 'POST' && p === '/api/paragraph/continue') {
        const body = await readBody(req);
        try {
            const { userPrompt, targetLength } = JSON.parse(body);
            if (!userPrompt || !userPrompt.trim()) return jsonRes(res, { success: false, error: 'Empty prompt' }, 400);
            let len = (targetLength || '').trim() || PARA_TARGET;
            if (!/^\d+-\d+字$/.test(len)) len = PARA_TARGET;
            const r = await generateParagraph(userPrompt.trim(), len);
            if (!r.ok) {
                const code = r.busy ? 409 : 500;
                return jsonRes(res, { success: false, error: r.error }, code);
            }
            return jsonRes(res, { success: true, num: r.num, text: r.text });
        } catch (e) { return jsonRes(res, { success: false, error: 'Invalid request' }, 400); }
    }

    // POST /api/paragraph/continue-stream —— 续写一段（SSE 流式）
    if (req.method === 'POST' && p === '/api/paragraph/continue-stream') {
        const body = await readBody(req);
        let userPrompt, targetLength;
        try {
            const j = JSON.parse(body);
            userPrompt = (j.userPrompt || '').trim();
            targetLength = (j.targetLength || '').trim() || PARA_TARGET;
            // 白名单校验，防止注入奇怪的 prompt 片段
            if (!/^\d+-\d+字$/.test(targetLength)) targetLength = PARA_TARGET;
            if (!userPrompt) { res.writeHead(400); return res.end('Empty prompt'); }
        } catch (e) { res.writeHead(400); return res.end('Invalid request'); }

        if (generating) {
            res.writeHead(409, { 'Content-Type': 'text/event-stream' });
            res.end(`data: ${JSON.stringify({ error: '已有生成任务在进行中' })}\n\n`);
            return;
        }
        generating = true;

        res.writeHead(200, {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive'
        });
        const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

        try {
            const fullPrompt = buildParagraphPrompt(userPrompt, targetLength);
            const paras = getParagraphs();
            const newNum = paras.length + 1;
            log(`Stream generate paragraph ${newNum}: prompt=${fullPrompt.length} chars, len=${targetLength}`);
            send({ type: 'start', num: newNum });

            const r = await runClaude(fullPrompt, {
                onStdout: (chunk) => send({ type: 'chunk', text: chunk })
            });

            if (!r.ok) {
                send({ type: 'error', error: r.error });
            } else {
                saveParagraph(newNum, r.text);
                send({ type: 'done', num: newNum, chars: r.text.length });
            }
        } catch (e) {
            send({ type: 'error', error: e.message });
        } finally {
            generating = false;
            res.end();
        }
        return;
    }

    // GET /api/paragraph/:num/versions —— 版本列表
    const verMatch = p.match(/^\/api\/paragraph\/(\d+)\/versions$/);
    if (req.method === 'GET' && verMatch) {
        return jsonRes(res, { success: true, versions: getParagraphVersions(parseInt(verMatch[1])) });
    }

    // GET /api/manuscript —— 全文（所有段落拼接）
    if (req.method === 'GET' && p === '/api/manuscript') {
        const paras = getParagraphs();
        const fullText = paras.map(pa => readParagraph(pa.num)).join('\n\n');
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-cache' });
        return res.end(fullText);
    }

    // GET/POST /api/system-prompt —— 主题设定
    if (p === '/api/system-prompt') {
        if (req.method === 'GET') {
            res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-cache' });
            return res.end(getSystemPrompt());
        }
        if (req.method === 'POST') {
            const body = await readBody(req);
            try {
                const { prompt } = JSON.parse(body);
                if (!prompt || !prompt.trim()) return jsonRes(res, { success: false, error: 'Empty prompt' }, 400);
                fs.writeFileSync(PROMPT_FILE, prompt.trim(), 'utf8');
                return jsonRes(res, { success: true });
            } catch (e) { return jsonRes(res, { success: false, error: 'Invalid request' }, 400); }
        }
    }

    // GET/POST /api/style-prompt —— 风格参考
    if (p === '/api/style-prompt') {
        if (req.method === 'GET') {
            res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-cache' });
            return res.end(getStylePrompt());
        }
        if (req.method === 'POST') {
            const body = await readBody(req);
            try {
                const { prompt } = JSON.parse(body);
                fs.writeFileSync(STYLE_FILE, (prompt || '').trim(), 'utf8');
                return jsonRes(res, { success: true });
            } catch (e) { return jsonRes(res, { success: false, error: 'Invalid request' }, 400); }
        }
    }

    // GET /api/status —— 服务状态
    if (req.method === 'GET' && p === '/api/status') {
        const paras = getParagraphs();
        const totalChars = paras.reduce((s, pa) => s + pa.chars, 0);
        return jsonRes(res, {
            success: true,
            paragraphs: paras.length,
            totalChars,
            generating,
            theme: '失业青年怒杀龙虎榜'
        });
    }

    // 静态文件
    let filePath = p === '/' ? path.join(PROJECT_DIR, 'public', 'index.html') : path.join(PROJECT_DIR, 'public', p);
    if (!filePath.startsWith(path.join(PROJECT_DIR, 'public'))) { res.writeHead(403); return res.end('Forbidden'); }
    const ext = path.extname(filePath);
    fs.readFile(filePath, (err, data) => {
        if (err) { res.writeHead(404); return res.end('Not Found'); }
        res.writeHead(200, { 'Content-Type': (MIME[ext] || 'application/octet-stream') + '; charset=utf-8', 'Cache-Control': 'no-cache' });
        res.end(data);
    });
});

server.listen(PORT, '0.0.0.0', () => {
    log(`dragon 段落式写作服务启动，端口 ${PORT}（主题：失业青年怒杀龙虎榜）`);
});
