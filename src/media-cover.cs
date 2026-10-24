// Cover art for the now-playing widget. media.js compiles this with the
// .NET Framework csc.exe (only WinRT metadata, no SDK needed) and media.ps1
// loads it: Windows PowerShell 5.1 cannot use the WinRT stream objects itself.
using System;
using System.Threading;
using Windows.Foundation;
using Windows.Media.Control;
using Windows.Storage.Streams;
public static class AittCover {
  // WaitOne pumps COM messages on PowerShell's STA thread, so the completion
  // callback can run; a Sleep loop would deadlock.
  static T Wait<T>(IAsyncOperation<T> op) {
    var done = new ManualResetEvent(op.Status != AsyncStatus.Started);
    op.Completed = (o, status) => done.Set();
    if (!done.WaitOne(5000)) { op.Cancel(); throw new TimeoutException(); }
    return op.GetResults();
  }
  public static string Read(GlobalSystemMediaTransportControlsSession session) {
    if (session == null) return null;
    var props = Wait(session.TryGetMediaPropertiesAsync());
    if (props.Thumbnail == null) return null;
    var stream = Wait(props.Thumbnail.OpenReadAsync());
    var size = (uint)stream.Size;
    var reader = new DataReader(stream.GetInputStreamAt(0));
    Wait(reader.LoadAsync(size));
    var bytes = new byte[size];
    reader.ReadBytes(bytes);
    var type = string.IsNullOrEmpty(stream.ContentType) ? "image/png" : stream.ContentType;
    return "data:" + type + ";base64," + Convert.ToBase64String(bytes);
  }
}
