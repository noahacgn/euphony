<#
.SYNOPSIS
启动或停止 Euphony 本地开发服务。

.DESCRIPTION
这个脚本可以从任意当前目录运行，因为它会通过脚本所在位置定位项目根目录。
默认启动 FastAPI 后端和 Vite 前端，等待服务可访问后打开浏览器。
按 Ctrl+C 会停止本次脚本启动的前后端；如果终端被直接关闭，可以再次运行脚本并传入 -Stop。

.EXAMPLE
& 'D:\IdeaProjects\euphony\scripts\start-local.ps1' -ClearProxy

.EXAMPLE
& 'D:\IdeaProjects\euphony\scripts\start-local.ps1' -Stop
#>
[CmdletBinding()]
param(
  [switch]$Stop,
  [switch]$NoBrowser,
  [switch]$SkipInstall,
  [switch]$ClearProxy,
  [string]$OpenAiApiKey = $env:OPEN_AI_API_KEY,
  [string]$HostAddress = '127.0.0.1',
  [int]$BackendPort = 18020,
  [int]$FrontendPort = 3000
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$ProjectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$StatePath = Join-Path ([System.IO.Path]::GetTempPath()) 'euphony-local-dev.json'
$FrontendUrl = "http://${HostAddress}:${FrontendPort}/"
$BackendUrl = "http://${HostAddress}:${BackendPort}/"
$BackendPingUrl = "${BackendUrl}ping/"
$EventSubscriptions = New-Object System.Collections.Generic.List[object]

# 统一输出前缀，方便从前后端日志里区分脚本自己的状态消息。
function Write-Step {
  param([Parameter(Mandatory = $true)][string]$Message)

  Write-Host "[euphony] $Message"
}

function ConvertTo-PowerShellLiteral {
  param([Parameter(Mandatory = $true)][string]$Value)

  return "'$($Value.Replace("'", "''"))'"
}

function Test-ProcessRunning {
  param([Parameter(Mandatory = $true)][int]$ProcessId)

  return $null -ne (Get-Process -Id $ProcessId -ErrorAction SilentlyContinue)
}

function Stop-ProcessTree {
  param([Parameter(Mandatory = $true)][int]$RootProcessId)

  # Uvicorn --reload 和 Vite 都会派生子进程，只停父进程容易留下端口占用。
  $children = @()
  if (Get-Command -Name 'Get-CimInstance' -ErrorAction SilentlyContinue) {
    $children = @(
      Get-CimInstance -ClassName 'Win32_Process' `
        -Filter "ParentProcessId = $RootProcessId" `
        -ErrorAction SilentlyContinue
    )
  }

  foreach ($child in $children) {
    Stop-ProcessTree -RootProcessId ([int]$child.ProcessId)
  }

  if (Test-ProcessRunning -ProcessId $RootProcessId) {
    Stop-Process -Id $RootProcessId -Force -ErrorAction SilentlyContinue
  }
}

function Remove-StateFile {
  if (Test-Path -LiteralPath $StatePath) {
    Remove-Item -LiteralPath $StatePath -Force
  }
}

function Stop-RecordedProcesses {
  if (-not (Test-Path -LiteralPath $StatePath)) {
    Write-Step '没有找到正在记录的 Euphony 本地服务。'
    return
  }

  $state = Get-Content -LiteralPath $StatePath -Raw | ConvertFrom-Json
  # PID 可能被系统复用，先确认记录属于当前仓库，避免误停其他项目脚本。
  if ($state.projectRoot -ne $ProjectRoot) {
    throw "记录文件属于另一个项目目录：$($state.projectRoot)。不会停止不属于当前项目的进程。"
  }

  # 先删除状态文件，让正在托管服务的脚本把这次停止识别成用户请求。
  $recordedProcessIds = @($state.backendPid, $state.frontendPid)
  Remove-StateFile

  foreach ($processId in $recordedProcessIds) {
    if ($null -ne $processId -and (Test-ProcessRunning -ProcessId ([int]$processId))) {
      Stop-ProcessTree -RootProcessId ([int]$processId)
    }
  }

  Write-Step '已停止记录的 Euphony 前后端进程。'
}

function Assert-RequiredCommand {
  param([Parameter(Mandatory = $true)][string]$Name)

  if (-not (Get-Command -Name $Name -ErrorAction SilentlyContinue)) {
    throw "找不到命令 $Name。请先安装 $Name，并确认它在当前 PowerShell 的 PATH 中。"
  }
}

function Resolve-ListenIPAddress {
  param([Parameter(Mandatory = $true)][string]$Address)

  $parsedAddress = $null
  if ([System.Net.IPAddress]::TryParse($Address, [ref]$parsedAddress)) {
    return $parsedAddress
  }

  try {
    $resolvedAddresses = @([System.Net.Dns]::GetHostAddresses($Address))
  } catch {
    throw "无法解析监听地址 ${Address}。请通过 -HostAddress 指定有效的本机 IP 地址。"
  }

  # 主流程使用 IPv4 回环地址；主机名同时解析出 IPv4/IPv6 时优先匹配这个监听方式。
  $resolvedAddress = $resolvedAddresses |
    Where-Object { $_.AddressFamily -eq [System.Net.Sockets.AddressFamily]::InterNetwork } |
    Select-Object -First 1
  if ($null -eq $resolvedAddress) {
    $resolvedAddress = $resolvedAddresses | Select-Object -First 1
  }
  if ($null -eq $resolvedAddress) {
    throw "监听地址 ${Address} 没有可用的 IP。请通过 -HostAddress 指定有效的本机 IP 地址。"
  }

  return $resolvedAddress
}

function Assert-TcpPortAvailable {
  param(
    [Parameter(Mandatory = $true)][string]$Name,
    [Parameter(Mandatory = $true)][string]$Address,
    [Parameter(Mandatory = $true)][int]$Port,
    [Parameter(Mandatory = $true)][string]$PortParameterName
  )

  $listenAddress = Resolve-ListenIPAddress -Address $Address
  $listener = $null
  try {
    # 先做一次真实 bind，能同时识别普通占用和 Windows 排除端口范围导致的 10013。
    $listener = [System.Net.Sockets.TcpListener]::new($listenAddress, $Port)
    $listener.Start()
  } catch {
    $socketError = $_.Exception
    while ($null -ne $socketError.InnerException) {
      $socketError = $socketError.InnerException
    }

    if ($socketError -isnot [System.Net.Sockets.SocketException]) {
      throw
    }

    throw "${Name}端口 ${Address}:$Port 不可用（套接字错误 $($socketError.ErrorCode)）。请释放该端口，或通过 -$PortParameterName 指定其他可用端口。"
  } finally {
    if ($null -ne $listener) {
      $listener.Stop()
    }
  }
}

function Invoke-ProjectCommand {
  param(
    [Parameter(Mandatory = $true)][string]$DisplayName,
    [Parameter(Mandatory = $true)][scriptblock]$Command
  )

  Write-Step $DisplayName
  Push-Location -LiteralPath $ProjectRoot
  try {
    & $Command
    if ($LASTEXITCODE -ne 0) {
      throw "$DisplayName 失败，退出码 $LASTEXITCODE。"
    }
  } finally {
    Pop-Location
  }
}

function Get-PowerShellExecutable {
  foreach ($candidate in @(
      (Join-Path $PSHOME 'pwsh.exe'),
      (Join-Path $PSHOME 'powershell.exe')
    )) {
    if (Test-Path -LiteralPath $candidate) {
      return $candidate
    }
  }

  foreach ($commandName in @('pwsh', 'powershell')) {
    $command = Get-Command -Name $commandName -ErrorAction SilentlyContinue
    if ($null -ne $command) {
      return $command.Source
    }
  }

  throw '找不到可用的 PowerShell 可执行文件。'
}

function Register-ProcessOutput {
  param(
    [Parameter(Mandatory = $true)][System.Diagnostics.Process]$Process,
    [Parameter(Mandatory = $true)][string]$Name,
    [Parameter(Mandatory = $true)][string]$StreamName
  )

  $eventName = if ($StreamName -eq 'stdout') {
    'OutputDataReceived'
  } else {
    'ErrorDataReceived'
  }

  $subscription = Register-ObjectEvent `
    -InputObject $Process `
    -EventName $eventName `
    -MessageData $Name `
    -Action {
      if (-not [string]::IsNullOrWhiteSpace($EventArgs.Data)) {
        Write-Host "[$($Event.MessageData)] $($EventArgs.Data)"
      }
    }

  $EventSubscriptions.Add($subscription) | Out-Null
}

function Start-LoggedProcess {
  param(
    [Parameter(Mandatory = $true)][string]$Name,
    [Parameter(Mandatory = $true)][string]$CommandText
  )

  $encodedCommand = [Convert]::ToBase64String(
    [System.Text.Encoding]::Unicode.GetBytes($CommandText)
  )

  # 通过 EncodedCommand 避免路径、API key 或参数里的引号破坏子进程命令行。
  $startInfo = New-Object System.Diagnostics.ProcessStartInfo
  $startInfo.FileName = Get-PowerShellExecutable
  $startInfo.Arguments = "-NoProfile -ExecutionPolicy Bypass -EncodedCommand $encodedCommand"
  $startInfo.WorkingDirectory = $ProjectRoot
  $startInfo.UseShellExecute = $false
  $startInfo.RedirectStandardOutput = $true
  $startInfo.RedirectStandardError = $true
  $startInfo.CreateNoWindow = $true

  $process = New-Object System.Diagnostics.Process
  $process.StartInfo = $startInfo
  $process.EnableRaisingEvents = $true

  if (-not $process.Start()) {
    throw "启动 $Name 失败。"
  }

  Register-ProcessOutput -Process $process -Name $Name -StreamName 'stdout'
  Register-ProcessOutput -Process $process -Name $Name -StreamName 'stderr'
  $process.BeginOutputReadLine()
  $process.BeginErrorReadLine()

  Write-Step "$Name 已启动，PID $($process.Id)。"
  return $process
}

function Assert-ProcessAlive {
  param(
    [Parameter(Mandatory = $true)][System.Diagnostics.Process]$Process,
    [Parameter(Mandatory = $true)][string]$Name
  )

  if ($Process.HasExited) {
    throw "$Name 已退出，退出码 $($Process.ExitCode)。请查看上方日志。"
  }
}

function Wait-ForHttp {
  param(
    [Parameter(Mandatory = $true)][string]$Name,
    [Parameter(Mandatory = $true)][string]$Url,
    [Parameter(Mandatory = $true)][int]$TimeoutSeconds,
    [Parameter(Mandatory = $true)][System.Diagnostics.Process[]]$Processes
  )

  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    foreach ($process in $Processes) {
      Assert-ProcessAlive -Process $process -Name "进程 $($process.Id)"
    }

    try {
      $response = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 2
      if ($response.StatusCode -ge 200 -and $response.StatusCode -lt 500) {
        Write-Step "$Name 已就绪：$Url"
        return
      }
    } catch {
      Start-Sleep -Milliseconds 500
    }
  }

  throw "$Name 在 $TimeoutSeconds 秒内未就绪：$Url"
}

