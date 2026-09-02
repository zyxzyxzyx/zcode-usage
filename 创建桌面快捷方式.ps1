# 创建/更新「ZCode 用量悬浮框」桌面快捷方式（UTF-8 BOM）
$ErrorActionPreference = 'Stop'

$root    = 'D:\ZCode_Project\ZCode接入火山方舟网关模型Token用量使用统计'
$widget  = Join-Path $root 'widget'
$desktop = [Environment]::GetFolderPath('Desktop')
$lnkPath = Join-Path $desktop 'ZCode 用量悬浮框.lnk'

$electron = Join-Path $widget 'node_modules\electron\dist\electron.exe'
if (-not (Test-Path $electron)) { throw "electron.exe not found: $electron" }

$ws  = New-Object -ComObject WScript.Shell
$lnk = $ws.CreateShortcut($lnkPath)
$lnk.TargetPath       = $electron
$lnk.Arguments        = '"' + $widget + '"'
$lnk.WorkingDirectory = $widget
$lnk.IconLocation     = "$electron,0"
$lnk.Description      = 'ZCode 火山方舟网关额度桌面悬浮框（无后台窗口；退出请用悬浮卡菜单或托盘）'
$lnk.Save()

Write-Output ("created: " + $lnkPath)
Write-Output ("target : " + $lnk.TargetPath)
Write-Output ("args   : " + $lnk.Arguments)
