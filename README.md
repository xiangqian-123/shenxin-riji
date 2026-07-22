# 向前大哥 · 颈椎AI助手

一个基于 AI 对话的颈椎健康助手。不是医生，是走过这条路的亲历者。

## 快速启动

```bash
# 1. 安装依赖
npm install

# 2. 配置 API Key
cp .env.example .env
# 编辑 .env，填入你的 DeepSeek API Key
# 获取 Key: https://platform.deepseek.com

# 3. 启动
npm start

# 4. 打开浏览器
# http://localhost:3000
```

## 项目结构

```
├── server.js           # Node.js 后端
├── system-prompt.md    # 核心 AI Prompt（产品核心资产）
├── public/
│   └── index.html      # H5 聊天前端
├── data/               # 用户对话数据（自动生成）
├── package.json
├── .env                # API 配置（不入库）
└── README.md
```

## 技术栈

- 后端：Node.js + Express
- AI：DeepSeek API（国内直接访问）
- 存储：JSON 文件（MVP阶段）
- 前端：单页 HTML（移动优先）

## 部署

可以部署到 Railway / Render / 自有服务器。

不需要 ICP 备案（服务器不在中国大陆即可）。
