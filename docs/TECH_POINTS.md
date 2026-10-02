# 神盾 Aegis（Python 版）技术点与功能清单

> 供 aegis2（Tauri 2 + React + TS）对照复刻的需求基线。Python 版源码在 `C:\dev\aegis`。

## 1. 架构分层（最值得沿用的设计）

| 层 | Python 版 | aegis2 建议 |
|---|---|---|
| 纯逻辑核心（无 UI 依赖） | `aegis_core/`（vault/generate/health/totp/history/backup/settings…） | Rust crate：`src-tauri/src/vault.rs` 等，命令暴露给前端 |
| UI 层 | `aegis_desktop/`（PySide6） | React 组件 |
| 加密 | 纯 Python 库 | Rust 生态：`argon2` + `aes-gcm` + `ring`/`rand` |

**铁律**：加密/存储逻辑绝不进 UI 层；核心层可独立测试（Python 版 18 项健康审计测试全部打在核心层）。

## 2. 加密与存储（安全基线，一项都不能少）

- **Argon2id** 由主密码派生 KEK（参数 ≥ OWASP 推荐：m=19MiB, t=2, p=1 或更高）
- **AES-256-GCM 信封加密**：KEK 包裹随机 DEK，DEK 加密每条条目
- **AAD 绑定**：每条密文用 `entry_id|entry_type` 做 AAD，防密文挪用/置换
- **每条条目独立密文**：一条损坏不影响整库
- 库文件含 `version / format / header / entries` 结构，向后兼容要留字段
- **密钥生命周期**：解锁后 DEK 只在内存；退出/锁定即擦除（Python 版有测试：退出即锁定→密钥擦除→重新解锁数据完整）
- 校验：错误主密码 = GCM 认证失败（InvalidTag），不存明文校验哈希

## 3. 功能清单（已实现 = aegis2 的 MVP+）

**密码库**
- 条目类型：login / note / 银行卡 / 身份（`ENTRY_TYPES` + 每类型扩展字段 `EXTRA_FIELDS`）
- 标题/用户名/密码/网址/备注/收藏/自定义 extra
- 分类侧栏（全部/收藏/按类型）+ 搜索 + 计数徽标
- 详情页卡片化字段（密码打码/眼睛/一键复制）

**生成与评估**
- 密码生成器：`secrets` 级随机（Rust 用 `rand::rngs::OsRng`），保证大小写+数字（可选符号），Fisher-Yates 洗牌
- 易记短语：128 词内置词表 + 两位数字，约 28bit/词
- 强度评估：字符池熵估算（bit）+ 常见弱口令惩罚；四/五档强度条（红→绿）
- 无密码条目：详情页「一键生成强密码」卡

**密码健康**（`health.audit`）
- 弱密码（强度≤1）/ 未设密码 / 重复密码 三类扫描
- 0-100 健康分：弱×10 无×4 重×8 扣分，分母=条目数
- 健康页每条问题「生成强密码」就地修复 + 「查看」跳转定位

**TOTP 两步验证**
- RFC 6238，30s 步长，Base32 密钥；详情页动态码卡 + 列表 2FA 徽章

**历史与备份**
- 条目历史版本：修改前抓快照（`snapshot_of` → `update(prev_snapshot=)`），diff 摘要、选择恢复（恢复动作本身也入历史）
- 自动备份：保存钩子滚动快照到 `backups/`；清空前强制留全量快照

**导入/导出**
- 批量导入：CSV / TXT（自定义模板）/ JSON / KeePass
- 加密分享包导出/导入

**自动填充**（Python 版最复杂的子系统）
- 全局快捷键唤起快速填充面板：搜索 + 预选当前条目
- 注入路径：SendInput 主路径（表序列：TAB/INPUT/ENTER 可配）+ WM_SETTEXT 控件直填兜底
- 智能降级：both 缺用户名→只填密码；缺密码→只填用户名（条目级 extra 可覆写全局默认）
- 「等待选目标」模式：从软件内唤起时轮询前台窗口 10s，点哪填哪
- 主窗口隐藏/填充后恢复，防自己注入自己

**安全周边**
- 剪贴板 30s 自清（可配）
- 空闲 5min 自动锁定（可配）
- Windows Hello（指纹/PIN/人脸）快速解锁
- 全局快捷键注册/冲突检测/状态显示（设置页）
- 系统托盘；批量删除（多选）与清空库（输入「清空」三重确认）

## 4. UI 设计规范（Apple 风，已在 Python 版验证过）

- **色**：系统蓝 #007AFF（唯一强调色）/ 窗口灰 #F5F5F7 / 文字 #1D1D1F·#6E6E73·#98989D / 语义色 #E0433C·#2FA356·#C9882B
- **圆角**：6/8/10/14/18；**间距**：4/8/12/16/20/24/32；**字号**：11/12/13/14/16/19/24
- 卡片化（白卡+极淡描边），层次靠留白不靠重阴影；弹窗与主窗口同一套 token
- 踩过的坑：QSS padding × 固定高度裁字 → 别锁高，用 sizeHint；小屏弹窗必须套滚动区；图标按钮 30×30 两字按钮 ≥70px

## 5. 测试与工程化（新项目请保持同等水位）

- 核心层无头测试（加密/审计/历史/导入/备份…全离线）
- GUI 冒烟测试（离屏建窗→操作→断言→销毁）
- 可达性/布局回归断言（77+57 项）
- 离屏渲染截图走查（`scripts/render_*.py` → previews/*.png 给用户看）
- 命令行演示库脚本、桌面快捷方式（mklink /H）

## 6. aegis2 技术选型理由（Tauri 2 + React + TS）

- **体积/内存**：系统 WebView2，安装包 ~5MB（对比 Electron ~150MB）
- **Rust 侧**：加密有成熟 crate（argon2/aes-gcm/rand），内存安全适合密码管理器；1Password 新版同思路（Rust 核心 + Web UI）
- **React 生态**：表格/列表/动画/组件库（可配 Radix/shadcn、framer-motion）随便美化
- **前端调后端**：`invoke("命令名")` ≈ Python 版直接调 `aegis_core`；Rust command 返回 `Result<T, String>`
- 状态管理建议 Zustand；密码字段组件自研（打码/生成器/强度条）
- 后续泄露检测：HIBP k-匿名（SHA-1 前 5 位查询），Tauri 的 Rust reqwest 做网络更顺手
