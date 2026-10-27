# 数据许可说明（开发阶段训练数据）

本目录下的训练脚本与流程使用公开数据集 **MyDeadlift Dataset**：

- 名称：MyDeadlift Dataset: Labeled Deadlift Videos and Biomechanical Angle Data
- 来源：Mendeley Data，DOI [10.17632/w5prmmxyt9.1](https://doi.org/10.17632/w5prmmxyt9.1)
- 许可：**Creative Commons Attribution 4.0 International (CC BY 4.0)**
- 规模：191 段固定侧视视频（GB 83 / PB 54 / LLK 54），7 名男性参与者，官方按人划分（训练 5 人 / 测试 2 人）

## 使用与分发约束

- 原始视频（`dataset/raw/`）**不纳入发行包**，仅用于开发阶段训练/评估。
- 训练产出的模型参数（`resources/models/action-model.json`）随应用分发；使用时须注明数据来源与许可。
- 若再分发本数据集的任何部分，须保留 CC BY 4.0 署名与许可声明。
- 数据集自带 `Extracted_keypoints.csv` 的角度列为 MediaPipe 计算产物，**不是独立测量真值**；本项目按规格从原视频重新提取特征。

## 署名（建议）

> MyDeadlift Dataset (DOI 10.17632/w5prmmxyt9.1), CC BY 4.0.
