# 开发阶段训练流程（V2 / T11、T12）

本目录为**开发阶段**训练脚本，**不进入发行包**；发行版运行时离线加载 `resources/models/action-model.json`，不训练、无 Python、无 API Key。

## 环境

- Windows；Python 3.14.7，命令用 `py`（`python`/`python3` 被 Microsoft Store 别名拦截）
- 依赖：`mediapipe 1.1.1`（Tasks API）、`opencv-python 5.x`、`numpy`、`scikit-learn 1.9.x`
- 姿态模型：复用 `resources/models/pose_landmarker_lite.task`（与运行时同一模型）

## 步骤

```bash
# 0) 获取数据（整包 zip 端点；也可只下 GB 文件夹，见 scripts/fetch-mydedlift.py）
#    见 scripts/fetch-mydedlift.py 与根目录 HANDOFF-V2-training.md
# 1) 按参与者划分（官方 subject-wise，非随机）
py training/build_splits.py
# 2) 从原视频提取与运行时一致的特征（23 维）
py training/extract_features.py            # 输出 dataset/features/*.json；已存在则跳过
py training/extract_features.py --force    # 覆盖重提（协议变更后必须用）
# 3) 训练/评估/导出
py training/train_model.py                 # 输出 resources/models/action-model.json + dataset/metrics.json
# 4) 重训后重建运行端一致性固件
py training/make_consistency_fixture.py
```

`extract_features.py` **每条视频新建一个 landmarker**（时间戳各自从 0 起）；共用一个实例会因时间戳非单调而中断，导致部分视频产出 0 分段。

## 特征契约（关键：训练端与运行时必须一致）

- 维度顺序见 `training/common.py` 的 `FEATURE_ORDER`，与
  `src/renderer/src/analysis/actionModelRuntime.ts` 的 `FEATURE_ORDER` **顺序一致**；
  产物维度由开发集选型决定（本版 20 维，不含身体比例）。
- 角度定义与有效性规则镜像 `src/renderer/src/analysis/geometry.ts`：
  - `armGroundAngle`（肩—腕与水平线锐角，0–90°）、`elbowInnerAngle`（肩—肘—腕内角，0–180°）、
    `kneeInnerAngle`（髋—膝—踝内角，0–180°）、`trunkLeanAngle`（髋—肩与竖直线夹角，0–90°）。
  - 关键点 `visibility >= 0.5` 且坐标为有限值才算有效；越界值判为 UNAVAILABLE。
  - 逐帧侧别取 6 点平均 visibility 更高的一侧。
- 每个角度在**一次动作**内聚合为 mean/min/max/std（有效帧；全缺失 → NaN）。
- **一次动作的定义**：从最低点（躯干前倾最大帧）起的**上升段**至站直，与运行时协议一致；
  站直判定**只看躯干**（`trunkLeanAngle <= 12°` 持续 `standingHoldMs`），膝关节仅用于识别下放。
- `displacementShoulder/Hip`：肩/髋竖直像素幅度 ÷ 身高代理（上升段内最直立帧的踝—肩竖直像素距）。
- `durationSec`、`validRatio`：上升段时长与四项角度全有效的帧占比（按裁剪后帧重算）。
- 缺失以 **NaN** 掩码；运行时推理时 NaN 用训练均值填充后再标准化（等价于标准化空间中置 0）。
- **比例门控**：三个比例特征仅在参考质量为 `OK` 时写入；`LOW`/`MISSING` 按缺失处理
  （与运行时 `extractFeatures` 一致）。
- **选型**：`train_model.py` 在全部配置（含/不含比例 × C × class_weight）中按开发集 macro-F1 选择；
  分差 < 0.01 时优先更少特征。不再强制使用含比例特征集。

## 与运行时分段的差异（如实记录）

- 训练端以数据集既有片段（每段一次完整动作）为单位，再按同一协议裁剪出上升段。
- 运行时的 `SegmentedAction` 由阶段状态机分段后裁剪；两者边界仍可能略有差异，未做逐帧对齐。
- 191 段中 10 段未产生分段（GB 5 / LLK 1 / PB 4），原因是片段内没有满足"躯干 ≤12° 持续 400/500 ms"的站直。
  该差异与失败样本数写入 `training/MODEL_CARD.md`。

## 输出

- `resources/models/action-model.json`：运行时产物，`ModelArtifactBundle` 结构（线性权重 W、偏置 b、
  标准化 mean/std、类别顺序、拒判阈值、特征规范、校验摘要、验证状态）。
- `dataset/metrics.json`：选型网格、开发集/测试集指标、混淆矩阵、多数类基线、特征对比。
