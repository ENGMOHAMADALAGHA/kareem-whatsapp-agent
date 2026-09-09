' ============================================================
'  Wasl Command Center — hidden desktop launcher (Windows)
'  Double-click: boots backend + opens the app window.
'  No console window appears. Logs go to logs\desktop.log
' ============================================================
Dim sh, fso, root, logFile, cmd
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
root = fso.GetParentFolderName(WScript.ScriptFullName)
If Not fso.FolderExists(root & "\logs") Then fso.CreateFolder(root & "\logs")
logFile = root & "\logs\desktop.log"
' cmd quirk: paths with spaces need cmd /s /c with doubled outer quotes
cmd = "cmd /s /c " & Chr(34) & Chr(34) & root & "\scripts\launch-hidden.cmd" & Chr(34) _
  & " >> " & Chr(34) & logFile & Chr(34) & " 2>&1" & Chr(34)
sh.Run cmd, 0, False
Set sh = Nothing
Set fso = Nothing
