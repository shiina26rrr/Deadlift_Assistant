# ============================================================================
# 开发环境一键准备脚本（Windows PowerShell 5.1+ / PowerShell 7+）
# 作用：检查 Node/npm、按需安装依赖、复制 WASM 与校验姿态模型、可选获取演示样本，
#       最后执行类型检查与单元测试。最终用户运行发行包时无需本脚本。
#
# 用法（在项目根目录或任意目录均可）：
#   powershell -ExecutionPolicy Bypass -File scripts/setup-dev.ps1
#   powershell -ExecutionPolicy Bypass -File scripts/setup-dev.ps1 -Offline -SkipTests
#   powershell -ExecutionPolicy Bypass -File scripts/setup-dev.ps1 -WithSamples
#   powershell -ExecutionPolicy Bypass -File scripts/setup-dev.ps1 -Registry https://registry.npmjs.org
#
# 参数：
#   -WithSamples  额外获取 CC BY 4.0 演示样本（需联网；失败不影响已有样本）
#   -Offline      不访问网络：依赖与模型必须已就绪，否则失败
#   -SkipTests    跳过类型检查与单元测试
#   -Registry     npm 源，仅本次执行生效，不修改全局 npm 配置
#
# 退出码：0 成功；2 环境不满足（Node/npm 缺失或版本不符）；
#         3 网络/镜像/下载失败（依赖安装、模型下载、样本获取）；
#         4 资源校验或类型检查/单元测试失败（含离线模式资源缺失）
# ============================================================================
[CmdletBinding()]
param(
    [switch]$WithSamples,
    [switch]$Offline,
    [switch]$SkipTests,
    [string]$Registry = ''
)

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }
$started = Get-Date
$root = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $root

$MODEL_PATH = Join-Path $root 'resources\models\pose_landmarker_lite.task'
$MODEL_SIZE = 5777746
$MIN_NODE_MAJOR = 22

function Write-Step([string]$Message) {
    Write-Host "==> $Message" -ForegroundColor Cyan
}

function Fail([int]$Code, [string]$Message, [string]$Hint) {
    Write-Host "[失败] $Message" -ForegroundColor Red
    if ($Hint) { Write-Host "       建议：$Hint" -ForegroundColor Yellow }
    exit $Code
}

Write-Step "项目目录：$root"

# ---------------------------------------------------------------- Node / npm
$nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
if (-not $nodeCommand) {
    Fail 2 '未找到 Node.js。' '请安装 Node.js 22 或更高版本（https://nodejs.org/），安装后执行 node -v 自检。'
}
$nodeVersion = (& node.exe -v).TrimStart('v')
$nodeMajor = 0
[void][int]::TryParse(($nodeVersion -split '\.')[0], [ref]$nodeMajor)
if ($nodeMajor -lt $MIN_NODE_MAJOR) {
    Fail 2 "Node.js 版本过低：当前 $nodeVersion，最低要求 $MIN_NODE_MAJOR.x。" '请升级 Node.js 后重试；执行 node -v 确认版本。'
}
Write-Host "    Node.js $nodeVersion"

$npmCommand = Get-Command npm.cmd -ErrorAction SilentlyContinue
if (-not $npmCommand) {
    Fail 2 '未找到 npm.cmd。' '请重新安装 Node.js（包含 npm），或检查 PATH 是否包含 Node.js 安装目录。'
}

# ---------------------------------------------------------------- 依赖
$depsReady = (Test-Path (Join-Path $root 'node_modules\electron\package.json')) -and
             (Test-Path (Join-Path $root 'node_modules\@mediapipe\tasks-vision\package.json'))
if ($depsReady) {
    Write-Host '    依赖已存在，跳过 npm install'
} else {
    if ($Offline) {
        Fail 4 '离线模式但 node_modules 不完整。' '先联网执行一次本脚本（不加 -Offline），或手动运行 npm install。'
    }
    Write-Step "安装依赖（仅本次使用源：$Registry）"
    if ($Registry) {
        & npm.cmd install --registry=$Registry --no-audit --no-fund
    } else {
        & npm.cmd install --no-audit --no-fund
    }
    if ($LASTEXITCODE -ne 0) {
        Fail 3 "依赖安装失败（npm 退出码 $LASTEXITCODE）。" "检查网络/代理，或改用 -Registry https://registry.npmjs.org；失败日志见上方 npm 输出。"
    }
}