function Save-State {
  param(
    [Parameter(Mandatory = $true)][System.Diagnostics.Process]$BackendProcess,
    [Parameter(Mandatory = $true)][System.Diagnostics.Process]$FrontendProcess
  )

  # 临时状态文件只保存 PID 和 URL，用于另一个终端里的 -Stop 清理残留服务。
  [ordered]@{
    projectRoot = $ProjectRoot
    backendPid = $BackendProcess.Id
    frontendPid = $FrontendProcess.Id
    backendUrl = $BackendUrl
    frontendUrl = $FrontendUrl
    createdAt = (Get-Date).ToString('o')
  } | ConvertTo-Json | Set-Content -LiteralPath $StatePath -Encoding UTF8
}

function Assert-NoRecordedService {
  if (-not (Test-Path -LiteralPath $StatePath)) {
    return
  }

  $state = Get-Content -LiteralPath $StatePath -Raw | ConvertFrom-Json
  $runningPids = @($state.backendPid, $state.frontendPid) | Where-Object {
    $null -ne $_ -and (Test-ProcessRunning -ProcessId ([int]$_))
  }

  if ($runningPids.Count -gt 0) {
    throw "检测到已有 Euphony 本地服务正在运行：$($runningPids -join ', ')。请先运行本脚本并传入 -Stop。"
  }

  Remove-StateFile
}

