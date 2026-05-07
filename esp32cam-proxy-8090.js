const http = require("http");

const ESP_HOST = "10.226.149.33";

// ESP32-CAM:
// - /capture ở port 80
// - /stream ở port 81
const ESP_HTTP_PORT = 80;
const PROXY_PORT = 8090;

// Bản ổn định.
// 300ms ≈ 3 FPS, ảnh đẹp và ít lỗi.
// Nếu muốn mượt hơn nhẹ, đổi 300 thành 250 hoặc 220.
const FRAME_INTERVAL_MS = 100;

let latestFrame = null;
let latestFrameAt = null;
let latestError = null;
let fetching = false;

function fetchOneFrame() {
  if (fetching) return;

  fetching = true;

  const req = http.request(
    {
      hostname: ESP_HOST,
      port: ESP_HTTP_PORT,
      path: "/capture",
      method: "GET",
      headers: {
        "User-Agent": "SmartAquariumFrameCache",
        Accept: "image/jpeg,*/*",
        Connection: "close",
      },
      timeout: 5000,
    },
    (res) => {
      const chunks = [];

      res.on("data", (chunk) => chunks.push(chunk));

      res.on("end", () => {
        fetching = false;

        const buffer = Buffer.concat(chunks);

        if (res.statusCode === 200 && buffer.length > 1000) {
          latestFrame = buffer;
          latestFrameAt = new Date();
          latestError = null;
          return;
        }

        latestError = `ESP capture failed: status=${res.statusCode}, size=${buffer.length}`;
        console.log(latestError);
      });
    }
  );

  req.on("timeout", () => {
    fetching = false;
    latestError = "ESP capture timeout";
    console.log(latestError);
    req.destroy();
  });

  req.on("error", (err) => {
    fetching = false;
    latestError = err.message;
    console.log("ESP capture error:", err.message);
  });

  req.end();
}

// Lấy frame nền liên tục
setInterval(fetchOneFrame, FRAME_INTERVAL_MS);
fetchOneFrame();

function sendHomePage(res) {
  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
  });

  res.end(`
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Smart Aquarium Camera</title>
  <style>
    body {
      margin: 0;
      background: #0f172a;
      color: white;
      font-family: Arial, sans-serif;
    }
    .wrap {
      padding: 16px;
    }
    img {
      width: 100%;
      max-width: 960px;
      background: black;
      border: 1px solid #334155;
      border-radius: 12px;
      display: block;
    }
    .ok {
      color: #22c55e;
      font-weight: bold;
    }
    .hint {
      color: #cbd5e1;
      font-size: 14px;
    }
  </style>
</head>
<body>
  <div class="wrap">
    <h2>Smart Aquarium Camera - Stable Snapshot</h2>
    <p class="ok">Cloudflare → Laptop Proxy Cache → ESP32-CAM</p>
    <p class="hint">
      Bản này ưu tiên ổn định và chất lượng ảnh, không ráng 20 FPS.
    </p>

    <img id="cam" src="/snapshot?t=0" />
    <p id="status" class="hint">Đang tải camera...</p>
  </div>

  <script>
    const img = document.getElementById("cam");
    const status = document.getElementById("status");

    const REFRESH_MS = 160;

    function refreshImage() {
      const url = "/snapshot?t=" + Date.now();

      const temp = new Image();

      temp.onload = function () {
        img.src = url;
        status.textContent = "Cập nhật: " + new Date().toLocaleTimeString();
      };

      temp.onerror = function () {
        status.textContent = "Không lấy được ảnh. Kiểm tra ESP32-CAM hoặc proxy.";
      };

      temp.src = url;
    }

    refreshImage();
    setInterval(refreshImage, REFRESH_MS);
  </script>
</body>
</html>
  `);
}

function sendSnapshot(res) {
  if (!latestFrame) {
    res.writeHead(503, {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*",
    });

    res.end(
      "Chưa có frame từ ESP32-CAM. Lỗi gần nhất: " +
        (latestError || "đang khởi động")
    );
    return;
  }

  res.writeHead(200, {
    "Content-Type": "image/jpeg",
    "Content-Length": latestFrame.length,
    "Cache-Control": "no-cache, no-store, must-revalidate",
    Pragma: "no-cache",
    Expires: "0",
    "Access-Control-Allow-Origin": "*",
    "X-Frame-Time": latestFrameAt ? latestFrameAt.toISOString() : "",
  });

  res.end(latestFrame);
}

function sendStatus(res) {
  res.writeHead(200, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
  });

  res.end(
    JSON.stringify(
      {
        ok: Boolean(latestFrame),
        frame_size: latestFrame ? latestFrame.length : 0,
        frame_time: latestFrameAt,
        latest_error: latestError,
        frame_interval_ms: FRAME_INTERVAL_MS,
      },
      null,
      2
    )
  );
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host}`);
  const path = url.pathname;

  if (path === "/" || path === "/index.html" || path === "/camera") {
    return sendHomePage(res);
  }

  if (path === "/snapshot" || path === "/shot.jpg" || path === "/capture") {
    return sendSnapshot(res);
  }

  if (path === "/health" || path === "/status") {
    return sendStatus(res);
  }

  return sendHomePage(res);
});

server.listen(PROXY_PORT, "0.0.0.0", () => {
  console.log("ESP32-CAM proxy running - STABLE SNAPSHOT");
  console.log(`Proxy page    : http://localhost:${PROXY_PORT}`);
  console.log(`Proxy snapshot: http://localhost:${PROXY_PORT}/snapshot`);
  console.log(`Proxy status  : http://localhost:${PROXY_PORT}/status`);
  console.log(`ESP capture   : http://${ESP_HOST}:${ESP_HTTP_PORT}/capture`);
  console.log(`Frame interval: ${FRAME_INTERVAL_MS} ms`);
});