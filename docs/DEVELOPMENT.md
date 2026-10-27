# 开发与构建

普通使用者请下载 Windows 运行包，见项目首页和[使用说明](USER_GUIDE.zh-CN.md)。本页面向需要修改源码、训练模型或构建发行包的开发者。

## 本地运行

需要 Node.js 和 npm。已记录的验证环境为 Node.js 22 / npm 10，具体依赖版本由 `package-lock.json` 锁定。

在项目根目录执行：

```powershell
npm ci
npm run dev
```

源码包已包含运行所需的模型和 WASM。若资源缺失，执行 `npm run copy-resources` 补齐；该步骤可能联网下载模型。`npm run fetch-samples` 仅用于准备开发回归素材，程序界面不提供样本库入口。

## 检查与构建

```powershell
npm run typecheck
npm test
npm run package
npm run dist
```

`package` 生成 `release/win-unpacked/`；`dist` 生成版本号来自 `package.json` 的 Windows ZIP。目标用户只需解压运行，不需要开发工具。

2026-10-27 的类型检查通过，23 个测试文件 / 192 项测试通过。真实摄像头、GUI、多 DPI 和离线冷启动尚需在目标电脑验证；单元测试不代表这些场景已验证。历史记录见 [VALIDATION.md](../VALIDATION.md)。

## 代码定位

| 路径 | 内容 |
| --- | --- |
| `src/main/` | Electron 窗口、文件访问、报告存储、HTTP 与语音。 |
| `src/preload/` | 主进程与界面的 IPC 桥接。 |
| `src/renderer/src/pose/` | MediaPipe 关键点提取和 Worker。 |
| `src/renderer/src/analysis/` | 角度、滤波、校准、阶段、计次、模型与建议。 |
| `src/shared/config.ts` | 集中的阈值、规则与参数。 |
| `resources/` | 随程序分发的模型、WASM 和回归样本。 |
| `training/` | 开发阶段的特征提取、训练与评估。 |
| `tests/` | 几何、时序、模型、报告与布局检查。 |

角度计算先将归一化坐标按原始视频宽高恢复为像素坐标；四项指标分别计算有效性。阶段识别与计次使用状态机，动作模型另行提供实验性模式参考，不负责补造被遮挡的关键点。

## 模型训练

参阅 [training/README.md](../training/README.md)、[模型说明](../training/MODEL_CARD.md)和[数据许可](../training/DATA_LICENSE.md)。Python 仅用于开发训练，运行程序不依赖 Python。完整原始训练视频不随源码包提供，须按数据来源与许可另行获取。

当前运行模型为 `dl-action-v3` / `feat-3`，采用 20 维特征，不包含身体比例。比例估计作为校准参考保留，不应将旧版 23 维候选特征说明当作当前产物规格。更改特征或模型时同步更新一致性测试和版本，保留历史报告快照。

## 发布

运行包必须包含 EXE 旁的全部运行资源，不单独分发 EXE。保留项目与第三方许可，使用实际发行 ZIP 生成 SHA-256 校验值。公开发布说明面向使用者描述变化和限制；构建过程、打包核验与上传操作另存维护文档。

详细规格和历史任务见项目根目录 SPEC、TECHNICAL、PLAN、ACCEPTANCE，不要求普通用户阅读这些文件。
