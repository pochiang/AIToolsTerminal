# Now-playing helper for the top bar: reads Windows' media session (the one the
# media keys control: Spotify, browsers, ...) and answers one JSON line per
# command read from stdin: poll | toggle | next | prev.
# Needs Windows PowerShell 5.1, which can project WinRT types (pwsh cannot).
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$asTask = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
} | Select-Object -First 1
function Await($op, [Type]$type) {
  $task = $asTask.MakeGenericMethod($type).Invoke($null, @($op))
  $task.Wait(5000) | Out-Null
  $task.Result
}

$null = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime]
$manager = Await ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])
# Cover art comes from media-cover.cs, compiled by the app; without it, no cover.
$hasCover = $false
if ($env:AITT_COVER_DLL) { try { Add-Type -Path $env:AITT_COVER_DLL; $hasCover = $true } catch {} }
$lastKey = $null
$coverTries = 0

function Poll {
  $s = $manager.GetCurrentSession()
  if (-not $s) { return @{ none = $true } }
  $props = Await ($s.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])
  $info = $s.GetPlaybackInfo()
  $r = @{
    app = $s.SourceAppUserModelId
    title = $props.Title
    artist = $props.Artist
    status = $info.PlaybackStatus.ToString()
    canPrev = $info.Controls.IsPreviousEnabled
    canNext = $info.Controls.IsNextEnabled
  }
  # The cover travels once per track. Players often set it a moment after the
  # title, so keep trying for a few polls.
  $key = "$($r.app)|$($r.title)|$($r.artist)"
  if ($key -ne $script:lastKey) {
    $script:lastKey = $key
    $script:coverTries = 0
    $r.newTrack = $true
  }
  if ($hasCover -and $script:coverTries -lt 5) {
    $script:coverTries++
    try { $cover = [AittCover]::Read($s) } catch { $cover = $null }
    if ($cover) {
      $r.cover = $cover
      $script:coverTries = 5
    }
  }
  $r
}

while ($null -ne ($line = [Console]::In.ReadLine())) {
  try {
    $s = $manager.GetCurrentSession()
    switch ($line.Trim()) {
      'toggle' { if ($s) { $null = Await ($s.TryTogglePlayPauseAsync()) ([bool]) } }
      'next' { if ($s) { $null = Await ($s.TrySkipNextAsync()) ([bool]) } }
      'prev' { if ($s) { $null = Await ($s.TrySkipPreviousAsync()) ([bool]) } }
    }
    $out = Poll
  } catch {
    $out = @{ error = $_.Exception.Message }
  }
  [Console]::Out.WriteLine((ConvertTo-Json -Compress $out))
  [Console]::Out.Flush()
}
