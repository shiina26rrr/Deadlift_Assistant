# 硬拉辅助检测系统 作品说明文档

**文档版本**：1.0  
**应用版本**：1.1.1  
**日期**：2026-10-26  
**编写方**：Deadlift Assistant Team  
**适用范围**：Windows 10/11 x64、传统杠铃硬拉、初学者练习辅助

---

## 免责声明

1. 本工具仅作为初学者练习辅助参考，**不能替代专业健身教练**，也不构成训练处方或医学建议。
2. 本工具**不测量腰椎曲率**。MediaPipe 未提供沿腰椎分布的关键点，躯干倾角只表达髋—肩连线的整体方向，不能据此判断脊柱屈曲程度。
3. 本地动作模型的输出仅为**模式参考**（EXPERIMENTAL）。模型分三类：GB（正确）、PB（圆背）、LLK（膝过脚尖），但特征中不含脊柱曲率，PB 与 GB 在二维侧视下本就难以可靠区分；任何类别都不得读作确定性结论。
4. **不得依据本软件判断大重量训练安全性**。是否加重、是否停止训练，应由训练者结合自身感受与专业指导决定。
5. 本版模型测试集 accuracy 0.492、macro-F1 0.495，**低于 1.1.0 的 0.550 / 0.518**。本文档不将本版描述为“识别更准”，也不承诺任何准确率。

---

## 目录

（Word 打开后右键“更新域”即可生成/刷新目录；页码以实际排版为准。）

---

# 第一章 环境依赖说明与一键安装脚本

本章区分两类环境：**最终用户环境**只需解压运行，**开发/再构建环境**才需要 Node.js、Python 与网络。两类环境的依赖、网络与磁盘要求不同，不应混用。

## 1.1 最终用户环境

| 项目 | 要求 | 说明 |
| --- | --- | --- |
| 操作系统 | Windows 10/11 x64 | 发行包为 portable 免安装目录，不含安装器 |
| 运行时 | 无需 Node.js、Python、Java 或 API Key | Electron 运行时已随包提供 |
| 依赖 | 无需另行下载模型或 WASM | 姿态模型、动作模型、WASM 与 5 段演示样本均随包 |
| 网络 | 核心功能可离线 | 在线润色为可选功能；断网时回退到内置总结 |
| 磁盘 | 解压后约 189 MB（EXE 为主） | ZIP 为 131,600,569 B（约 126 MB） |
| 显示 | 建议 1366×768 及以上 | 窗口与缩放适配尚未在目标机实测，见附录 B |
| 摄像头 | 可选，USB 或内置摄像头 | 仅摄像头模式需要；视频导入模式不需要 |

**结论**：最终用户拿到 `deadlift-assistant-1.1.1-win-x64.zip`，解压后双击 `DeadliftAssistant.exe` 即可使用；不需要安装开发工具，也不需要联网下载模型。

## 1.2 开发/再构建环境

| 项目 | 实测/要求版本 | 用途 |
| --- | --- | --- |
| 操作系统 | Windows 11 Pro for Workstations（实测） | 构建与测试环境 |
| Node.js | v22.23.2（实测）；最低 22.x | 构建、测试、脚本运行 |
| npm | 10.9.8（实测） | 依赖安装 |
| PowerShell | Windows PowerShell 5.1 或 PowerShell 7+ | 运行一键脚本 |
| Python | 3.14.7（`py` 启动器） | **仅**训练/重提特征时需要，不参与应用构建 |
| Python 包 | mediapipe 1.1.1、OpenCV 5.0.0、numpy 2.5.3、python-docx 1.2.0 | 训练、验证与文档生成 |
| 网络 | 首次安装依赖与下载姿态模型需要 | 依赖来自 npm，模型来自 MediaPipe 官方存储 |
| 磁盘 | 建议 ≥ 1.5 GB 可用 | `node_modules`、构建产物与发行包 |

> Python 只用于 `training/` 下的离线训练与特征重提。应用运行时不做训练、不调用 Python。仅使用发行包的用户无需安装 Python。

## 1.3 一键安装脚本

脚本路径固定为 `scripts/setup-dev.ps1`，随仓库提供，使用 Windows PowerShell 编写，不引入新的运行时依赖。

### 1.3.1 前置条件

- 已安装 Node.js 22 或更高版本，且 `node -v`、`npm -v` 可在 PATH 中执行。
- 当前用户对项目目录有写权限。
- 首次执行（非 `-Offline`）需要能访问 npm 源与 `storage.googleapis.com`。
- 若系统禁止运行本地脚本，使用下面的单次绕过方式，**不要永久降低系统执行策略**。

### 1.3.2 调用命令

在项目根目录打开 PowerShell，任选其一：

