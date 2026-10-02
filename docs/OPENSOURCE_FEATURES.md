# 开源密码管理器「常用功能」与「数据格式」调研（2026-10-02）

调研目的：把成熟开源密码管理器里**用户真正会用的功能**抄成需求清单，并拿到各家的**导入导出格式规格**，
落到 `aegis-electron` 里直接可用。规则：**学功能与格式，不抄代码**。

---

## 一、功能对照矩阵

| 功能 | Bitwarden | KeePassXC | Proton Pass | Padloc | Latch（Tauri） | 我们 | 说明 |
|---|:--:|:--:|:--:|:--:|:--:|:--:|---|
| 三栏布局 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | 已实现 |
| 命令面板 | ➖ | ➖ | ✅ | ➖ | ✅ | ✅ | 已实现 |
| TOTP（本地计算） | ✅ | ✅ | ✅ | ✅ | ➖ | ✅ | 已实现 |
| 密码字符着色 | ✅ | ✅ | ✅ | ➖ | ➖ | ✅ | 已实现 |
| **密码健康报告** | ✅ | ✅ | ✅ | ✅ | ✅ | ⬜ | **本期第 41 项** |
| **HIBP 泄露检测** | ✅ | ✅ | ✅ | ➖ | ✅ | ⬜ | 本期第 41 项 |
| **自动锁定** | ✅ | ✅ | ✅ | ✅ | ✅ | ⬜ | 本期第 42 项 |
| **剪贴板自动清空** | ✅ | ✅ | ✅ | ✅ | ✅ | ⬜ | 本期第 42 项 |
| **导入导出** | ✅ | ✅ | ✅ | ✅ | ⬜ | ⬜ | 本期第 43 项 |
| **设置页** | ✅ | ✅ | ✅ | ✅ | ✅ | ⬜ | 本期第 44 项 |
| 浏览器自动填充 | ✅ | ✅ | ✅ | ✅ | ➖ | ✖ | 需扩展程序，不在桌面端范围 |
| 全局快捷键快速填充 | ➖ | ✅ Auto-Type | ➖ | ➖ | ➖ | ✖ | Python 版（aegis）已做，Electron 版不重复 |
| 云同步 / 多设备 | ✅ | ➖ | ✅ | ✅ | ➖ | ✖ | 需服务端，本期不做 |
| 密码共享 | ✅ | ➖ | ✅ | ✅ | ➖ | ✖ | 同上 |
| 生物识别解锁 | ✅ | ✅ | ✅ | ✅ | ✅ | ✖ | 依赖 OS keychain，后续可加 |
| 通行密钥（Passkey） | ✅ | ✅ | ✅ | ➖ | ➖ | ✖ | 需要系统 WebAuthn 集成 |
| 附件 / 文件存储 | ✅ | ✅ | ✅ | ✅ | ➖ | ✖ | - |
| 密码历史版本 | ✅ | ✅ | ✅ | ✅ | ➖ | ✖ | 可低成本加（`extra.history`） |
| 回收站 | ✅ | ✅ | ✅ | ✅ | ➖ | ✖ | - |
| 紧急访问 / 遗产联系人 | ✅ | ➖ | ✅ | ➖ | ➖ | ✖ | - |
| 保险库自毁（失败 N 次） | ➖ | ➖ | ➖ | ➖ | ✅ | ✖ | 风险高，暂不引入 |

**结论 → 本轮落地四项**：健康检查页（含 HIBP）、自动锁定 + 剪贴板自清、导入导出、设置页。

---

## 二、Bitwarden「保险库健康」六报表

Bitwarden 把健康检查做成了 6 张独立报表，是我们设计健康检查页的直接参照：

| 报表 | 判定 | 我们是否实现 |
|---|---|---|
| **Exposed passwords（已泄露）** | HIBP k-匿名查询命中 | ✅ 有（需联网，可关闭） |
| **Reused passwords（重复使用）** | 同一条密码出现在 ≥2 个条目 | ✅ 有（纯本地） |
| **Weak passwords（弱密码）** | 强度低于阈值 | ✅ 有（纯本地） |
| Unsecure websites（不安全网站） | 条目的 URL 是 `http://` 明文 | ✅ 有（纯本地，顺手做） |
| Inactive 2FA（未启用两步验证） | 站点支持 2FA 但条目无 TOTP | ⬜ 需要站点指纹库，本期用「有条目 TOTP 缺失」粗判 |
| Data breach（账号出现在数据泄露库） | 按**邮箱**查 HIBP Breaches | ✖ 需付费 API Key，不做 |

