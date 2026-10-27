# 模型说明（Model Card）：dl-action-v3

> 本文件由开发阶段训练流程产出，随仓库保留（**不进入发行包**）。发行包仅含模型参数 `resources/models/action-model.json`。

## 1. 概述

- 模型版本：`dl-action-v3`
- 类型：多项逻辑回归（线性权重 + 偏置 + softmax），可由 TypeScript 直接离线执行；运行时不训练。
- 任务：对"一次完整硬拉动作"给出三类**模式参考**：`GB`（正确）、`PB`（圆背）、`LLK`（膝过脚尖）。
- 特征规范版本：`feat-3`；本版按开发集选型使用 **20 维（不含身体比例）**。身体比例特征版本仍为 `prop-1`（仅作校准参考，不进入本版模型）。
- 验证状态：**EXPERIMENTAL**（实验性；数据规模小、仅男性、单机位，指标有限）。
- 产物：`resources/models/action-model.json`，`checksum = 69ac2dab208898647a3a7538516771fcc3c808de74933f57b93c54e733e8186d`。
- **重要：本版测试集 accuracy 0.492、macro-F1 0.495，虽高于多数类基线 0.339，但仍低于 1.1.0 的 dl-action-v1（0.550 / 0.518）。** 不得表述为"识别更准"，详见第 5 节。

## 2. 数据

- 来源：MyDeadlift Dataset（Mendeley Data, DOI 10.17632/w5prmmxyt9.1, CC BY 4.0）。见 `training/DATA_LICENSE.md`。
- 规模：191 段固定侧视视频，7 名男性参与者；GB 83 / PB 54 / LLK 54。
- 按 1.1.1 协议重提特征后，**181 段可完成分段**（GB 78 / PB 50 / LLK 53），10 段为空（GB 5 / LLK 1 / PB 4，原因见第 6 节）。
- 比例参考质量：OK 176 段 / LOW 15 段 / MISSING 0 段。LOW 段的比例特征按缺失处理（见第 3 节）。
- 划分：**官方按参与者** subject-wise——训练 5 人（S01/S02/S03/S05/S06），测试 2 人（S04/S07）。可分段样本中训练 122 / 测试 59（GB 测试侧 19）。
- 训练侧内部以**留一参与者**做开发验证；最终测试侧仅用于一次评估，不参与调参。

## 3. 特征契约（训练端与运行时一致）

- 本版产物 20 维；顺序见 `training/common.py` 的 `FEATURE_ORDER` 子集，与 `src/renderer/src/analysis/actionModelRuntime.ts` 的 `FEATURE_ORDER` 顺序一致。
- **统计窗口**：一次动作**从最低点（躯干前倾最大帧）起的上升段**至站直；两端协议一致（`training/analysis_protocol.py` 与 `phaseRecognizer.ts` / `orchestrator.ts`）。
- 角度（镜像 `geometry.ts`）：`armGroundAngle`、`elbowInnerAngle`、`kneeInnerAngle`、`trunkLeanAngle`，各在上升段内取 mean/min/max/std。
- 关键点 `visibility >= 0.5` 且坐标有限才算有效；逐帧取 6 点平均置信度更高的一侧。
- `trunkLeanAngle` 为髋—肩连线与竖直线夹角（0–90°），**不是腰椎曲率**。
- `displacementShoulder/Hip`：肩/髋竖直像素幅度 ÷ 身高代理（上升段内最直立帧的踝—肩竖直像素距）。
- `durationSec`、`validRatio`：上升段时长、四项角度全有效帧占比（按裁剪后帧重算）。
- **比例门控（1.1.1 新增）**：仅当站立帧比例估计质量为 `OK`（有效帧 ≥ `minValidFrames` 且相对 MAD ≤ `maxDispersion`）时，三个比例特征才写入向量；`LOW` / `MISSING` 一律按缺失（NaN）处理。训练端 `extract_features.py` 与运行时 `actionModelRuntime.extractFeatures` 使用同一规则。
- 缺失以 **NaN** 掩码；运行时按产物 mean 填充后再标准化（等价于标准化空间置 0）。
- **未使用**文件名、参与者编号、类别编码或数据划分作为输入特征。

## 4. 训练与选型