```powershell
# 默认：检查环境 → 按需安装依赖 → 复制 WASM/校验或下载姿态模型 → 类型检查 + 单元测试
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/setup-dev.ps1

# 离线幂等复跑：不访问网络，仅校验现有依赖与资源，并跑类型检查 + 单元测试
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/setup-dev.ps1 -Offline

# 额外获取 CC BY 4.0 演示样本（会访问 Mendeley Data）
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/setup-dev.ps1 -WithSamples

# 指定本次 npm 安装使用的镜像（仅本次生效，不写全局配置）
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/setup-dev.ps1 -Registry https://registry.npmmirror.com

# 只准备环境，跳过类型检查与单元测试
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/setup-dev.ps1 -SkipTests
```

### 1.3.3 参数与默认行为

| 参数 | 类型 | 默认 | 行为 |
| --- | --- | --- | --- |
| `-WithSamples` | 开关 | 关闭 | 开启时才调用 `fetch-samples.mjs` 获取 5 段演示样本；`-Offline` 时跳过 |
| `-Offline` | 开关 | 关闭 | 禁止任何下载；依赖、模型或 WASM 缺失即失败，不尝试联网 |
| `-SkipTests` | 开关 | 关闭 | 跳过 `tsc` 与 `vitest`，摘要中明确标注“已跳过” |
| `-Registry <url>` | 字符串 | 空（使用 npm 默认源） | 仅对本次 `npm install` 生效；不执行 `npm config set`，不写全局配置 |

### 1.3.4 退出码

| 退出码 | 含义 | 典型场景 |
| --- | --- | --- |
| 0 | 全部成功，或按参数跳过 | 离线复跑通过；`-SkipTests` 且资源就绪 |
| 2 | 环境不满足 | 未找到 Node.js/npm，或 Node 主版本 < 22 |
| 3 | 网络/镜像/下载失败 | `npm install` 失败、姿态模型下载失败、样本获取失败 |
| 4 | 资源校验或测试失败 | 离线缺依赖、缺模型、模型大小不符、缺 WASM、`tsc`/`vitest` 失败 |

### 1.3.5 执行步骤与联网点

1. **环境检查**：读取 `node -v`，校验主版本 ≥ 22；检查 `npm.cmd` 是否存在。
2. **依赖安装（按需）**：若 `node_modules/electron` 与 `node_modules/@mediapipe/tasks-vision` 已存在，输出“依赖已存在，跳过 npm install”；否则执行一次 `npm install`。这是第一个联网点。
3. **资源准备**：调用 `scripts/copy-resources.mjs`，把 `node_modules/@mediapipe/tasks-vision/wasm` 的 4 个文件复制到 `resources/wasm`。若 `resources/models/pose_landmarker_lite.task` 已存在且大小正确，不联网；否则从 `storage.googleapis.com/mediapipe-models` 下载（最多重试 5 次，支持断点续传）。这是第二个联网点。
4. **模型校验**：文件必须存在且为 5,777,746 字节，否则以退出码 4 结束，并提示目标路径与期望大小。
5. **WASM 校验**：必须存在 4 个文件（`vision_wasm_internal.js`、`vision_wasm_internal.wasm`、`vision_wasm_nosimd_internal.js`、`vision_wasm_nosimd_internal.wasm`）。
6. **演示样本（可选）**：仅在 `-WithSamples` 且非 `-Offline` 时调用 `scripts/fetch-samples.mjs`，访问 `data.mendeley.com`。这是第三个联网点，失败不影响已有样本与核心功能。
7. **结束校验**：执行 `tsc --noEmit -p tsconfig.node.json`、`tsc --noEmit -p tsconfig.web.json` 与 `vitest run`；`-SkipTests` 时跳过并在摘要标注。

### 1.3.6 幂等性与失败提示

脚本可重复执行：依赖与资源就绪时不会清空 `node_modules`，也不会重复下载模型；模型的修改时间不会被无谓改写。实测连续执行第二次（`-Offline -SkipTests`）输出“依赖已存在，跳过 npm install”“模型已存在且完整”，退出码为 0。

失败时脚本输出中文原因与可操作建议，例如：

- 缺少 Node.js：提示最低版本 22.x、下载入口与 `node -v` 自检命令。
- 模型缺失：提示 `resources\models\pose_landmarker_lite.task` 目标路径与 5,777,746 字节期望大小。
- 依赖安装失败：提示检查网络/代理，或改用 `-Registry https://registry.npmjs.org`。
- 类型检查/测试失败：提示查看上方输出，修复后重试，不以旧结果替代本次执行。

脚本不会输出 API Key、完整环境变量或用户隐私信息。

### 1.3.7 预计耗时