if ($Stop) {
  Stop-RecordedProcesses
  return
}

Assert-NoRecordedService
Assert-RequiredCommand -Name 'uv'
Assert-RequiredCommand -Name 'pnpm'
Assert-TcpPortAvailable `
  -Name '后端' `
  -Address $HostAddress `
  -Port $BackendPort `
  -PortParameterName 'BackendPort'
Assert-TcpPortAvailable `
  -Name '前端' `
  -Address $HostAddress `
  -Port $FrontendPort `
  -PortParameterName 'FrontendPort'

if (-not $SkipInstall) {
  Invoke-ProjectCommand -DisplayName '同步 Python 依赖：uv sync' -Command { uv sync }

  if (-not (Test-Path -LiteralPath (Join-Path $ProjectRoot 'node_modules'))) {
    Invoke-ProjectCommand -DisplayName '安装前端依赖：pnpm install --frozen-lockfile' -Command {
      pnpm install --frozen-lockfile
    }
  } else {
    Write-Step '已找到 node_modules，跳过 pnpm install。'
  }
}

$rootLiteral = ConvertTo-PowerShellLiteral -Value $ProjectRoot
$backendCommandLines = New-Object System.Collections.Generic.List[string]
$backendCommandLines.Add("`$ErrorActionPreference = 'Stop'") | Out-Null
$backendCommandLines.Add("Set-Location -LiteralPath $rootLiteral") | Out-Null

