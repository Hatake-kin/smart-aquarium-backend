const http = require("http");

const ESP_HOST = "10.226.149.33";
const ESP_PORT = 81;
const PROXY_PORT = 8088;

function sendHomePage(res) {
  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
  });

  res.end(`
    <html>
      <head>
        <title>ESP32-CAM Proxy</title>
      </head>
      <body style="font-family: Arial; padding: 24px;">
        <h1>ESP32-CAM Proxy OK</h1>
        <p>Nếu thấy trang này là Cloudflare đã vào được proxy.</p>

        <p>Stream:</p>
        <a href="/stream">/stream</a>

        <br/><br/>

        <img 
          src="/stream" 
          style="max-width: 100%; border: 1px solid #ccc; background: #000;" 
        />
      </body>
    </html>
  `);
}

function proxyStream(req, res) {
  console.log("Client connected:", req.url);

  res.socket?.setTimeout(0);

  const espReq = http.request(
    {
      hostname: ESP_HOST,
      port: ESP_PORT,
      path: "/stream",
      method: "GET",
      headers: {
        "User-Agent": "SmartAquarium-Camera-Proxy",
        "Accept": "multipart/x-mixed-replace,image/jpeg,*/*",
        "Connection": "close",
      },
      timeout: 10000,
    },
    (espRes) => {
      const contentType =
        espRes.headers["content-type"] ||
        "multipart/x-mixed-replace; boundary=123456789000000000000987654321";

      console.log("ESP response:", espRes.statusCode, contentType);

      res.writeHead(200, {
        "Content-Type": contentType,
        "Cache-Control": "no-cache, no-store, must-revalidate",
        "Pragma": "no-cache",
        "Expires": "0",
        "Access-Control-Allow-Origin": "*",
        "X-Accel-Buffering": "no",
      });

      espRes.pipe(res);
    }
  );

  espReq.on("timeout", () => {
    console.log("ESP request timeout");
    espReq.destroy();

    if (!res.headersSent) {
      res.writeHead(504, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("ESP32-CAM timeout");
    }
  });

  espReq.on("error", (err) => {
    console.error("Proxy error:", err.message);

    if (!res.headersSent) {
      res.writeHead(502, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Không kết nối được ESP32-CAM: " + err.message);
    } else {
      res.end();
    }
  });

  req.on("close", () => {
    console.log("Client disconnected:", req.url);
    espReq.destroy();
  });

  espReq.end();
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host}`);
  const path = url.pathname;

  console.log("Request:", path);

  if (path === "/" || path === "/index.html") {
    return sendHomePage(res);
  }

  // Nhận nhiều kiểu path để tránh lỗi Not found
  if (
    path === "/stream" ||
    path === "/stream/" ||
    path === "/video" ||
    path === "/video/" ||
    path === "/mjpeg" ||
    path === "/mjpeg/"
  ) {
    return proxyStream(req, res);
  }

  if (path === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ ok: true }));
  }

  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(`Not found: ${path}`);
});

server.listen(PROXY_PORT, "0.0.0.0", () => {
  console.log("ESP32-CAM proxy running");
  console.log(`Local proxy page  : http://localhost:${PROXY_PORT}`);
  console.log(`Local proxy stream: http://localhost:${PROXY_PORT}/stream`);
  console.log(`Origin ESP stream : http://${ESP_HOST}:${ESP_PORT}/stream`);
});