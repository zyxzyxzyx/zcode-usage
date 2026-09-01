# 创建「ZCode 用量悬浮框」桌面快捷方式（UTF-8 BOM，供 PowerShell 5.1 正确读取中文）
$ErrorActionPreference = 'Stop'

$root    = 'D:\ZCode_Project\ZCode接入火山方舟网关模型Token用量使用统计'
$desktop = [Environment]::GetFolderPath('Desktop')
$lnkPath = Join-Path $desktop 'ZCode 用量悬浮框.lnk'

$ws  = New-Object -ComObject WScript.Shell
$lnk = $ws.CreateShortcut($lnkPath)
$lnk.TargetPath      = Join-Path $root '启动悬浮框.bat'
$lnk.WorkingDirectory = $root
$lnk.IconLocation    = Join-Path $root 'widget\node_modules\electron\dist\electron.exe,0'
$lnk.Description      = 'ZCode 火山方舟网关额度桌面悬浮框（双击启动，常驻托盘）'
$lnk.Save()

Write-Output "created: $lnkPath"
Write-Output "target : $lnk.TargetPath"
