# Interact only with the system chooser in the disposable Windows CI desktop.
if ($env:GITHUB_ACTIONS -ne 'true') { throw 'CI only' }
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$root = [System.Windows.Automation.AutomationElement]::RootElement
$tracefold = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty, 'Tracefold')
$listItem = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::ListItem)
$condition = New-Object System.Windows.Automation.AndCondition($tracefold, $listItem)
$deadline = (Get-Date).AddSeconds(20)
$target = $null
while (!$target -and (Get-Date) -lt $deadline) {
  $target = $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $condition)
  if (!$target) { Start-Sleep -Milliseconds 300 }
}
$all = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
$all | ForEach-Object { try { "$($_.Current.ControlType.ProgrammaticName) | $($_.Current.Name) | $($_.Current.AutomationId)" } catch {} } | Set-Content test-results/windows-smoke/capture-controls.txt
if (!$target) { throw 'The Windows chooser did not expose a Tracefold window list item.' }
$selection = $target.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern)
$selection.Select()
$buttonType = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Button)
$shareName = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty, 'Share')
$share = $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, (New-Object System.Windows.Automation.AndCondition($buttonType, $shareName)))
if (!$share) { throw 'The chooser Share button was not found.' }
$share.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