在依赖与资源已就绪、使用 `-Offline` 时，脚本通常在一分钟内完成（实测 `-Offline -SkipTests` 约 0 秒，主要耗时在 `copy-resources.mjs`）。首次联网安装依赖并下载 5.7 MB 模型时，耗时主要取决于网络，通常为 3–10 分钟。类型检查与 192 项单元测试约需数十秒，具体取决于机器性能。

### 1.3.8 常见安装问题

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| 提示“无法加载文件……禁止运行脚本” | PowerShell 执行策略限制 | 使用 `-ExecutionPolicy Bypass` 单次绕过，不要永久修改系统策略 |
| `npm install` 超时或 404 | 网络/镜像不可用 | 改用 `-Registry https://registry.npmjs.org`，或配置代理后重试 |
| 模型下载中断 | 网络不稳定 | 重新执行脚本；`copy-resources.mjs` 支持断点续传与最多 5 次重试 |
| 提示模型大小不符 | 文件不完整或来源不明 | 删除该文件后重新执行；不要使用来源不明的模型 |
| `-Offline` 报缺依赖/缺模型 | 尚未完成首次联网准备 | 先不加 `-Offline` 执行一次，再离线复跑 |

---

# 第二章 部署运行步骤说明

## 2.1 解压即用

1. 取得 `release/deadlift-assistant-1.1.1-win-x64.zip`（131,600,569 B，72 个文件 / 3 个目录）。
2. 解压到任意本地目录（建议路径不含中文与空格，以排除路径兼容问题；中文/空格路径尚未实测）。
3. 双击 `DeadliftAssistant.exe`（188,784,128 B）。无需安装，无需管理员权限。

> 本版**未做代码签名**。首次运行可能出现 Windows SmartScreen 提示；这是未签名应用的系统行为，不代表文件损坏。可在确认文件来源后选择“更多信息 → 仍要运行”。代码签名与 SmartScreen 消除不在本次范围。

## 2.2 首次启动

应用启动后为单窗口界面，包含视频/摄像头画面、实时读数、设置与报告区域。核心分析全部在本机完成，启动时不会访问远程地址。

首次使用建议按以下顺序：

1. 检查输入源：摄像头或导入视频。
2. 选择训练模式：计划模式（组数 × 每组次数）或自由模式。
3. 摄像头模式下完成入框与站立校准。
4. 开始一组，结束后查看整组报告。

## 2.3 摄像头模式

### 2.3.1 拍摄机位

- 摄像头置于训练者**侧面约 2–3 米**，镜头约腰部高度并保持水平。
- 尽量呈**矢状侧面**，肩、肘、腕、髋、膝、踝完整入镜。
- 照明清晰，避免宽松衣物大面积遮挡关键点。
- 明显旋转、非侧面视角、遮挡或人体出画都会降低结果可靠性。

### 2.3.2 入框与自动校准

画面中显示竖向引导框。需**头部至脚踝完整入框**（关键点清晰、不过近、水平居中）后，应用才会建立站立参考。未入框时框上给出“头部出画/脚踝出画/过近/偏左/偏右”等具体提示。

完整入框并保持站立约 2–3 秒后**自动校准**，无需手动点击。校准只是建立个人站立参考，**不证明动作标准**。

### 2.3.3 倒计时与本组开始

校准成功后默认经过 **6 秒倒计时**（可在“设置 → 高级参数”中设为 5–7 秒）开始本组，避免手忙脚乱。倒计时期间取消或切换输入不会启动本组，也不会留下过期计时器。更换训练者或移动机位后可重新校准。

### 2.3.4 结束一组

完成训练后点击“结束一组”，生成整组报告。计划模式下达到目标次数只做提示，不自动截断或结束本组；可提前手动结束并按实际记录。达到计划组数后不会自动再启动。

## 2.4 视频导入

支持常见视频格式（mp4、webm、mov 等）。导入后可播放、暂停、跳转；暂停或跳转时自动重置滤波与阶段状态，避免错误计数。

视频模式下，**正常播放结束会自动生成报告**。视频一开始就处于站立状态不会直接计数；必须经过“准备 → 起拉 → 站直”的完整流程才计一次。

> 1.1.1 起界面不再提供程序内样本库入口。`resources/samples/` 与清单读取能力仍保留，用于开发回归与历史报告兼容，不影响摄像头或视频训练。

## 2.5 整组报告与历史

报告包含：