if ([string]::IsNullOrWhiteSpace($OpenAiApiKey)) {
  Write-Step '未设置 OPEN_AI_API_KEY；本地 Codex sessions 浏览可用，后端翻译接口会返回配置错误。'
} else {
  $apiKeyLiteral = ConvertTo-PowerShellLiteral -Value $OpenAiApiKey
  $backendCommandLines.Add("`$env:OPEN_AI_API_KEY = $apiKeyLiteral") | Out-Null
}

$backendCommandLines.Add(
  "uv run uvicorn fastapi-main:app --app-dir server --host $HostAddress --port $BackendPort --reload"
) | Out-Null
$backendCommand = $backendCommandLines -join "`r`n"
$backendUrlLiteral = ConvertTo-PowerShellLiteral -Value $BackendUrl

if ($ClearProxy) {
  # OpenAI Python 客户端会读取代理环境变量；无 socksio 时清理 SOCKS 代理可避免导入失败。
  $proxyReset = @"
`$env:ALL_PROXY = ''
`$env:HTTPS_PROXY = ''
`$env:HTTP_PROXY = ''
`$env:all_proxy = ''
`$env:https_proxy = ''
`$env:http_proxy = ''
"@
  $backendCommand = "$proxyReset`r`n$backendCommand"
}

$frontendCommand = @"
`$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $rootLiteral
`$env:VITE_EUPHONY_FRONTEND_ONLY = 'false'
`$env:VITE_EUPHONY_API_URL = $backendUrlLiteral
pnpm exec vite --host $HostAddress --port $FrontendPort --strictPort
"@

$backendProcess = $null
$frontendProcess = $null

try {
  $backendProcess = Start-LoggedProcess -Name 'backend' -CommandText $backendCommand
  $frontendProcess = Start-LoggedProcess -Name 'frontend' -CommandText $frontendCommand
  Save-State -BackendProcess $backendProcess -FrontendProcess $frontendProcess

  Wait-ForHttp -Name '后端' -Url $BackendPingUrl -TimeoutSeconds 60 -Processes @($backendProcess, $frontendProcess)
  Wait-ForHttp -Name '前端' -Url $FrontendUrl -TimeoutSeconds 60 -Processes @($backendProcess, $frontendProcess)

  if (-not $NoBrowser) {
    Write-Step "打开浏览器：$FrontendUrl"
    Start-Process $FrontendUrl
  }

  Write-Step '前后端运行中。按 Ctrl+C 可同时停止；如果终端被直接关闭，可重新运行脚本并传入 -Stop。'

  while ($true) {
    if (-not (Test-Path -LiteralPath $StatePath)) {
      Write-Step '检测到停止请求，正在退出。'
      break
    }

    Assert-ProcessAlive -Process $backendProcess -Name 'backend'
    Assert-ProcessAlive -Process $frontendProcess -Name 'frontend'
    Start-Sleep -Seconds 1
  }
} finally {
  foreach ($subscription in $EventSubscriptions) {
    Unregister-Event -SubscriptionId $subscription.Id -ErrorAction SilentlyContinue
    Remove-Job -Id $subscription.Id -Force -ErrorAction SilentlyContinue
  }

  foreach ($process in @($backendProcess, $frontendProcess)) {
    if ($null -ne $process -and -not $process.HasExited) {
      Stop-ProcessTree -RootProcessId $process.Id
    }
  }

  Remove-StateFile
  Write-Step '已清理 Euphony 本地服务进程。'
}
