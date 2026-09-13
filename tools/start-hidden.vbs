' 观影室 —— 无窗口启动
'
' 双击 tools\start.bat 会留一个控制台窗口；用这个脚本启动则完全后台运行，
' 输出重定向到 data\server.log，随时可以去看。
'
' 由 tools\install-autostart.ps1 注册为开机自启时也是调用它。

Option Explicit

Dim fso, sh, root, logDir, logFile, cmd

Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")

' 本脚本在 tools\ 下，工程根目录是它的上一级
root = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))
sh.CurrentDirectory = root

logDir = fso.BuildPath(root, "data")
If Not fso.FolderExists(logDir) Then
  fso.CreateFolder(logDir)
End If

logFile = fso.BuildPath(logDir, "server.log")

cmd = "cmd /c node """ & fso.BuildPath(root, "src\server.js") & """ >> """ & logFile & """ 2>&1"

' 0 = 隐藏窗口，False = 不等待
sh.Run cmd, 0, False
