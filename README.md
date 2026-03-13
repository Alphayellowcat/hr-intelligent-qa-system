# HR 智能问答系统

[![Ask DeepWiki](https://deepwiki.com/badge.svg)](https://deepwiki.com/Alphayellowcat/hr-intelligent-qa-system)
[![license](https://img.shields.io/github/license/Alphayellowcat/hr-intelligent-qa-system)](https://github.com/Alphayellowcat/hr-intelligent-qa-system/blob/main/LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-18+-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.8-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![React](https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=black)](https://react.dev/)
[![Vite](https://img.shields.io/badge/Vite-6-646CFF?logo=vite&logoColor=white)](https://vitejs.dev/)
[![LanceDB](https://img.shields.io/badge/LanceDB-向量库-00D9FF)](https://lancedb.com/)
[![OpenAI](https://img.shields.io/badge/OpenAI-Compatible-412991?logo=openai&logoColor=white)](https://platform.openai.com/)
[![中文](https://img.shields.io/badge/语言-中文-red)]()

基于大语言模型的医院人力资源智能问答系统，支持 24 小时自助问答、政策解读、入职引导、职业规划等功能。

## 功能模块

- **24小时HR自助问答** - 薪资福利、休假政策、职称评审等常见问题
- **智能入职引导** - 新员工了解医院文化、规章制度、工作流程
- **政策快速解读** - 人力资源政策简化解释，提高理解效率
- **职业发展路径规划** - 个性化职业成长建议与能力提升方案
- **合规与制度解答** - 劳动法规、合规要求、制度查询

## 技术栈

- 前端：React + Vite + Tailwind CSS
- 后端：Express + SQLite
- 向量库：LanceDB（本地 `.lancedb/`）
- LLM：OpenAI 兼容 API（默认 SiliconFlow）

## 快速开始

**环境要求：** Node.js 18+

1. 安装依赖：

   ```bash
   npm install
   ```

2. 启动应用：

   ```bash
   npm run dev
   ```

3. 首次使用：登录 admin 账户后，在「设置」页面配置 API 地址和 API Key。

## 生产部署与高并发

- **单进程**：`npm run start`（默认）
- **Cluster 多进程**：`npm run start:cluster`，按 CPU 核数 fork 多个 worker，提升并发能力
- **限流**：API 全局限流 200 次/分钟；LLM 30 次/分钟；Embedding/语义检索 60 次/分钟
- **请求队列**：外部 LLM/Embedding 调用经队列限流，降低 429 风险
- **SQLite**：启用 WAL 模式，提升多读并发；`busy_timeout = 5000` 减少锁冲突

## 默认账户

| 账户   | 初始密码   | 角色   |
|--------|--------|--------|
| admin  | admin123 | 管理员 |
| employee | emp123 | 普通员工 |

**安全说明：** 管理员（admin）首次登录时系统会强制要求修改密码，修改后才能继续使用。可通过环境变量 `ADMIN_INITIAL_PASSWORD` 自定义 admin 的初始密码（首次部署前设置）。

---

## 知识库维护（管理员）

问答系统基于 `knowledge/` 目录下的 Markdown 文件进行检索与回答。管理员可通过**页面维护**或**直接操作文件**两种方式维护知识库。

### 方式一：页面维护

使用 admin 账户登录后，进入「知识库管理」页面。

#### 编辑现有文档

1. 在左侧文件树中点选要编辑的文档
2. 切换「预览」/「手动编辑」查看或修改内容
3. 在「手动编辑」模式下修改后，点击「保存修改」

#### 使用 AI 辅助修改或新建

1. 在右侧「AI 辅助修改」区域填写修改指令，例如：
   - 修改：「将年假天数统一增加 2 天」
   - 新建：「根据上传的文件新建一份居家办公制度」
2. 可选：点击「上传文本文件」上传 .txt / .md / .csv 作为参考
3. 点击「生成修改草稿」
4. 预览 AI 生成内容，或对比「AI 修改对比」中的差异
5. 点击「接受新建/修改」保存，或「拒绝」丢弃

新建文档时，AI 会建议存放文件夹（如 `规章制度`、`员工手册`）和文件名（.md）。

### 方式二：直接操作文件

知识库位于项目根目录下的 `knowledge/` 文件夹，按「文件夹 / .md 文件」组织。

**目录结构示例：**

```
knowledge/
├── 规章制度/
│   ├── 休假制度.md
│   └── 薪资福利.md
└── 员工手册/
    └── 入职指南.md
```

**新建文件夹：** 在 `knowledge/` 下创建新目录即可，刷新页面后会出现在左侧文件树中。

**新建或修改文档：** 在对应文件夹下创建或编辑 `.md` 文件，使用 UTF-8 编码。仅 `.md` 文件会被系统读取。

**删除：** 直接删除文件或整个文件夹。空文件夹不会出现在列表中。

修改后刷新页面即可生效，无需重启服务。

### 向量索引（语义检索）

语义检索依赖本地向量库（LanceDB）。首次使用或知识库变更后需建立/更新索引：

- **自动触发**：在知识库管理页面保存文档后，会自动进行增量索引
- **手动触发**：在知识库管理页面左侧点击「索引向量」按钮
- **增量索引**：仅对新增或内容变更的段落重新 embedding，未变更的内容会被跳过
