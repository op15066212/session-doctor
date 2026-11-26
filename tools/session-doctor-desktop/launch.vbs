' 无窗口启动器。.lnk 指向 wscript.exe + 这个文件，而不是 .cmd。
'
' 为什么要有这一层（2026-11-25 用户截图：窗口后面一大块黑）：
'   .cmd 双击必然开一个控制台窗口，而它要等 node/Electron 退出才结束 ——
'   于是应用开着的时候，那个黑框一直挂在后面。
'   WScript.Shell.Run(cmd, 0, False) 的 0 = 隐藏窗口，False = 不等它结束。
'   这一层只做「藏起来」，逻辑全在 launch.mjs。
'
' 反例：用 PowerShell -WindowStyle Hidden 起 cmd 仍会闪一下（控制台先建后隐藏）；
' wscript 从一开始就不建控制台窗口。

Option Explicit
Dim sh, fso, appDir, nodeExe, cmdline, rc

Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

appDir = fso.GetParentFolderName(WScript.ScriptFullName)

' 找 node：先看 PATH，找不到就报错退出（不弹窗，写到同目录的 last-error.txt）
On Error Resume Next
rc = sh.Run("cmd /c where node >nul 2>nul", 0, True)
On Error Goto 0
If rc <> 0 Then
  Dim logFile
  Set logFile = fso.CreateTextFile(appDir & "\last-error.txt", True)
  logFile.WriteLine "找不到 node。装 Node.js 后重试：https://nodejs.org"
  logFile.Close
  WScript.Quit 1
End If

cmdline = "node """ & appDir & "\launch.mjs"""
' 透传参数（--port / --dir / --no-open 等）
Dim args, i
Set args = WScript.Arguments
For i = 0 To args.Count - 1
  cmdline = cmdline & " """ & args(i) & """"
Next

' 0 = 隐藏控制台，False = 不等待
sh.Run cmdline, 0, False