# ---------------------------------------------------------------- 模型与 WASM
if (-not (Test-Path $MODEL_PATH)) {
    if ($Offline) {
        Fail 4 "缺少姿态模型：resources\models\pose_landmarker_lite.task" '请先联网执行一次脚本，或手动放置官方 lite 模型（5,777,746 字节）。'
    }
}
Write-Step '准备 WASM 与姿态模型（copy-resources.mjs；首次需联网下载模型）'
& node.exe scripts/copy-resources.mjs
if ($LASTEXITCODE -ne 0) {
    Fail 3 "资源准备失败（退出码 $LASTEXITCODE）。" '检查网络与磁盘权限；模型地址为 MediaPipe 官方存储，必要时配置代理后重试。'
}

if (-not (Test-Path $MODEL_PATH)) {
    Fail 4 '资源准备后仍缺少姿态模型。' '检查 resources\models 目录权限，或手动放置 5,777,746 字节的官方 lite 模型。'
}
$modelBytes = (Get-Item -LiteralPath $MODEL_PATH).Length
if ($modelBytes -ne $MODEL_SIZE) {
    Fail 4 "姿态模型大小不符：$modelBytes 字节，期望 $MODEL_SIZE 字节。" '删除该文件后重新执行脚本；不要使用来源不明的模型文件。'
}
Write-Host "    姿态模型校验通过（$modelBytes 字节）"

$WASM_DIR = Join-Path $root 'resources\wasm'
$WASM_FILES = @(
    'vision_wasm_internal.js',
    'vision_wasm_internal.wasm',
    'vision_wasm_nosimd_internal.js',
    'vision_wasm_nosimd_internal.wasm'
)
$missingWasm = @($WASM_FILES | Where-Object { -not (Test-Path (Join-Path $WASM_DIR $_)) })
if ($missingWasm.Count -gt 0) {
    Fail 4 ("WASM 运行时缺少文件：" + ($missingWasm -join '、')) '请先完成依赖安装后重新执行；脚本会从 node_modules/@mediapipe/tasks-vision/wasm 复制。'
}
Write-Host "    WASM 运行时校验通过（$($WASM_FILES.Count) 个文件）"

# ---------------------------------------------------------------- 演示样本（可选）
if ($WithSamples) {
    if ($Offline) {
        Write-Host '    [跳过] 离线模式不下载演示样本'
    } else {
        Write-Step '获取 CC BY 4.0 演示样本（fetch-samples.mjs）'
        & node.exe scripts/fetch-samples.mjs
        if ($LASTEXITCODE -ne 0) {
            Fail 3 "演示样本获取失败（退出码 $LASTEXITCODE）。" '样本仅用于演示与回归，可稍后重试；不影响摄像头/视频训练功能。'
        }
    }
} else {
    Write-Host '    [跳过] 未指定 -WithSamples，不下载演示样本'
}

# ---------------------------------------------------------------- 校验
if ($SkipTests) {
    Write-Host '    [跳过] 已跳过类型检查与单元测试'
} else {
    Write-Step '类型检查（tsc node/web）'
    & node.exe node_modules/typescript/bin/tsc --noEmit -p tsconfig.node.json
    if ($LASTEXITCODE -ne 0) { Fail 4 '类型检查失败（node 配置），请查看上方 TypeScript 输出。' '修复类型错误后重试，或先用 -SkipTests 跳过校验。' }
    & node.exe node_modules/typescript/bin/tsc --noEmit -p tsconfig.web.json
    if ($LASTEXITCODE -ne 0) { Fail 4 '类型检查失败（web 配置），请查看上方 TypeScript 输出。' '修复类型错误后重试，或先用 -SkipTests 跳过校验。' }

    Write-Step '单元测试（vitest）'
    & node.exe node_modules/vitest/vitest.mjs run
    if ($LASTEXITCODE -ne 0) { Fail 4 '单元测试失败，请查看上方 vitest 输出。' '修复失败用例后重试；不要以旧测试结果替代本次执行。' }
}

$elapsed = [int]((Get-Date) - $started).TotalSeconds
Write-Host ''
Write-Host "完成：开发环境已就绪（耗时 ${elapsed}s）" -ForegroundColor Green
Write-Host '下一步：npm run dev 启动开发模式；npm run dist 生成发行 ZIP。'
exit 0
