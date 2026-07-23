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
const INVITE_FILE = path.join(__dirname, 'invite-codes.json');
const MAX_MESSAGE_LENGTH = 500; // 单次消息最长500字

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
// 加载邀请码
// ============================================================
function loadInviteCodes() {
  return JSON.parse(fs.readFileSync(INVITE_FILE, 'utf-8'));
}

function saveInviteCodes(data) {
  fs.writeFileSync(INVITE_FILE, JSON.stringify(data, null, 2), 'utf-8');
}

// ============================================================
// 简易 JSON 文件存储
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
      messageCount: 0,
      inviteCode: '',
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
// 话题守卫：快速判断是否跟身心/颈椎健康相关
// ============================================================
const TOPIC_GUARD_WORDS = [
  // 正面词（允许聊的）
  '脖子', '颈', '肩', '背', '腰', '脊柱', '脊椎', '头', '疼', '痛', '酸', '胀', '麻', '僵',
  '不舒服', '难受', '累', '疲劳', '睡', '枕头', '显示器', '坐', '站', '姿势', '体态',
  '运动', '锻炼', '拉伸', '热敷', '冷敷', '按摩', '推拿', '牵引', '康复', '理疗',
  '身体', '状态', '感觉', '情绪', '压力', '焦虑', '放松', '呼吸', '气血',
  '颈椎', '腰椎', '关节', '肌肉', '骨骼', '神经',
  '记录', '日记', '变化', '规律', '习惯', '好多了', '严重',
  '拍片', '检查', '诊断', '医生', 'X光', 'CT', '核磁', '曲度',
  '头晕', '恶心', '手麻', '手指', '手臂', '肩膀',
  '饮食', '调理', '养生', '健康',
];
const TOPIC_BLOCK_WORDS = [
  // 明显无关的话题
  '股票', '基金', '投资', '买房', '买车', '谈恋爱', '相亲', '游戏攻略',
  '编程', '代码', '数学', '英语', '考试', '面试', '简历',
  '天气', '新闻', '政治', '明星', '八卦',
];

function isOnTopic(message) {
  const msg = message.toLowerCase();
  // 先检查屏蔽词
  for (const w of TOPIC_BLOCK_WORDS) {
    if (msg.includes(w)) return false;
  }
  // 再检查允许词
  for (const w of TOPIC_GUARD_WORDS) {
    if (msg.includes(w)) return true;
  }
  // 没有匹配到任何关键词，放行（可能是延续上文的正常对话）
  return true;
}

// ============================================================
// 构建发送给 API 的消息列表
// ============================================================
function buildMessages(userData, newMessage, withProfile) {
  const messages = [{ role: 'system', content: SYSTEM_PROMPT }];

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

  const recentMessages = userData.messages.slice(-20);
  for (const msg of recentMessages) {
    messages.push({ role: msg.role, content: msg.content });
  }

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
  const msg = data.choices[0].message;
  return msg.content || '';
}