- 完成次数与未完成片段；
- 组时长与逐指标有效数据覆盖率；
- 关键指标变化范围（手臂与地面夹角、肘内角、膝内角、躯干倾角）；
- 动作节奏（可用时）；
- 按频率/持续时间汇总的主要候选问题；
- 最多 2–3 条有依据且可执行的建议；
- **本地动作模型参考**（单列分区，不覆盖角度数值，不作为动作标准或安全结论）；
- 报告快照元数据：稳定组 ID、会话 ID、完成时间、训练模式、组序号与目标、来源类型、校准版本、规则版本、模型/建议策略/身体比例版本与结果快照。

各指标独立判定是否有效；某指标无效时显示“不可用”，不与其他指标混为一谈。数据覆盖率不足时减少或停止评价，显示“本组数据不足”。

历史记录保存到本机，可在历史列表中回看。重复结束同一组、语音重播、AI 结果异步更新、重开报告都不会产生重复记录；关闭应用后重启，历史仍应保留（跨重启交互未实测，见附录 B）。

## 2.6 数据、日志与隐私

| 内容 | 位置 | 说明 |
| --- | --- | --- |
| 运行日志 | `%APPDATA%\DeadliftAssistant\logs\app.log` | 带时间戳与级别；单文件超过 2 MB 轮转为 `app.log.old`，旧文件必要时再转为 `.old.bak` |
| 报告历史 | `%APPDATA%\DeadliftAssistant\reports.json` | 仅当前用户可读；不含录像、完整关键点序列或 API Key |
| 损坏备份 | 同目录 `reports.json.corrupt-<时间戳>` | 内容损坏时自动备份，避免静默丢弃 |
| 配置 | Electron `userData` 目录 | 阈值与界面设置；不写 EXE 或只读资源目录 |

写入采用“同目录临时文件写完整后 `rename` 替换”，并对保存串行化；读取 IO 错误会向上抛出并在界面提示，原文件不动。

## 2.7 开发运行

```bash
npm install              # 或使用 scripts/setup-dev.ps1
npm run copy-resources   # 复制 WASM；模型缺失时下载（首次需联网）
npm run fetch-samples    # 可选：获取授权演示样本（需联网）
npm run dev              # 启动 Electron 开发服务器
```

- `npm run typecheck`：TypeScript 双配置类型检查。
- `npm test`：Vitest 单元测试，当前 **23 个文件 / 192 项通过**。
- `npm run build`：仅构建，不打包。

## 2.8 构建打包

```bash
npm run package   # 构建并生成免安装目录 release/win-unpacked/
npm run dist      # 构建并生成 ZIP release/deadlift-assistant-1.1.1-win-x64.zip
```

打包配置见 `electron-builder.yml`：`appId` 为 `com.deadlift.assistant`，产物名为 `deadlift-assistant-${version}-win-${arch}.${ext}`。构建成功后可核对：

- `release/win-unpacked/DeadliftAssistant.exe`：188,784,128 B；
- `release/win-unpacked/resources/app.asar`：48,936,912 B（40 个文件）；
- `release/deadlift-assistant-1.1.1-win-x64.zip`：131,600,569 B。

asar 内含 `out/renderer/models/action-model.json`（`dl-action-v3`，20 维）、`pose_landmarker_lite.task`、`out/renderer/samples/` 与 `out/renderer/wasm/`；**不含** `dataset/` 与 `training/`。

## 2.9 运行常见问题

| 问题 | 排查 |
| --- | --- |
| 校准失败 | 确保站立时头部至脚踝完整入框、光线充足、保持静止 2–3 秒；宽松衣物或遮挡会导致关键点不清晰 |
| 计数不准 | 检查机位是否正侧面、镜头是否水平；必须经过准备→起拉→站直完整流程 |
| 角度显示“不可用” | 对应关键点置信度低于阈值或被遮挡；调整机位与照明 |
| 在线润色无返回 | 检查网络、Base URL、模型名与密钥；超时或格式错误会自动回退到内置总结 |
| 没有语音 | 确认 Windows 已安装中文语音包；无中文语音时文字反馈仍完整可用 |
| 想查看日志 | 打开 `%APPDATA%\DeadliftAssistant\logs\app.log` |

---

# 第三章 额外使用的开源组件说明

本项目仅使用以下开源组件与公开数据集；未使用云端姿态识别、未引入大语言模型作为核心能力。组件版本取自 `package-lock.json` 与 `node_modules/*/package.json` 的实际安装值。

## 3.1 组件清单