HIBP 的「按邮箱查泄露」需要 `hibp-api-key`（付费），**不做**；只做按**密码**查（免费、无 Key）。

---

## 三、HIBP Pwned Passwords 接口规格（实测确认）

### 3.1 端点

```
GET https://api.pwnedpasswords.com/range/{SHA1(password) 的前 5 位大写十六进制}
```

- 密码先做 **SHA-1**，转**大写十六进制**共 40 字符；只发前 5 位 → **k-匿名**：服务端不知道完整哈希。
- 响应是**纯文本**（`text/plain`），每行 `哈希后缀(35位):出现次数`，以 `\r\n` 分隔：

```
0018A45C4D1DEF81644B54AB7F969B88D65:1
00D4F6E8FA6EECAD2A3AA415EEC418D38EC:2
...
```

- 客户端用返回的 35 位后缀拼回自己的哈希做**本地比对**，命中即拿到次数。

### 3.2 关键约束（踩坑点）

| 项 | 值 | 备注 |
|---|---|---|
| 认证 | **无需 API Key** | 与 `breachedaccount` 不同 |
| 速率限制 | 无（官方说明无限制） | 仍应缓存 + 合并前缀 |
| `User-Agent` | **必须设置** | 缺失 → `403 Forbidden` |
| `Add-Padding: true` | 请求头，可选但推荐 | 响应固定填充到 800–1000 行；填充项 `count=0`，需丢弃 → 防止流量分析推断前缀 |
| 响应规模 | 默认约 800 行 | 每个前缀约 40–60 KB |
| 请求量 | **按前缀去重** | N 个密码若前缀相同只发 1 次，实测 1 次请求覆盖 5 个不同密码 |

### 3.3 我们的实现策略（`src/core/hibp.ts`）

1. `sha1(password)` → 大写 hex；
2. 按**前 5 位分组**，每组只发一次请求；
3. 结果 `Map<suffix, count>` 缓存在主进程内存（`Map<prefix, Map<suffix,count>>`），同一个库里重复检查不再联网；
4. 命中 `count === 0` 的填充行直接丢弃；
5. 8 秒超时；网络失败 → 返回「离线，未检测」，**不阻塞本地健康分**；
6. 全部请求在主进程发出（渲染层不碰网络，零 CSP 麻烦）。

---

## 四、导入导出格式规格

### 4.1 Bitwarden CSV

表头（**大小写敏感**，顺序固定）：

```
folder,favorite,type,name,notes,fields,reprompt,login_uri,login_username,login_password,login_totp
```

- `type` 仅允许 `login` / `note`（其余类型在 CSV 中不导出）；
- `fields` 是自定义字段，格式 `名称: 值` 多组以换行分隔；
- `favorite` 为 `1`/`0`；`reprompt` 为 `0`/`1`。

### 4.2 Bitwarden JSON（未加密导出）

```json
{
  "encrypted": false,
  "folders": [{ "id": "...", "name": "工作" }],
  "items": [{
    "id": "...", "folderId": null, "type": 1, "reprompt": 0,
    "name": "GitHub", "notes": "", "favorite": false,
    "fields": [{ "name": "备用邮箱", "value": "a@b.c", "type": 0 }],
    "login": {
      "uris": [{ "match": null, "uri": "https://github.com" }],
      "username": "me", "password": "pw", "totp": null
    }
  }]
}
```

- `type`：`1`=login，`2`=note，`3`=card，`4`=identity；
- **组织导出**会多一层 `collections`，且 `folderId` 指向 collection —— 我们按 `folders` 找不到就留空，并给 warning。

### 4.3 KeePass 2 CSV（KeePassXC 同）

```
Group,Title,Username,Password,URL,Notes,TOTP,Icon,Last Modified,Created
```

- 时间格式 `yyyy-MM-dd HH:mm:ss`（本地时区），可空；
- 表头大小写按导出器不同会变（KeePassXC 导出为 `Group,Title,Username,Password,URL,Notes,TOTP,Icon,Last Modified,Created`），所以解析要**大小写不敏感 + 别名匹配**。

### 4.4 KeePass 2 XML（KDBX 的明文导出，`.xml`）

