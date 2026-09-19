# 一键启动本地采集服务（首次会自动建 venv 并装依赖）
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

# Windows 上 `python` 常常只是 Microsoft Store 的占位程序（WindowsApps 目录），
# 真正装了 Anaconda / 官方安装包的机器需要按候选路径找一遍。
function Resolve-Python {
    $found = @()
    $cmd = Get-Command python -ErrorAction SilentlyContinue
    if ($cmd -and $cmd.Source -and $cmd.Source -notlike '*WindowsApps*') { $found += $cmd.Source }
    $found += @(
        "$env:ProgramData\Anaconda3\python.exe",
        "$env:USERPROFILE\anaconda3\python.exe",
        "$env:USERPROFILE\miniconda3\python.exe",
        "$env:LOCALAPPDATA\Programs\Python\Python313\python.exe",
        "$env:LOCALAPPDATA\Programs\Python\Python312\python.exe",
        "$env:LOCALAPPDATA\Programs\Python\Python311\python.exe"
    )
    foreach ($c in $found) { if ($c -and (Test-Path $c)) { return $c } }
    if (Get-Command py -ErrorAction SilentlyContinue) { return 'py' }
    throw '找不到可用的 Python。请安装 Python 3.10+ 后重试。'
}

$python = Resolve-Python
Write-Host "使用 Python: $python"

if (-not (Test-Path '.venv')) {
    Write-Host '[1/3] 创建虚拟环境 .venv ...'
    & $python -m venv .venv
}

$py = Join-Path $PSScriptRoot '.venv\Scripts\python.exe'

Write-Host '[2/3] 安装依赖 ...'
& $py -m pip install --quiet --upgrade pip
& $py -m pip install --quiet -r (Join-Path $PSScriptRoot 'server\requirements.txt')

Write-Host '[3/3] 启动服务： http://127.0.0.1:8787/'
& $py -m uvicorn app:app --host 127.0.0.1 --port 8787 --app-dir (Join-Path $PSScriptRoot 'server')