| 组件 | 精确版本 | 许可证 | 在本项目中的用途 | 分发状态 |
| --- | --- | --- | --- | --- |
| Electron | 33.4.11 | MIT | 桌面应用运行时（主进程/渲染进程/打包） | 随包 |
| @mediapipe/tasks-vision | 0.10.18 | Apache-2.0 | 浏览器端姿态关键点推理（Pose Landmarker） | 随包 |
| MediaPipe Pose Landmarker Lite 模型 | float16 / v1（`pose_landmarker_lite.task`） | Apache-2.0 | 提供 33 个人体关键点；不自带硬拉评价标准 | 随包 |
| TypeScript | 5.9.3 | Apache-2.0 | 源码类型检查与编译 | 不随包（构建） |
| Vite | 5.4.21 | MIT | 渲染进程与主进程构建 | 不随包（构建） |
| electron-vite | 2.3.0 | MIT | Electron 构建集成 | 不随包（构建） |
| electron-builder | 25.1.8 | MIT | 生成 Windows 免安装目录与 ZIP | 不随包（构建） |
| 7zip-bin | 5.2.0 | MIT（打包器）；内含 7-Zip 二进制，许可待法务确认 | electron-builder 的压缩后端 | 不随包（构建） |
| Vitest | 2.1.9 | MIT | 单元测试运行器 | 不随包（测试） |
| @types/node | 22.20.5 | MIT | Node.js 类型声明 | 不随包（构建） |
| Node.js | v22.23.2（实测） | MIT | 构建、脚本与测试运行时 | 不随包（开发环境） |
| MyDeadlift Dataset | DOI 10.17632/w5prmmxyt9.1 | CC BY 4.0 | 191 段传统硬拉侧视视频；用于离线训练、评估与 5 段演示样本 | 样本随包；全量数据不随包 |

## 3.2 许可证与分发说明

- 本应用源码采用 **MIT License**（`package.json` 的 `license` 字段）。
- Electron、Vite、electron-vite、electron-builder、Vitest、@types/node、7zip-bin 均为 MIT；TypeScript 与 MediaPipe 为 Apache-2.0。MIT 与 Apache-2.0 均允许再分发，需保留版权与许可声明。发行包通过 Electron 的 `LICENSES.chromium.html` 等文件保留 Electron/Chromium 相关声明；应用源码许可见仓库根目录。
- `@mediapipe/tasks-vision` 的 WASM 运行时随包提供 4 个文件；姿态模型从 MediaPipe 官方存储下载，构建后随包，运行时不访问网络。
- **7zip-bin 说明**：该 npm 包本身为 MIT，但其内含的 7-Zip 可执行文件另有许可（7-Zip 通常为 LGPL + unRAR 限制）。本项目只在构建阶段使用它压缩产物，不随最终 ZIP 分发；是否需额外的法务确认，标注为“待法务确认”，本文档不替代正式法律意见。

## 3.3 数据集署名与使用边界

演示样本来自 **MyDeadlift Dataset**（Mendeley Data，DOI `10.17632/w5prmmxyt9.1`，CC BY 4.0）。`resources/samples/manifest.json` 逐条记录文件、作者、许可、用途、`usedForTuning` 与 SHA-256。当前清单共 8 段，其中 `bundled: true` 的 **5 段**随发行包提供，其余 3 段仅保留元数据。

使用边界：

- 样本取自数据集的“正确动作（GB）”子集，每段一次动作，仅用于演示与计数/状态边界观察；
- 样本**不作为判错训练标签**，也不代表对真实纠错准确率的声明；
- 训练使用全量 191 段中的 181 段可分段样本，按参与者划分（训练 5 人、测试 2 人），测试侧只评估一次、不参与调参；
- CC BY 4.0 要求署名。本项目的署名信息同时出现在 `manifest.json`、`training/DATA_LICENSE.md` 与本文档。若再分发样本，应保留署名与许可链接。

## 3.4 未使用的能力

为避免误解，明确本项目**未**使用：云端姿态识别 API、云端大模型作为核心分析、运行时训练框架、医学影像或腰椎曲率测量库、商业健身动作库。在线润色为可选项，默认关闭，只发送匿名整组数值摘要。

---

# 第四章 码道在项目开发中的应用总结

本章总结码道（CodeArts 代码智能体）在 1.1.1 增量修复与本次文档交付中的实际作用，并给出可核对的文件与命令证据。结论以仓库现状为准，不把“生成过代码”等同于“已通过验收”。

## 4.1 需求规格与冲突裁决

码道先读取 `project-info.json`、`CODING-REVIEW-2026-10-19.md` 与有效规格，识别出规格多份副本、需求编号漂移的问题（CR01），再把 R19/R20、A22–A24 合并回项目根目录的 `SPEC.md`、`ACCEPTANCE.md` 与 `PLAN.md`。本次文档任务同样先产出 `.codeartsdoer/specs/work-doc/requirements.md`（35 条 DOC-R 需求），再按需求实施，避免“先写文档、后补事实”。

**可核对证据**：`CODING-REVIEW-2026-10-19.md` 的 CR01 条目；`.codeartsdoer/specs/work-doc/requirements.md` 的 DOC-R01–R35 与开放问题；`PLAN.md` 的阶段勾选。

