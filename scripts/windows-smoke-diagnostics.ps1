# Diagnostic evidence from the disposable GitHub Actions desktop only.
if ($env:GITHUB_ACTIONS -ne 'true') { throw 'CI only' }
$directory = 'test-results/windows-smoke'
Get-Process | Where-Object { $_.ProcessName -match 'tracefold|edge|WerFault' } | Select-Object Id, ProcessName, MainWindowTitle, Responding, SessionId | Format-List | Out-File "$directory/processes.txt"
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen
$bitmap = New-Object System.Drawing.Bitmap($bounds.Width, $bounds.Height)
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
$bitmap.Save((Join-Path (Get-Location) "$directory/desktop.png"))
$graphics.Dispose()
$bitmap.Dispose()
Get-WinEvent -FilterHashtable @{LogName='Application'; StartTime=(Get-Date).AddMinutes(-5)} -ErrorAction SilentlyContinue | Where-Object { $_.Level -le 3 } | Select-Object TimeCreated, ProviderName, Id, Message | Format-List | Out-File "$directory/events.txt"