```xml
<KeePassFile>
  <Meta>
    <Generator>KeePassXC</Generator>
    <DatabaseName>我的库</DatabaseName>
  </Meta>
  <Root>
    <Group>
      <Name>工作</Name>
      <Group>            <!-- 可无限嵌套 -->
        <Name>生产环境</Name>
        <Entry>
          <String><Key>Title</Key><Value>GitHub</Value></String>
          <String><Protected="True"><Key>Password</Key><Value>base64或明文</Value></String>
          <String><Key>URL</Key><Value>https://github.com</Value></String>
          <String><Key>otp</Key><Value>otpauth://totp/...</Value></String>
          <Times><LastModificationTime>2026-01-01T00:00:00Z</LastModificationTime></Times>
        </Entry>
      </Group>
    </Group>
  </Root>
</KeePassFile>
```

- 关键 `Key` 常量：`Title` / `UserName` / `Password` / `URL` / `Notes` / `otp`；
- `Protected="True"` 只表示「在内存中受保护」，文件是明文导出时 `Value` 就是明文；若为 KDBX 内部流则是 base64 的 ChaCha20 密文 —— **我们只吃插件明文导出，遇到 base64 解不开的给出 warning**；
- **分组信息只在嵌套 `Group/Name` 里**，解析必须维护栈。

### 4.5 LastPass CSV

```
url,username,password,totp,extra,name,grouping,fav
```

- 注意列序与 Bitwarden/Chrome 都不同；`grouping` 是分组路径（`A\B`）；`extra` 是备注。

### 4.6 Chrome / Edge / Safari（macOS 版）CSV

```
name,url,username,password,note
```

### 4.7 通用明文 CSV（我们自有）

`title,username,password,url,notes,totp,favorite,group` —— 便于给别的工具当中间格式。

### 4.8 我们的可移植 JSON（`aegis-portable`）

```json
{ "format": "aegis-portable", "version": 1, "exported_at": 1727..., "entries": [ /* 完整 Entry[] */ ] }
```

> ⚠️ 以上 4.1–4.7 全部是**明文**格式。导出时必须二次确认，导完提示用户删除文件。

---

## 五、落地设计

### 5.1 健康检查页（第 41 项）

- 纯本地部分：弱密码（`strengthBits < 40`）、重复密码（同密码 ≥2 条）、明文 HTTP 站点；
- 联网部分：HIBP k-匿名，可关闭，超时/离线降级为「未检测」；
- **健康分**（与侧栏同一个数）：

```
problems = weak + reused + pwned
score    = clamp(100 - (weak*6 + reused*3 + pwned*12) / max(total,1) * 10, 0, 100)
```

- 六张卡片对应 Bitwarden 的六报表 + 问题条目列表（点进去直接跳该条目）。

### 5.2 自动锁定 + 剪贴板自清（第 42 项）

| 项 | 默认 | 说明 |
|---|---|---|
| 自动锁定 | **5 分钟** | 渲染层每 5 秒上报一次活动（节流），主进程计时；0 = 关闭 |
| 失焦即锁 | 关 | 窗口 blur 立刻锁 |
| 剪贴板自清 | **20 秒** | 只在**剪贴板内容仍是我们写入的那份**时才清（避免清掉用户后来复制的东西） |
| 锁定后清剪贴板 | 开 | - |

### 5.3 导入导出（第 43 项）

- 导入：`dialog.showOpenDialog` → 主进程读文件 → 自动识别格式 → 解析 → **返回预览**（数量 + 警告 + 前 N 条）→ 用户确认 → 提交入库（可选去重：同 title+username 视为已存在则跳过）。
- 导出：`dialog.showSaveDialog` → 写入 → 返回路径与条数。
- 支持：`aegis-portable` / Bitwarden JSON / Bitwarden CSV / KeePass 2 XML / KeePass 2 CSV / LastPass CSV / Chrome CSV / 通用明文 CSV。

### 5.4 设置页（第 44 项）

安全（自动锁定、失焦锁、剪贴板秒数、锁定清剪贴板）、生成器默认参数、外观（主题/玻璃）、数据（导入导出入口、打开数据目录）、关于（版本、KDF 参数只读展示）。

设置存 `userData/aegis.settings.json`（**不含任何密文/密钥**，可明文存储），与库文件分离 —— 这样换库不影响偏好。
