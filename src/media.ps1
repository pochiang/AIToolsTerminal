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
$tries = 0
$coverSent = $false
$site = $null

# A browser only reports itself; the site playing (YouTube, ...) is guessed from
# the browser's window titles, preferring one that contains the track title.
$sites = 'YouTube Music', 'YouTube', 'Netflix', 'Twitch', 'SoundCloud', 'bilibili', 'Spotify', 'Apple Music'
function Site($app, $title) {
  $proc = if ($app -match 'chrome') { 'chrome' } elseif ($app -match 'edge') { 'msedge' }
    elseif ($app -match 'firefox|308046B0AF4A39CB') { 'firefox' } elseif ($app -match 'brave') { 'brave' }
    elseif ($app -match 'opera') { 'opera' } else { return $null }
  $titles = @(Get-Process -Name $proc -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle } | ForEach-Object { $_.MainWindowTitle })
  $titles = @($titles | Where-Object { $title -and $_.Contains($title) }) + $titles
  foreach ($t in $titles) { foreach ($name in $sites) { if ($t -match [regex]::Escape($name)) { return $name } } }
  $null
}

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
  # The cover travels once per track. Players often set it (and browsers their
  # window title) a moment after the track changes, so retry for a few polls.
  $key = "$($r.app)|$($r.title)|$($r.artist)"
  if ($key -ne $script:lastKey) {
    $script:lastKey = $key
    $script:tries = 0
    $script:coverSent = $false
    $script:site = $null
  }
  if ($script:tries -lt 5) {
    $script:tries++
    if ($hasCover -and -not $script:coverSent) {
      try { $cover = [AittCover]::Read($s) } catch { $cover = $null }
      if ($cover) {
        $r.cover = $cover
        $script:coverSent = $true
      }
    }
    if (-not $script:site) { try { $script:site = Site $r.app $r.title } catch {} }
  }
  $r.site = $script:site
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