## 4.2 分批增量修复而非重搭

CR02–CR08 被拆成可独立验证的批次：先移除样本库 UI（CR02）与修窗口布局（CR03），再修输入/视频生命周期（CR04）与反馈证据链（CR05），最后统一训练/推理协议（CR06）、按验证选模型与组级拒判（CR07）、异步润色绑定组 ID 与原子写库（CR08）。每批只读相关源码与设计段落，完成即记录结果，未实测项如实保留。

**可核对证据**：`README.md` 的“版本说明（1.1.1）”段；`VALIDATION.md` 的“1.1.1 增量修复验证（CR01–CR09）”段；`src/main/reportStorage.ts` 的临时文件 + rename 实现；`src/renderer/src/ui/app.ts` 的组 ID 绑定逻辑。

## 4.3 训练端与运行时的一致性验证

本版最关键的风险是“训练时一套特征、运行时另一套”。码道协助把阶段机与训练端统一为“最低点起拉的上升段”，站直判定统一为“躯干 ≤12° 持续 400/500 ms”，并用 `tests/modelRuntimeConsistency.test.ts` 在固定输入下比对 Python 训练端与 TypeScript 运行端的概率（1e-6 内一致）。此外新增 `training/make_protocol_parity_fixture.py` 与 `check_protocol_parity.py`，覆盖完整动作、起拉前已俯身、起拉缺髋、推理缺髋 4 例。

**可核对证据**：`VALIDATION.md` 的 CR06 段（191 段重提、181 段可分段、10 段为空及原因）；`training/MODEL_CARD.md` 第 3 节特征契约；`resources/models/action-model.json` 的 `featureSpec.order`（20 项）。

## 4.4 用数据决定模型，而不是用叙事决定模型

CR07 取消了“强制包含身体比例”的预设，改为在全部候选配置中按开发集 macro-F1 选型。结果是 `no_proportion`（20 维）开发集 macro-F1 0.553，优于含比例的 0.488；测试侧 accuracy 0.492、macro-F1 0.495，虽高于多数类基线 0.339，但**低于 1.1.0 的 0.550 / 0.518**。码道没有把这次退化包装成“更准”，而是在模型卡、验证记录、README 与本文档中一致标注。

**可核对证据**：`training/MODEL_CARD.md` 第 5 节指标表与逐类表；`VALIDATION.md` 的 CR07 段；`resources/models/action-model.json` 的 `rejectThreshold: 0.7252`、`validationStatus: "EXPERIMENTAL"`、`checksum`。

## 4.5 自动化验证与交付可复现

码道协助把验证从“手工点一遍”变成可重复命令：`npm run typecheck`、`npm test`（23 文件 / 192 项）、协议一致性 4 例、模型一致性固件。本次文档任务又新增 `scripts/setup-dev.ps1`，把环境检查、依赖、WASM/模型、样本与测试串成一条命令，并提供 `-Offline` 幂等复跑与明确的退出码。脚本用 PowerShell 解析器校验语法错误为 0，实测离线复跑退出码 0、缺模型退出码 4。

**可核对证据**：`VALIDATION.md` 的“单元 / 静态验证”段；`scripts/setup-dev.ps1`；本文档附录 C 的自检记录。

## 4.6 文档与代码同步

文档任务没有只写一份“作品说明”就结束：码道把 `README.md` 中过时的“23 维 / 约 0.52”“146 项测试”限定或修正，把 `training/README.md` 的维度表述与模型卡对齐，并在 `VALIDATION.md` 追加本次文档交付的自检记录。这样评审按“产物 > 模型卡 > 验证记录 > 说明文档”的顺序核对时，不会出现互相矛盾的口径。

**可核对证据**：`README.md` 的版本说明、样本库说明与本地模型段；`training/README.md`；`VALIDATION.md` 末尾的文档自检段。

## 4.7 局限与人工复核

- 码道无法替代目标 Windows 环境上的 GUI、摄像头、缩放、断网、延迟/乱序回包与跨重启实测；这些项目在附录 B 中逐条标注“未实测”，不以单元测试冒充通过。
- 模型指标由真实数据训练与一次性测试得出，码道没有、也不应“调”测试集来改善叙事。
- 文档中的每个数字都能在附录 A 找到来源；若来源文件后续变更，应以仓库现状重新核对，而不是沿用本文档。
- 生成式辅助可能引入措辞偏差，最终口径由人工按“产物 > 模型卡 > 验证记录 > 说明文档”的优先级裁决。

---

# 附录 A 事实来源清单

下表列出本文档关键事实及其来源。核对状态为“已核对”表示已在本机读取对应文件并比对；“冲突已裁决”表示存在两个来源，已按优先级裁决。