// ============================================================
// 更新用户画像
// ============================================================
async function updateProfile(userData) {
  const recent = userData.messages.slice(-6);
  if (recent.length < 2) return;

  const analysisPrompt = `基于以下对话记录，提取用户的关键信息，只返回 JSON，不要其他内容：

{
  "problemType": "用户的核心问题类型",
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
    const jsonMatch = result.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      Object.assign(userData.profile, parsed);
    }
  } catch (e) {
    console.error('画像更新失败:', e.message);
  }
}

// ============================================================
// API：验证邀请码
// ============================================================
app.post('/api/verify-code', (req, res) => {
  const { code, userId } = req.body;
  if (!code || !userId) {
    return res.json({ ok: false, error: '请输入邀请码和用户名' });
  }

  const data = loadInviteCodes();
  const codeInfo = data.codes[code.toUpperCase().trim()];

  if (!codeInfo) {
    return res.json({ ok: false, error: '邀请码无效' });
  }

  if (codeInfo.usedBy.length >= codeInfo.maxUses) {
    return res.json({ ok: false, error: '该邀请码已被使用完' });
  }

  if (codeInfo.usedBy.includes(userId)) {
    return res.json({ ok: true, message: '你已经验证过了', limit: data.messageLimit });
  }

  // 绑定邀请码给用户
  codeInfo.usedBy.push(userId);
  saveInviteCodes(data);

  // 初始化用户数据
  const userData = loadUser(userId);
  userData.inviteCode = code.toUpperCase().trim();
  userData.messageLimit = data.messageLimit;
  saveUser(userId, userData);

  res.json({
    ok: true,
    message: '验证成功',
    limit: data.messageLimit,
  });
});

// ============================================================
// API：聊天
// ============================================================
app.post('/api/chat', async (req, res) => {
  const { userId, message } = req.body;

  if (!userId || !message) {
    return res.status(400).json({ error: '缺少 userId 或 message' });
  }

  // 单次消息长度限制
  if (message.length > MAX_MESSAGE_LENGTH) {
    return res.json({
      reply: `每次对话最长${MAX_MESSAGE_LENGTH}个字哦。你刚才发了${message.length}个字，精简一下再发吧。`,
      remaining: 0,
      limit: 0,
    });
  }

  // 加载用户
  const userData = loadUser(userId);

  // 检查用量限制
  const inviteData = loadInviteCodes();
  const limit = userData.messageLimit || inviteData.messageLimit || 100;
  if (userData.messageCount >= limit) {
    return res.json({
      reply: `你的内测对话次数（${limit}条）已用完。感谢参与内测！如果想继续使用，请联系向前大哥获取更多次数。`,
      remaining: 0,
      limit,
    });
  }

  // 话题守卫
  if (!isOnTopic(message)) {
    userData.messageCount++;
    saveUser(userId, userData);
    return res.json({
      reply: '我是身心觉察助手，专门聊身体状态、颈椎健康和日常觉察相关的话题。你最近身体有什么感觉想记录吗？',
      remaining: limit - userData.messageCount,
      limit,
    });
  }

  try {
    const hasProfile = !!userData.profile.problemType;
    const messages = buildMessages(userData, message, hasProfile);
    const reply = await callAI(messages);

    // 保存对话
    userData.messages.push({ role: 'user', content: message, time: new Date().toISOString() });
    userData.messages.push({ role: 'assistant', content: reply, time: new Date().toISOString() });
    userData.messageCount++;

    // 每 3 轮对话更新一次画像
    if (userData.messages.length % 6 === 0) {
      await updateProfile(userData);
    }

    saveUser(userId, userData);

    res.json({
      reply,
      remaining: limit - userData.messageCount,
      limit,
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
// API：获取用户状态
// ============================================================
app.get('/api/user-status/:userId', (req, res) => {
  const userData = loadUser(req.params.userId);
  const inviteData = loadInviteCodes();
  const limit = userData.messageLimit || inviteData.messageLimit || 100;
  res.json({
    userId: userData.userId,
    messageCount: userData.messageCount,
    remaining: Math.max(0, limit - userData.messageCount),
    limit,
    hasCode: !!userData.inviteCode,
    createdAt: userData.createdAt,
  });
});

// ============================================================
// API：健康检查
// ============================================================
app.get('/api/health', (req, res) => {
  const inviteData = loadInviteCodes();
  res.json({
    status: 'ok',
    model: MODEL,
    hasKey: !!API_KEY,
    users: fs.readdirSync(DATA_DIR).length,
    activeCodes: Object.values(inviteData.codes).filter(c => c.usedBy.length < c.maxUses).length,
  });
});

// ============================================================
// 启动
// ============================================================
app.listen(PORT, () => {
  const inviteData = loadInviteCodes();
  const activeCodes = Object.values(inviteData.codes).filter(c => c.usedBy.length < c.maxUses).length;
  console.log(`📔 身心日记 已启动`);
  console.log(`   http://localhost:${PORT}`);
  console.log(`   API: ${API_KEY ? '✅ 已配置' : '⚠️ 未配置 DEEPSEEK_API_KEY'}`);
  console.log(`   可用邀请码: ${activeCodes} 个`);
  console.log(`   每用户对话上限: ${inviteData.messageLimit} 条`);
  console.log(`   数据目录: ${DATA_DIR}`);
});
