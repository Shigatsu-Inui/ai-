# 贡献指南

先谢谢你愿意花时间。这个项目很小，规矩也简单。

## 目录结构

```
src/mood.js      心情系统（一个文件，别拆太碎）
src/memory.js    记忆系统（同上）
src/index.js     统一出口
lib/index.js     DSH 插件入口（只做挂载，不放业务逻辑）
bench/           测试脚本（纯 Node，不用框架）
```

## 改代码前

1. 先跑一遍测试，确认基线是绿的：

   ```bash
   node bench/run-all.mjs
   ```

2. 想改行为，优先改 `src/mood.js` 顶部的 `DEFAULTS` 对象，不要散落魔法数字。

## 提 PR 时

- **必须**让 `node bench/run-all.mjs` 通过
- 改动行为的话，**新加一个测试用例**，并在 PR 描述里说明为什么
- 只改文档/注释可以直接提
- 改公共 API 的签名要先开 issue 讨论

## 代码风格

- ESM，`export function`，不用 class
- 两空格缩进，单引号，行尾不留空格（`.editorconfig` 已配）
- 中文注释可以，但**术语保持一致**（"七维"、"总分"、"衰减"、"核心词"）
- 函数超过 60 行就考虑拆
- 不引入运行时依赖 —— 这个包的卖点就是零依赖，请保持

## 提 issue 时请附上

- Node 版本
- 复现步骤（最好是一段能直接跑的最小代码）
- 期望行为 vs 实际行为

## 不做什么

- 不接模型 API（这个包的目标是"纯本地"，需要模型能力的地方请由调用方注入）
- 不加 UI / 不加配置界面
- 不做多语言（注释和提示词是中文的，为中文语境设计）

## 发布流程（维护者）

1. 更新 `CHANGELOG.md`
2. `npm version patch|minor|major`
3. `node bench/run-all.mjs` 确认全绿
4. `npm publish`