| # | 事实名称 | 值 | 来源文件 | 核对状态 / 冲突说明 |
| --- | --- | --- | --- | --- |
| 1 | 应用版本 | 1.1.1 | `package.json` | 已核对 |
| 2 | 应用名称 / 编写方 | deadlift-assistant / Deadlift Assistant Team | `package.json`、`project-info.json` | 已核对 |
| 3 | 源码许可 | MIT | `package.json` | 已核对 |
| 4 | Electron 版本 | 33.4.11 | `package-lock.json` | 已核对 |
| 5 | MediaPipe Tasks Vision 版本 | 0.10.18 | `package-lock.json` | 已核对 |
| 6 | TypeScript / Vite / Vitest 版本 | 5.9.3 / 5.4.21 / 2.1.9 | `package-lock.json` | 已核对 |
| 7 | electron-builder / electron-vite / 7zip-bin 版本 | 25.1.8 / 2.3.0 / 5.2.0 | `package-lock.json`、`node_modules/7zip-bin/package.json` | 已核对 |
| 8 | 单元测试规模 | 23 文件 / 192 项通过 | `VALIDATION.md` | 已核对 |
| 9 | 模型版本 / 特征规范 | dl-action-v3 / feat-3 / 20 维 | `resources/models/action-model.json` | 已核对（`featureSpec.order` 共 20 项） |
| 10 | 模型 checksum | 69ac2dab208898647a3a7538516771fcc3c808de74933f57b93c54e733e8186d | `resources/models/action-model.json` | 已核对 |
| 11 | 拒判阈值 | 0.7252 | `resources/models/action-model.json` | 已核对 |
| 12 | 测试侧 accuracy / macro-F1 | 0.492 / 0.495 | `training/MODEL_CARD.md`、`VALIDATION.md` | 已核对 |
| 13 | 1.1.0 对照指标 | 0.550 / 0.518 | `training/MODEL_CARD.md` | 已核对 |
| 14 | 多数类基线 | 0.339 | `training/MODEL_CARD.md` | 已核对 |
| 15 | 数据集 DOI / 许可 | 10.17632/w5prmmxyt9.1 / CC BY 4.0 | `resources/samples/manifest.json`、`training/DATA_LICENSE.md` | 已核对 |
| 16 | 演示样本数量 | 8 段，其中 5 段随包 | `resources/samples/manifest.json` | 已核对 |
| 17 | 姿态模型大小 | 5,777,746 B | `resources/models/pose_landmarker_lite.task`、`scripts/copy-resources.mjs` | 已核对 |
| 18 | 发行 ZIP 大小 | 131,600,569 B（72 文件 / 3 目录） | `release/deadlift-assistant-1.1.1-win-x64.zip`、`VALIDATION.md` | 已核对 |
| 19 | EXE / asar 大小 | 188,784,128 B / 48,936,912 B（40 文件） | `release/win-unpacked/`、`VALIDATION.md` | 已核对 |
| 20 | 日志路径与轮转 | `%APPDATA%\DeadliftAssistant\logs\app.log`，2 MB 轮转 | `src/main/logger.ts` | 已核对 |
| 21 | 报告库路径 | `%APPDATA%\DeadliftAssistant\reports.json` | `src/main/reportStorage.ts` | 已核对 |
| 22 | 打包标识 / 产物名 | com.deadlift.assistant / `deadlift-assistant-${version}-win-${arch}.${ext}` | `electron-builder.yml` | 已核对 |
| 23 | 一键脚本参数与退出码 | 0/2/3/4 | `scripts/setup-dev.ps1` | 已核对（解析错误 0；离线复跑 0；缺模型 4） |
| 24 | README 旧口径 | “23 维 / 约 0.52” | `README.md` | 冲突已裁决：以模型卡与 `action-model.json` 为准，改为 20 维 / 0.495，并保留“1.1.0 旧口径”说明 |
| 25 | README 测试数量旧值 | “146 项” | `README.md` | 冲突已裁决：以 `VALIDATION.md` 与本次执行为准，修正为 192 项 |
| 26 | 样本清单描述 | “其余可在程序内下载补充” | `resources/samples/manifest.json` | 冲突已裁决：1.1.1 已移除程序内样本库入口；清单保留为开发/兼容用途，界面无入口 |

---

# 附录 B 未实测清单

以下项目**未在目标 Windows 桌面环境实测**，只完成了静态检查、单元测试或构建验证。不得将本表之外的项目误解为已通过；也不得用单元测试替代下列场景验收。

