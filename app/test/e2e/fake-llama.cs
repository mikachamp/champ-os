// Stand-in for llama-server used only by the e2e test. Records argv, waits, then serves /v1/models.
using System;
using System.IO;
using System.Net;
using System.Text;
using System.Threading;

class FakeLlama {
  static void Main(string[] args) {
    int port = 0;
    for (int i = 0; i < args.Length - 1; i++) if (args[i] == "--port") port = int.Parse(args[i + 1]);
    string log = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "argv.txt");
    File.WriteAllText(log, string.Join("\n", args));
    Thread.Sleep(3500); // pretend to load a model
    var l = new HttpListener();
    l.Prefixes.Add("http://127.0.0.1:" + port + "/");
    l.Start();
    while (true) {
      var ctx = l.GetContext();
      byte[] b = Encoding.UTF8.GetBytes("{\"data\":[{\"id\":\"llama-local/tiny\"}]}");
      ctx.Response.ContentType = "application/json";
      ctx.Response.OutputStream.Write(b, 0, b.Length);
      ctx.Response.Close();
    }
  }
}