- 预处理：按列用**训练侧**拟合 mean/std；NaN 以训练均值填充再标准化。
- **选型标准（预先约定，测试集不参与）**：在全部候选配置（含/不含比例 × C × class_weight）中取开发集 macro-F1 最高者；若最高分与次优分差 < 0.01，视为噪声并优先更少特征。
- 本版选择：`no_proportion`（20 维），`C=1.0, classWeight=None`，开发集 macro-F1 **0.553**。
- 对照：`with_proportion`（23 维）最佳开发集 macro-F1 **0.488**（`C=10, balanced`）。
  - **结论（如实记录）**：在本数据集与本轮分段口径下，加入身体比例特征**降低**开发集表现（0.488 vs 0.553）。1.1.1 因此**取消** T12 的"强制含比例"分支，按验证结果选择不含比例的特征集；比例估计仍保留用于校准展示与质量提示。
- 拒判阈值：开发集 OOF 最大类别概率的**第 30 百分位**并夹在 [0.34, 0.95] → **0.7252**。
- 组级拒判（运行时）：整组可用动作的预测类别需达到 60% 一致性；平均最大概率低于阈值 → `LOW_CONFIDENCE`，类别分布不一致 → `MIXED_PATTERN`。阈值只依据开发集/训练侧设定，不按测试集回调。

## 5. 评估结果

测试侧（2 人，可分段 59 段：GB 19 / PB 20 / LLK 20）：

| 指标 | 本版 dl-action-v3 | 上一版 dl-action-v1（旧特征口径） |
| --- | --- | --- |
| accuracy | **0.492** | 0.550 |
| macro-F1 | **0.495** | 0.518 |
| balanced accuracy | **0.490** | 0.550 |
| 多数类基线（accuracy） | 0.339 | 0.333 |

本版高于多数类基线，但**未恢复到 v1 水平**；不得挑选单类指标或"高于基线"掩盖该结论。

逐类：

| 类 | precision | recall | F1 | 支持 |
| --- | --- | --- | --- | --- |
| GB | 0.320 | 0.421 | 0.364 | 19 |
| PB | 0.727 | 0.400 | 0.516 | 20 |
| LLK | 0.565 | 0.650 | 0.605 | 20 |

混淆矩阵（行=真值 GB,PB,LLK；列=预测 GB,PB,LLK）：

```
[[ 8,  3,  8],
 [10,  8,  2],
 [ 7,  0, 13]]
```

拒判阈值 0.7252 下：测试侧接受 37/59，接受样本准确率 0.405（开发集覆盖 0.70、接受准确率 0.588）。

## 6. 局限与风险（务必随交付说明）

- **相对 v1 退化**：分段窗口改为较短的上升段、可训练样本减少 10 段后，accuracy 由 0.550 降至 0.492；模型仍为 `EXPERIMENTAL`，界面/报告不得呈现为判断依据或准确率承诺。
- **10 段未能分段**：片段内未出现满足"躯干 ≤12° 持续 400/500 ms"的站直（起拉后未回正或站立时长不足），故不产生特征；不是特征缺失或程序异常。
- **GB 与 PB 易混**：运行时特征只含手臂/肘/膝/躯干角度，**不含脊柱曲率**；本工具本就不测腰椎曲率、不输出确定性弓背判断，故 PB 本质难判。
- 数据集**仅 7 名男性**、单机位、规模小，**不能**宣称覆盖全部性别/体型/训练水平。
- **比例特征不进入本版模型**：15 段 LOW 质量的比例参考按缺失处理；单目投影近似不得包装成精确人体参数匹配。
- **组内模式不一致**（`MIXED_PATTERN`）不做单一错误归类，也不触发逐次语音纠错；报告仅呈现类别分布。
- **分段差异**：训练端按数据集既有片段裁剪上升段，运行时由阶段状态机分段后再裁剪；两者边界仍可能略有差异，未做逐帧对齐。
- 模型仅作"模式参考"，**不产生动作标准分**；`PB` 预测不得转成确定性腰椎屈曲结论，`LLK` 不得转成"膝过脚尖必错"。
- 演示样本库（`resources/samples/`）不代表模型训练完成；界面不提供"重训"。

## 7. 复现

```bash
py training/build_splits.py
py training/extract_features.py --force   # 覆盖重提；每条视频独立 landmarker
py training/train_model.py                # 全网格选型，输出 resources/models/action-model.json + dataset/metrics.json
py training/make_consistency_fixture.py   # 重训后必须重建，否则一致性测试按旧产物比对
```

固定随机种子 `20261015`；依赖版本见 `training/README.md`。运行端一致性由 `tests/modelRuntimeConsistency.test.ts` 验证（重建固件后 192 项测试全通过）。
