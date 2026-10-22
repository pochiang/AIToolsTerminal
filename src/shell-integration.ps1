# Loaded into Terminal tabs (after the user's profile) so the app can tell when
# a command runs: OSC 133;C;<base64 command> when a line is accepted, and
# OSC 133;D;<exit code> before the next prompt. Works on Windows PowerShell 5.1.
$global:__aittPrompt = $function:prompt
$global:__aittRunning = $false

function global:prompt {
  $ok = $?
  $code = $global:LASTEXITCODE
  $e = [char]27
  $mark = ''
  if ($global:__aittRunning) {
    $global:__aittRunning = $false
    # $LASTEXITCODE only changes for native programs; a stale one means a
    # PowerShell error.
    $exit = if ($ok) { 0 } elseif ($code -and $code -ne $global:__aittCode) { $code } else { 1 }
    $mark = "$e]133;D;$exit$([char]7)"
  }
  $mark + (& $global:__aittPrompt)
}

if (Get-Command PSConsoleHostReadLine -ErrorAction SilentlyContinue) {
  $global:__aittReadLine = $function:PSConsoleHostReadLine
  function global:PSConsoleHostReadLine {
    $line = & $global:__aittReadLine
    if ($line -and $line.Trim()) {
      $global:__aittRunning = $true
      $global:__aittCode = $global:LASTEXITCODE
      $cmd = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($line))
      [Console]::Write("$([char]27)]133;C;$cmd$([char]7)")
    }
    $line
  }
}
