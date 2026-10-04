## 神盾 Aegis（Electron 版）

本机密码管理器：Argon2id 派生 + AES-256-GCM 信封加密，全程离线，不联网（除密码健康里的 HIBP 泄露检测，走 k-匿名只外发 SHA-1 前 5 位）。

### 下载哪个

| 平台 | 文件 | 说明 |
|---|---|---|
| Windows | `AegisNext Setup *.exe` | NSIS 安装包，双击即装 |
| macOS | `AegisNext-*-arm64.dmg` / `*.dmg` | Apple 芯片选 arm64，Intel 选 x64 |
| Linux | `*.deb` / `*.AppImage` | Debian 系用 deb，其它发行版用 AppImage（`chmod +x` 后直接跑） |

### 完整性校验

每个 Release 附 `SHA256SUMS.txt`：

```bash
# Linux / macOS
sha256sum -c SHA256SUMS.txt        # macOS 用 shasum -a 256 -c

# Windows (PowerShell)
Get-FileHash .\AegisNext*.exe -Algorithm SHA256
```

### 未签名的提醒

除非仓库配置了签名证书（Windows 代码签名 / Apple Developer 证书），否则：

- **Windows**：SmartScreen 会拦一句"未知发布者"，点「更多信息 → 仍要运行」
- **macOS**：首次打开需右键 →「打开」，或 `xattr -dr com.apple.quarantine /Applications/AegisNext.app`

### 这是测试版

当前处于技术选型阶段（与 Tauri 版同 UI 对比），**不要用来存唯一的密码副本**。密码库文件格式尚未冻结。
