# 在 VM 上注册开机自启（直接跑 node.exe，不经 cmd，所以没有窗口可关）
$node = "C:\Program Files\nodejs\node.exe"
$runner = "C:\Users\chensen\AppData\Roaming\npm\node_modules\agent-hub-runner\runner.mjs"
Unregister-ScheduledTask -TaskName "AgentHubRunner" -Confirm:$false -ErrorAction SilentlyContinue
$action = New-ScheduledTaskAction -Execute $node -Argument "`"$runner`" start"
$trigger = New-ScheduledTaskTrigger -AtLogOn
Register-ScheduledTask -TaskName "AgentHubRunner" -Action $action -Trigger $trigger -Force | Out-Null
Start-ScheduledTask -TaskName "AgentHubRunner"
Write-Output "registered"
