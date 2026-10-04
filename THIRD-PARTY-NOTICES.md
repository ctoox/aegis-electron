# 第三方组件与许可声明

本文件列出神盾 Aegis（Electron 桌面版）**分发的二进制中所包含的第三方组件**及其许可。
项目自身的代码以 [MIT](LICENSE) 许可发布；第三方组件仍归其各自作者所有，遵循各自的许可条款。

> 本清单的运行时依赖由 `npm ls --omit=dev --all` 的实际安装树生成（共 22 个包 + 应用自身），
> 版本以 `package-lock.json` 为准。修改依赖后请重新生成。

---

## 一、随应用分发（运行时）

### 1. 桌面运行时

| 组件 | 版本 | 许可 | 说明 |
|---|---|---|---|
| Electron | 33.4.11 | MIT | 桌面应用框架 |
| Chromium | （随 Electron） | BSD-3-Clause 等 | Electron 内置的浏览器内核 |
| Node.js | （随 Electron） | MIT | Electron 内置的 JS 运行时 |

> **Chromium 内含大量第三方组件**（BSD、MIT、Apache-2.0、MPL、LGPL 等），其完整许可文本随
> Electron 分发，在仓库中位于 `node_modules/electron/dist/LICENSES.chromium.html`，
> 在打包产物中位于应用资源目录内。分发本应用时请不要删除该文件。

### 2. 应用依赖

| 包 | 版本 | 许可 |
|---|---|---|
| `electron-updater` | 6.8.9 | MIT |
| `builder-util-runtime` | 9.7.0 | MIT |
| `lazy-val` | 1.0.5 | MIT |
| `tiny-typed-emitter` | 2.1.0 | MIT |
| `fs-extra` | 10.1.0 | MIT |
| `jsonfile` | 6.2.1 | MIT |
| `universalify` | 2.0.1 | MIT |
| `graceful-fs` | 4.2.11 | ISC |
| `js-yaml` | 4.3.2 | MIT |
| `argparse` | 2.0.1 | Python-2.0 |
| `sax` | 1.6.1 | BlueOak-1.0.0 |
| `semver` | 7.7.4 | ISC |
| `debug` | 4.4.3 | MIT |
| `ms` | 2.1.3 | MIT |
| `hash-wasm` | 4.12.0 | MIT |
| `react` | 18.3.1 | MIT |
| `react-dom` | 18.3.1 | MIT |
| `scheduler` | 0.23.2 | MIT |
| `loose-envify` | 1.4.0 | MIT |
| `js-tokens` | 4.0.0 | MIT |
| `lodash.isequal` | 4.5.0 | MIT |
| `lodash.escaperegexp` | 4.1.2 | MIT |

**许可分布**：MIT ×18、ISC ×2、Python-2.0 ×1、BlueOak-1.0.0 ×1。
**全部为宽松型（permissive）许可，不含 GPL / AGPL / LGPL 等传染性条款。**

---

## 二、仅构建期使用（不分发）

以下组件只在开发与打包时使用，**不会进入分发给用户的产物**，此处一并列出以求完整：

| 包 | 版本 | 许可 | 用途 |
|---|---|---|---|
| `typescript` | 5.9.3 | Apache-2.0 | 类型检查与编译 |
| `electron`（作为开发依赖） | 33.4.11 | MIT | 本地运行与打包 |
| `electron-builder` | 26.x | MIT | 生成安装包 |
| `electron-vite` / `vite` | 2.x / 5.x | MIT | 构建 |
| `tsx` | 4.x | MIT | 运行 TypeScript 脚本 |
| `ejs` / `jake` / `filelist` | — | Apache-2.0 | electron-builder 的间接依赖 |
| `caniuse-lite` | — | CC-BY-4.0 | 浏览器兼容性数据（构建期） |
| `@electron/osx-sign` / `@electron/windows-sign` | — | BSD-2-Clause | 签名工具链 |
| 其余构建依赖 | — | MIT / ISC / BSD / Apache-2.0 / 0BSD / BlueOak-1.0.0 / WTFPL | 见 `node_modules/*/LICENSE` |

> `caniuse-lite` 采用 CC-BY-4.0，归属声明：**caniuse-lite, © caniuse / Alexis Deveria and contributors，
> 以 CC-BY-4.0 发布**（https://caniuse.com/）。该数据仅用于构建期，不随应用分发。

---

## 三、字体

**本应用不内嵌任何第三方字体文件**，界面使用各平台系统默认字体：

- Windows：微软雅黑 / 等线 / 黑体 / 宋体
- macOS：苹方 / 系统字体
- Linux：由系统字体配置决定

> 项目另有 Python / Web 版本的实现会使用 MiSans 字体（小米，免费商用许可，
> 要求注明且禁止单独再分发字体文件）。**本 Electron 版不包含 MiSans 字体文件**，
> 因此不涉及该许可的约束。

---

## 四、许可全文

### MIT License

本项目及上述标注为 MIT 的组件，适用以下条款（各组件版权归其各自作者所有）：

```
Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### ISC License（`graceful-fs`、`semver`）

```
Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY
AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM
LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR
OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR
PERFORMANCE OF THIS SOFTWARE.
```

### Python-2.0 License（`argparse`）

`argparse`（Node.js 移植版）采用 Python Software Foundation License 2.0。
完整文本见 `node_modules/argparse/LICENSE`，要点为：允许使用、复制、修改与分发，
保留版权声明；**"AS IS" 免责**。

### BlueOak-1.0.0（`sax`）

BlueOak Model License 1.0.0 —— 一种现代化的宽松许可，与 MIT 类似，
授予使用、复制、修改与分发的权利并提供免责声明。
完整文本见 `node_modules/sax/LICENSE.md`。

### Apache-2.0（仅构建期：`typescript`、`ejs`、`jake` 等）

Apache License 2.0 要求保留版权与许可声明，并包含专利授权条款。
完整文本见各包目录下的 `LICENSE` / `LICENSE.txt`，或
https://www.apache.org/licenses/LICENSE-2.0 。这些组件不随应用分发。

---

## 五、复现本清单

```bash
# 运行时依赖 + 许可
npm ls --omit=dev --all --parseable | grep node_modules

# 全树许可分布（含构建期）
npx license-checker --production --summary
```

*最后更新：2026-10-04 · 对应 Electron 33.4.11 / React 18.3.1*
