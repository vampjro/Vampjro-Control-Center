using System.Diagnostics;
using Microsoft.Web.WebView2.WinForms;

namespace VampjroHost;

// Minimal native window host: launches the existing Node server as a child
// process and shows its web UI in a real WebView2 window instead of a
// browser tab. Uses the Edge WebView2 runtime already present on Windows
// 10/11 (not a bundled Chromium), keeping this close in spirit to the
// bundled-Node-runtime approach the rest of the installer already uses:
// self-contained, no external dependency the user has to install.
//
// Usage: vampjro-host.exe <title> <url> <nodeExePath> "<nodeArgs incl. script>" [workingDir] [iconPath]
static class Program
{
    [STAThread]
    static int Main(string[] args)
    {
        if (args.Length < 4)
        {
            MessageBox.Show(
                "Argomenti mancanti.\nUso: vampjro-host.exe <titolo> <url> <nodeExe> <scriptRelativo> [workingDir] [iconPath]",
                "VAMPJRO", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 1;
        }

        string title = args[0];
        string url = args[1];
        string nodeExe = args[2];
        string nodeScript = args[3];
        string workingDirRaw = args.Length > 4 && args[4].Length > 0 ? args[4] : Path.GetDirectoryName(nodeExe) ?? ".";
        // Normalizes a trailing "\." (the caller's workaround for the
        // Windows argv-parsing rule where a backslash right before a
        // closing quote escapes the quote instead of ending the argument —
        // "%~dp0" alone breaks this way since %~dp0 always ends in "\").
        string workingDir = Path.GetFullPath(workingDirRaw);
        string? iconPath = args.Length > 5 && args[5].Length > 0 ? args[5] : null;

        ApplicationConfiguration.Initialize();
        Application.Run(new HostForm(title, url, nodeExe, nodeScript, workingDir, iconPath));
        return 0;
    }
}

class HostForm : Form
{
    private readonly string _url;
    private readonly string _nodeExe;
    private readonly string _nodeScript;
    private readonly string _workingDir;
    private WebView2? _webView;
    private Label? _statusLabel;
    private Process? _nodeProcess;
    private System.Windows.Forms.Timer? _pollTimer;
    private bool _navigated;
    private bool _closingIntentionally;

    public HostForm(string title, string url, string nodeExe, string nodeScript, string workingDir, string? iconPath)
    {
        _url = url;
        _nodeExe = nodeExe;
        _nodeScript = nodeScript;
        _workingDir = workingDir;

        Text = title;
        Width = 1280;
        Height = 860;
        StartPosition = FormStartPosition.CenterScreen;
        if (iconPath != null && File.Exists(iconPath))
        {
            try { Icon = new Icon(iconPath); } catch { /* fall back to default icon */ }
        }

        _statusLabel = new Label
        {
            Text = "Avvio di VAMPJRO in corso...",
            Dock = DockStyle.Fill,
            TextAlign = ContentAlignment.MiddleCenter,
            Font = new Font("Segoe UI", 12),
            BackColor = Color.FromArgb(15, 15, 15),
            ForeColor = Color.White
        };
        Controls.Add(_statusLabel);

        Load += HostForm_Load;
        FormClosing += HostForm_FormClosing;
    }

    private void HostForm_Load(object? sender, EventArgs e)
    {
        StartNodeProcess();
        _ = InitWebViewAsync();

        _pollTimer = new System.Windows.Forms.Timer { Interval = 500 };
        _pollTimer.Tick += async (s, ev) => await PollAndNavigateAsync();
        _pollTimer.Start();
    }

