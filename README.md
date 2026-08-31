# ZCode Token 用量实时统计仪表盘

监控 ZCode（智谱计划 / 火山方舟网关等所有供应商）的 Token 实时用量，界面包含「使用统计」与「模型设置」两个页面。

**零依赖、零侵入**：只读 ZCode 本地 SQLite 数据库，不写 ZCode 任何文件，不需要 Docker / 数据库 / npm install。

## 快速开始

- 双击 `启动仪表盘.bat`，或命令行运行：

  ```bash
  npm start        # 即 node server/index.ts
  ```

- 浏览器打开 **http://127.0.0.1:5323**

要求：Node.js ≥ 22.5（用到内置 `node:sqlite`）。可用环境变量 `PORT` / `HOST` / `ZCODE_DB` 覆盖端口、监听地址、数据库路径。

## 功能

### 使用统计（每 2 秒自动刷新，SSE 实时推送）

- 5 张统计卡：累计 Token 数、峰值 Token 数（单日最高）、最长聊天时长、当前连续天数、最长连续天数
- Token 活动：GitHub 风格热力图（近 12 个月），支持 每日 / 每周 / 累计 切换
- 每日 Token 趋势图：按模型多色折线，近 7 日 / 近 30 日
- 模型用量：环形图 + 按模型明细（tokens、占比）
- 导出 CSV（按所选时间范围导出逐日 × 供应商 × 模型明细，含估算成本）

### 模型设置

- 供应商列表（自动读取 ZCode 配置 + 用量记录中发现的供应商，支持重命名）
- 网关总额度：供应商级每日额度（全模型共享，如火山方舟网关 8000 万 tokens/日），实时显示**剩余 tokens 与剩余百分比**，浏览器标签页标题同步显示（如「ZCode用量 · 火山方舟 Ark剩余91.3%」）
- 今日余额：每模型进度条（今日已用 / 每日额度，额度点击可编辑，≥90% 黄色、≥100% 红色）
- 模型列表：上下文长度（1M）、视觉 标签
- 价格设置：输入/输出单价（¥/百万 tokens），用于成本估算与 CSV 导出

## 数据来源与统计口径

- 数据源：`~/.zcode/cli/db/db.sqlite` 的 `model_usage` / `turn_usage` / `session` 表（WAL 只读连接）
- Token 口径：`input_tokens + output_tokens`（与 ZCode 自身的 `computed_total_tokens` 一致）；缓存读写另列于 CSV
- 只统计 `status='completed'` 的请求；error/cancelled 请求单独计数不占用量
- 「今日余额」支持两级额度（均保存在 `data/settings.json`）：供应商总额度 `providerQuotas`（如火山方舟网关 8000万/日，全模型共享）与单模型额度 `quotas`；已用部分来自本地统计，智谱/方舟服务端真实配额无公开接口
- 方舟网关的自定义供应商在数据库里以 UUID 出现，通过 `data/settings.json` 的 `providerAliases` 显示为「火山方舟 Ark」

## 目录结构

```
server/
  index.ts      HTTP 服务、REST/SSE 接口、静态托管
  db.ts         只读 SQLite 访问与聚合查询
  providers.ts  供应商元数据（只读 config.json，绝不读取 apiKey）
  settings.ts   额度/价格/别名设置（data/settings.json）
web/
  index.html / style.css / app.js
  vendor/echarts.min.js
data/
  settings.json 首次运行自动生成
启动仪表盘.bat
```

## 常见问题

- **提示未找到数据库**：确认 ZCode 已在本机运行过；或设置环境变量 `ZCODE_DB` 指向 `.zcode/cli/db/db.sqlite`。
- **数据库被锁**：ZCode 使用 WAL 模式，正常可并发只读；极少数情况下（WAL 需恢复）会退回普通打开，本服务自身不写任何业务表。
- **端口冲突**：`PORT=5324 npm start`。
- **服务端真实额度**：智谱计划的"今日余额"数字与 ZCode 桌面端可能不同——桌面端读的是服务端配额，本仪表盘是本地统计 + 手动额度，属预期差异。
