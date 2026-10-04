# 测试数据

手工验证用的导入样例，**不是**单元测试的 fixture 目录（除了 `test-bulk.csv` —— 它被
`tests/portable.test.ts` 直接读来做解析器回归，改它会连带改测试断言）。

| 文件 | 条数 | 目标格式 | 主要用来验 |
|---|---|---|---|
| `test-bulk.csv` | 80 | 通用明文 CSV | **批量删除**：分组筛选 → 全选 → Shift 区间 → 二次确认 |
| `test-plain.csv` | 7 | 通用明文 CSV | 四种类型往返（login/note/bank/id）、引号转义、emoji |
| `test-bitwarden.csv` | 6 | Bitwarden CSV | 官方表头、含逗号/引号的备注、TOTP、note 类型 |
| `test-chrome.csv` | 4 | Chrome / Edge CSV | 浏览器导出格式（无分组、无类型列） |

## test-bulk.csv 的设计意图

数据是刻意排布成"好验证批量操作"的样子，不是随机生成：

| 设计点 | 规则 | 结果 |
|---|---|---|
| 标题带序号 | `测试条目 001 … 080` | 拖 Shift 区间时一眼看出选中了哪几条 |
| 分组轮转 | 每 10 条换一组，循环 5 个组名 | A/B/C 各 20，D/E 各 10 → 可"先筛分组、再全选删" |
| 弱密码复用 | 每 4 条复用一个 `123456/qwerty/password/abc123` | 弱密码 16、重复条目 16，健康页长得出「重复密码」 |
| HTTP 明文 | 每 7 条 `http://` | 10 条 |
| TOTP | 每 5 条（note 不带 —— 笔记挂 TOTP 看着像 bug） | 8 条 |
| 类型混合 | i%10→note、i%15→bank、i%21→id | login 66 / note 8 / bank 3 / id 3 |
| 收藏 | 每 8 条 fav=1 | 10 条 |

重新生成（可指定条数）：

```bash
npx tsx scripts/gen-bulk-testdata.ts          # 80 条
npx tsx scripts/gen-bulk-testdata.ts 200      # 200 条
npx tsx scripts/gen-bulk-testdata.ts 50 b50.csv
```

改完数据**务必**跑一遍复核 —— 它会走真实的 `detectFormat + parseImport + analyzeLocal`：

```bash
npx tsx scripts/verify-testdata.ts
```

> CSV 解析器是手写的（RFC 4180 转义），这几个文件就是它的压力样例。
> 格式识别 / 类型映射改动后，`npm test` 会连同 `test-bulk.csv` 一起验。