| # | 未实测项 | 当前证据 | 未测原因 | 影响 | 补测环境 |
| --- | --- | --- | --- | --- | --- |
| 1 | 图形界面窗口与缩放 | 布局代码静态检查、构建通过 | 沙箱无图形界面 | 1024×640、900×1000 及 100%/125%/150% 缩放下的可读性与溢出未知 | Windows 10/11 x64，三种缩放 |
| 2 | 摄像头完整训练流程 | 输入生命周期与阶段机单测 | 无摄像头 | 实际校准、倒计时、计次与结束组时序未知 | Windows + 真实摄像头 |
| 3 | 断网冷启动完整闭环 | 资源随包与 asar 内容核对 | 无图形界面，未做断网启动 | 断网下能否完成关键点→角度→计次→总结未知 | Windows，禁用网络后启动 |
| 4 | 在线润色延迟/乱序回包 | 组 ID 绑定与存储单测 | 无真实 IPC 时序环境 | 旧回包是否覆盖新组、超时回退是否如预期未知 | Windows + 可控延迟服务 |
| 5 | 报告历史跨重启 | 原子写入与损坏备份单测 | 未做真实重启 | 重启后记录、日期/组号/次数是否正确未知 | Windows，连续两组后重启 |
| 6 | 代码签名与 SmartScreen | 未签名现状已确认 | 未购买/配置证书 | 首次运行提示的具体文案与拦截强度未知 | Windows 10/11 真实下载场景 |
| 7 | 真实识别效果（端到端） | 模型卡指标与一致性测试 | 无 GUI 与真实视频闭环 | 实际使用中的模型参考表现未知；指标本身不因未实测而改变 | Windows + 摄像头/视频 |
| 8 | 中文与空格路径启动 | 文件访问代码静态检查 | 未做路径实测 | 解压到中文/空格路径能否正常启动与读写未知 | Windows，中文/空格目录 |

---

# 附录 C 交付自检记录

自检按 DOC-R33 的十项执行，结果与证据如下。阻塞项为空。

| # | 检查项 | 方法/命令 | 结果 | 证据位置 |
| --- | --- | --- | --- | --- |
| 1 | 格式 | 检查扩展名 ∈ {docx, pdf} | 通过 | `docs/作品说明文档-v1.1.1.docx` |
| 2 | 大小 | `Get-Item` 读取 Length，≤ 20,971,520 B | 通过 | 见 `VALIDATION.md` 文档自检段 |
| 3 | 章节 | 检索四章标题、免责声明、附录 | 通过 | 本文档目录与正文 |
| 4 | 数字 | 抽查版本、指标、测试数、产物大小、样本数 | 通过 | 附录 A |
| 5 | 敏感信息 | 文本检索 `sk-`、`api_key`、`password`、`token` 等模式 | 通过（0 命中） | 见 `VALIDATION.md` 文档自检段 |
| 6 | 脚本语法 | PowerShell Parser 解析 `scripts/setup-dev.ps1` | 通过（错误 0） | 见 `VALIDATION.md` 文档自检段 |
| 7 | 目录 | Word 打开后更新域，检查章节目录 | 通过 | docx 目录域 |
| 8 | 图片 | 确认未插入伪造截图；图片数 0 | 通过（不适用） | 本文档无界面截图 |
| 9 | 链接 | 检查仓库相对路径存在、无外链承诺 | 通过 | 附录 A 来源路径 |
| 10 | 打开性 | 用 Word 打开 docx，无修复提示 | 通过 | 见 `VALIDATION.md` 文档自检段 |

---

# 附录 D 修订记录

| 版本 | 日期 | 说明 |
| --- | --- | --- |
| 1.0 | 2026-10-26 | 首版。覆盖 DOC-R01–R35：两类环境、一键脚本、部署运行、开源组件、码道总结、事实来源、未实测清单与十项自检。 |

---

# 附录 E 术语表

| 术语 | 含义 |
| --- | --- |
| GB | Good/Better 类别，数据集中标注为正确动作；本工具只把它当作模型类别名 |
| PB | 圆背类别标签；二维侧视特征不含脊柱曲率，不能据此作确定性弓背判断 |
| LLK | 膝过脚尖类别标签；不得读作“膝过脚尖必错” |
| macro-F1 | 三类 F1 的算术平均，不按样本数加权 |
| 多数类基线 | 总预测为测试集最多类时的 accuracy，本版为 0.339 |
| 拒判阈值 | 最大类别概率低于 0.7252 时不给出类别参考 |
| 组级拒判 | 整组预测需 60% 一致；否则标注 LOW_CONFIDENCE 或 MIXED_PATTERN |
| 上升段 | 从最低点（躯干前倾最大帧）到站直的动作区间，训练与运行时统一 |
| asar | Electron 的应用归档格式，本项目为 48,936,912 B / 40 文件 |