    private void StartNodeProcess()
    {
        try
        {
            // ProcessStartInfo.FileName with a relative path resolves against
            // this process's own working directory, not the WorkingDirectory
            // set below for the child — resolve it ourselves so "runtime\node.exe"
            // (as passed by the launcher .bat, relative to the app folder) works.
            string resolvedNodeExe = Path.IsPathRooted(_nodeExe) ? _nodeExe : Path.Combine(_workingDir, _nodeExe);

            var psi = new ProcessStartInfo
            {
                FileName = resolvedNodeExe,
                WorkingDirectory = _workingDir,
                UseShellExecute = false,
                CreateNoWindow = true,
                // A GUI (WinExe) host has no console handles for a child to
                // inherit, so without redirecting, the child's stderr/stdout
                // simply vanish — capture them so a crash is diagnosable.
                RedirectStandardOutput = true,
                RedirectStandardError = true
            };
            // Allows flags before the script, e.g. "--max-old-space-size=128 server/index.js".
            foreach (var part in _nodeScript.Split(' ', StringSplitOptions.RemoveEmptyEntries))
                psi.ArgumentList.Add(part);
            LogDebug($"Starting node: FileName='{resolvedNodeExe}' Args='{string.Join(" ", psi.ArgumentList)}' WorkDir='{_workingDir}' Exists={File.Exists(resolvedNodeExe)}");
            _nodeProcess = Process.Start(psi);
            if (_nodeProcess != null)
            {
                _nodeProcess.EnableRaisingEvents = true;
                _nodeProcess.OutputDataReceived += (s, ev) => { if (ev.Data != null) LogDebug("[node stdout] " + ev.Data); };
                _nodeProcess.ErrorDataReceived += (s, ev) => { if (ev.Data != null) LogDebug("[node stderr] " + ev.Data); };
                _nodeProcess.BeginOutputReadLine();
                _nodeProcess.BeginErrorReadLine();
                _nodeProcess.Exited += (s, ev) => LogDebug($"node process exited, code={_nodeProcess.ExitCode}");
            }
            LogDebug($"Started node PID={_nodeProcess?.Id}");
        }
        catch (Exception ex)
        {
            LogDebug("StartNodeProcess EXCEPTION: " + ex);
            if (_statusLabel != null) _statusLabel.Text = "Impossibile avviare il server VAMPJRO:\n" + ex.Message;
        }
    }

    private void LogDebug(string msg)
    {
        try { File.AppendAllText(Path.Combine(_workingDir, "webview-host-debug.log"), $"[{DateTime.Now:HH:mm:ss}] {msg}\n"); } catch { }
    }

    private async Task InitWebViewAsync()
    {
        _webView = new WebView2 { Dock = DockStyle.Fill, Visible = false };
        Controls.Add(_webView);
        try
        {
            await _webView.EnsureCoreWebView2Async(null);
        }
        catch (Exception ex)
        {
            if (_statusLabel != null)
                _statusLabel.Text = "Runtime WebView2 non disponibile.\n" + ex.Message +
                    "\n\nScaricalo da https://developer.microsoft.com/microsoft-edge/webview2/";
        }
    }

    private async Task PollAndNavigateAsync()
    {
        if (_navigated) { _pollTimer?.Stop(); return; }

        if (_nodeProcess != null && _nodeProcess.HasExited)
        {
            _pollTimer?.Stop();
            if (_statusLabel != null)
                _statusLabel.Text = $"Il server VAMPJRO si e' arrestato inaspettatamente (codice {_nodeProcess.ExitCode}).";
            return;
        }

        if (_webView?.CoreWebView2 == null) return;

        try
        {
            using var client = new HttpClient { Timeout = TimeSpan.FromMilliseconds(800) };
            var res = await client.GetAsync(_url);
            if (res.IsSuccessStatusCode || (int)res.StatusCode < 500)
            {
                _navigated = true;
                _pollTimer?.Stop();
                _webView.Visible = true;
                if (_statusLabel != null) _statusLabel.Visible = false;
                _webView.CoreWebView2.Navigate(_url);
            }
        }
        catch
        {
            // Server not ready yet; keep polling silently.
        }
    }

    private void HostForm_FormClosing(object? sender, FormClosingEventArgs e)
    {
        if (_closingIntentionally) return;
        _closingIntentionally = true;

        if (_nodeProcess != null && !_nodeProcess.HasExited)
        {
            try
            {
                // Kill the whole process tree (node spawns its own runtime
                // process); plain Process.Kill() would leave it orphaned.
                var killPsi = new ProcessStartInfo
                {
                    FileName = "taskkill",
                    Arguments = $"/PID {_nodeProcess.Id} /T /F",
                    UseShellExecute = false,
                    CreateNoWindow = true,
                    RedirectStandardOutput = true,
                    RedirectStandardError = true
                };
                using var kill = Process.Start(killPsi);
                kill?.WaitForExit(5000);
            }
            catch { /* best effort */ }
        }
    }
}
