# 心情 · 记忆小窗（独立查看器）

一个**零依赖**的本地小窗：读一个 JSON 状态文件，用浏览器看心情、七维、重要/普通条目、群友印象。

不依赖任何服务器、不联网、不需要 Node 之外的任何东西。

```
tools/viewer/
├── server.mjs        本地 HTTP 服务（Node 内置模块）
├── viewer.html       界面（可折叠四块）
├── demo-state.json   示例数据，跑起来就能看
└── 启动小窗.bat      Windows 双击启动（用 demo 数据）
```

## 一、最快用法

```bash
node tools/viewer/server.mjs --file tools/viewer/demo-state.json --open
```

会自动打开 <http://127.0.0.1:3310/>。

参数：

| 参数 | 说明 |
| --- | --- |
| `--file <路径>` | 必填，状态 JSON 文件 |
| `--port <端口>` | 默认 3310 |
| `--open` | 启动后自动打开浏览器 |

不想用命令行：双击 `启动小窗.bat`（默认读 demo 数据）。

## 二、数据格式

小窗只需要一个 JSON。**推荐用这个通用格式**（字段少、好生成）：

```json
{
  "conversations": {
    "private:10001": {
      "mood": {
        "total": 76.4,
        "dims": { "开心": 3.1, "踏实": 1.2, "甜蜜": 2.4, "心疼": 0, "担心": 0.6, "难过": 0, "吃醋": 0.9 }
      },
      "memory": {
        "importantTopics": [
          { "text": "他答应下周三之前把稿子看完", "keys": ["稿子", "下周三"], "mentions": 3, "lastMentionAt": 1793099000000 }
        ],
        "activeTopics": [
          { "text": "楼下新开了家火锅店", "keys": ["火锅店"], "mentions": 1, "lastMentionAt": 1793098000000 }
        ],
        "memberImpressions": {
          "阿橙": { "traits": ["嘴硬但心软", "做后端的"], "interactionCount": 14, "lastSeenAt": 1793099500000 }
        }
      }
    }
  }
}
```

字段说明：

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `conversations` | ✅ | 键是会话名（随便起，界面里会显示） |
| `mood.total` | 否 | 0~100；没有就显示“无数据” |
| `mood.dims` | 否 | 七维：开心 / 踏实 / 甜蜜 / 心疼 / 担心 / 难过 / 吃醋 |
| `memory.importantTopics` | 否 | 重要条目（长期记得） |
| `memory.activeTopics` | 否 | 普通条目（会随时间衰减） |
| `memory.memberImpressions` | 否 | 群友印象：`traits` 字符串数组 |
| `text` / `keys` / `mentions` / `lastMentionAt` | 否 | 条目的四个可选字段 |

时间戳用**毫秒**（`Date.now()`），界面会显示“3 分钟前 / 2 天前”。

## 三、从你的程序里导出

如果用的是本包的 `createMemory` / 心情模块，把状态直接吐成上面那个形状就行：

```js
import fs from 'node:fs';
import { createMemory, snapshot } from 'mood-memory';

const mem = createMemory({});
const st = { activeTopics: [], importantTopics: [], pendingThoughts: [], memberImpressions: {} };

// …正常运行，st 里就有记忆；心情存在你自己的 st.mood 里

setInterval(() => {
  fs.writeFileSync('./state.json', JSON.stringify({
    conversations: {
      'private:me': {
        mood: snapshot(st),                    // 给 { total, dims }
        memory: {
          importantTopics: st.importantTopics,
          activeTopics: st.activeTopics,
          memberImpressions: st.memberImpressions
        }
      }
    }
  }, null, 2));
}, 5000);
```

小窗每 5 秒重新读文件，导出的文件一更新界面就跟着变。

## 四、兼容 qq-bridge 的 state 文件

如果你用的是 qq-bridge（容器字段平铺在会话上），也能直接读，不用转换：

```bash
node tools/viewer/server.mjs --file "C:/path/to/qq-bridge/state/social-v2.json" --open
```

自动识别：顶层没有 `memory` 字段时，会直接读 `importantTopics` / `activeTopics` / `memberImpressions`。

## 五、界面说明

| 区块 | 内容 |
| --- | --- |
| 心情 · 七维 | 总分 / 档位 / 七根条；到阈值的变黄加粗；底部可展开参数表 |
| 重要条目 | 内容 + 核心词 + 提过几次 + 多久前 |
| 普通条目 | 同上 |
| 印象 | 每人：互动次数、最后见面时间、属性列表 |

四块都能点标题折叠，状态记在浏览器里；右下角可一键全收/全展。
