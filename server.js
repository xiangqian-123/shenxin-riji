const express = require('express');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

const app = express();
app.use(express.json());
app.use(express.static('public'));

// ============================================================
// 配置
// ============================================================
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.DEEPSEEK_API_KEY || '';
const API_BASE = process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com/v1';
const MODEL = 'deepseek-reasoner';
const DATA_DIR = path.join(__dirname, 'data');

// 确保数据目录存在
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// ============================================================
// 加载 System Prompt
// ============================================================
const SYSTEM_PROMPT = fs.readFileSync(
  path.join(__dirname, 'system-prompt.md'),
  'utf-8'
);

// ============================================================
// 简易 JSON 文件存储（MVP 阶段，后续可换数据库）
// ============================================================
function getUserFile(userId) {
  const safe = Buffer.from(userId, 'utf-8').toString('hex').slice(0, 32);
  return path.join(DATA_DIR, `${safe}.json`);
}

function loadUser(userId) {
  const file = getUserFile(userId);
  if (!fs.existsSync(file)) {
    return {
      userId,
      messages: [],
      profile: {
        problemType: '',
        painLocation: '',
        effectiveMethods: [],
        pitfalls: [],
        emotionalStage: '',
        reminders: '',
        dayCount: 0,
      },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }
  return JSON.parse(fs.readFileSync(file, 'utf-8'));
}

function saveUser(userId, data) {
  const file = getUserFile(userId);
  data.updatedAt = new Date().toISOString();
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf-8');
}

// ============================================================
// 构建发送给 API 的消息列表（带上下文管理）
// ============================================================
function buildMessages(userData, newMessage, withProfile) {
  const messages = [{ role: 'system', content: SYSTEM_PROMPT }];

  // 注入用户画像（帮助 AI 快速回忆）
  if (withProfile && userData.profile.problemType) {
    messages.push({
      role: 'system',
      content: `[以下是该用户的已知画像，请基于此画像进行对话]
- 核心问题类型：${userData.profile.problemType || '待确认'}
- 疼痛位置：${userData.profile.painLocation || '待确认'}
- 已验证有效的方法：${userData.profile.effectiveMethods?.join('、') || '暂无'}
- 踩过的坑：${userData.profile.pitfalls?.join('、') || '暂无'}
- 情绪阶段：${userData.profile.emotionalStage || '待确认'}
- 已记录天数：${userData.profile.dayCount || 0}天
- 下次应提醒：${userData.profile.reminders || '无'}
[画像结束，开始对话]`,
    });
  }

  // 取最近 20 条历史消息（保留上下文但不超出 token 限制）
  const recentMessages = userData.messages.slice(-20);

  // 如果是同一天的多条消息，合并为一段上下文
  for (const msg of recentMessages) {
    messages.push({ role: msg.role, content: msg.content });
  }

  // 添加当前用户消息
  messages.push({ role: 'user', content: newMessage });

  return messages;
}

// ============================================================
// 调用 DeepSeek API
// ============================================================
async function callAI(messages) {
  if (!API_KEY) {
    throw new Error('API_KEY 未配置，请设置 DEEPSEEK_API_KEY 环境变量');
  }

  const response = await fetch(`${API_BASE}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${API_KEY}`,
    },
    body: JSON.stringify({
      model: MODEL,
      messages,
      max_tokens: 4096,
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`API 调用失败 (${response.status}): ${err}`);
  }

  const data = await response.json();
  // deepseek-reasoner 返回 reasoning_content（内部推理）+ content（最终回复）
  // 我们只取 content 作为对用户的回复
  const msg = data.choices[0].message;
  return msg.content || '';
}

// ============================================================
// 更新用户画像（AI 回复后自动分析更新）
// ============================================================
async function updateProfile(userData) {
  // 取最近几轮对话，让 AI 提取画像信息
  const recent = userData.messages.slice(-6);
  if (recent.length < 2) return;

  const analysisPrompt = `基于以下对话记录，提取用户的关键信息，只返回 JSON，不要其他内容：

{
  "problemType": "用户的核心问题类型（如：久坐型颈肩劳损/姿势性颈椎不适/睡眠相关肌紧张/不确定）",
  "painLocation": "疼痛位置描述",
  "effectiveMethods": ["已对用户有效的方法"],
  "pitfalls": ["用户踩过的坑或错误做法"],
  "emotionalStage": "积极自救/反复沮丧/即将放弃/稳定维持/初次了解",
  "reminders": "下次聊应该提醒用户什么",
  "dayCount": 记录天数,
  "updateSummary": "一句话总结本次更新了什么"
}

对话记录：
${recent.map((m) => `${m.role}: ${m.content}`).join('\n')}

只返回JSON：`;

  try {
    const messages = [
      { role: 'system', content: '你是一个数据分析助手。只返回JSON，不要其他内容。' },
      { role: 'user', content: analysisPrompt },
    ];
    const result = await callAI(messages);
    // 尝试解析 JSON
    const jsonMatch = result.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      Object.assign(userData.profile, parsed);
    }
  } catch (e) {
    // 画像更新失败不影响主流程
    console.error('画像更新失败:', e.message);
  }
}

// ============================================================
// API：聊天
// ============================================================
app.post('/api/chat', async (req, res) => {
  const { userId, message } = req.body;

  if (!userId || !message) {
    return res.status(400).json({ error: '缺少 userId 或 message' });
  }

  try {
    // 加载用户数据
    const userData = loadUser(userId);
    const hasProfile = !!userData.profile.problemType;

    // 构建消息
    const messages = buildMessages(userData, message, hasProfile);

    // 调用 AI
    const reply = await callAI(messages);

    // 保存对话
    userData.messages.push({ role: 'user', content: message, time: new Date().toISOString() });
    userData.messages.push({ role: 'assistant', content: reply, time: new Date().toISOString() });

    // 每 3 轮对话更新一次画像
    if (userData.messages.length % 6 === 0) {
      await updateProfile(userData);
    }

    saveUser(userId, userData);

    res.json({
      reply,
      profile: hasProfile ? userData.profile : null,
      dayCount: userData.profile.dayCount || Math.floor(userData.messages.length / 2),
    });
  } catch (error) {
    console.error('Chat error:', error);
    res.status(500).json({
      error: '抱歉，我暂时无法回复。请稍后再试。',
      detail: error.message,
    });
  }
});

// ============================================================
// API：获取用户画像（调试/后台用）
// ============================================================
app.get('/api/profile/:userId', (req, res) => {
  const userData = loadUser(req.params.userId);
  res.json({
    userId: userData.userId,
    profile: userData.profile,
    messageCount: userData.messages.length,
    createdAt: userData.createdAt,
    updatedAt: userData.updatedAt,
  });
});

// ============================================================
// API：健康检查
// ============================================================
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    model: MODEL,
    hasKey: !!API_KEY,
    users: fs.readdirSync(DATA_DIR).length,
  });
});

// ============================================================
// 启动
// ============================================================
app.listen(PORT, () => {
  console.log(`📔 身心日记 已启动`);
  console.log(`   http://localhost:${PORT}`);
  console.log(`   API: ${API_KEY ? '✅ 已配置' : '⚠️ 未配置 DEEPSEEK_API_KEY'}`);
  console.log(`   数据目录: ${DATA_DIR}`);
});
