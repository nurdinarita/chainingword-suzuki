const express = require("express");
const path = require("path");
const fs = require("fs");
const http = require("http");
const { Server } = require("socket.io");
const multer = require("multer");
const csv = require("csv-parser");
const os = require("os");
const archiver = require("archiver");

// Serialport
const { SerialPort } = require("serialport");
const { ReadlineParser } = require("@serialport/parser-readline");

// =========================
// GLOBAL & SETUP
// =========================
global.getNow = () => new Date().toLocaleString();

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  pingInterval: 25000,
  pingTimeout: 60000,
  cors: { origin: "*", methods: ["GET","POST"] }
});

const PORT = 8989;
const viewsDir = path.join(__dirname, "views");

// =========================
// HELPER FUNCTIONS
// =========================
function getServerIP() {
  const interfaces = os.networkInterfaces();
  for (const name in interfaces) {
    for (const iface of interfaces[name]) {
      if (iface.family === "IPv4" && !iface.internal) return iface.address;
    }
  }
  return "localhost";
}

function formatDateLocal() {
  const now = new Date();
  const pad = (n) => n.toString().padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
}

function csvEscape(val) {
  const s = String(val ?? "");
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

// =========================
// EXPRESS MIDDLEWARE
// =========================
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use((req, res, next) => {
  res.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.set("Pragma", "no-cache");
  res.set("Expires", "0");
  next();
});
app.use(express.static(path.join(__dirname, "public")));
app.use("/config", express.static(path.join(__dirname, "config")));
app.use("/public", express.static(path.join(__dirname, "public")));
app.use("/js/jquery", express.static(path.join(__dirname, "node_modules/jquery/dist")));
app.use("/sweetalert2", express.static("./node_modules/sweetalert2/dist"));
app.set("view engine", "ejs");

// =========================
// SERIAL (AUTO SCAN + CONFIG)
// =========================
function getActiveEvent() {
  const routePath = path.join(__dirname, "route.json");
  if (!fs.existsSync(routePath)) return null;
  const data = JSON.parse(fs.readFileSync(routePath));
  return data.route || null;
}

let port, parser;
const eventName = getActiveEvent();

if (!eventName) {
  console.log("Event belum diset di route.json. Sensor Arduino dinonaktifkan.");
} else {
  const configPath = path.join(__dirname, "config", `${eventName}.json`);
  let config = {};

  if (fs.existsSync(configPath)) {
    config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    console.log(`Config ${eventName}.json berhasil dimuat`);
  } else {
    console.log(`Config ${eventName}.json tidak ditemukan. Sensor Arduino dinonaktifkan.`);
  }

  if (config.arduinoSensor) findArduinoPort();
  else console.log("Arduino sensor dinonaktifkan di config event");
}

async function findArduinoPort() {
  try {
    const ports = await SerialPort.list();
    const arduinoPort = ports.find(p =>
      p.path.includes("ttyUSB") ||
      p.path.includes("ttyACM") ||
      p.path.match(/^COM\d+$/)
    );

    if (!arduinoPort) {
      console.log("Arduino tidak ditemukan. Scan ulang 5 detik...");
      return setTimeout(findArduinoPort, 5000);
    }

    console.log(`Arduino terdeteksi di ${arduinoPort.path}`);
    connectSerial(arduinoPort.path);
  } catch (err) {
    console.error("Gagal scan port:", err.message);
    setTimeout(findArduinoPort, 5000);
  }
}

function connectSerial(path, baudRate = 9600) {
  console.log(`Mencoba koneksi ke ${path} ...`);
  port = new SerialPort({ path, baudRate }, (err) => {
    if (err) {
      console.error("Gagal buka port:", err.message);
      return setTimeout(findArduinoPort, 5000);
    }
  });

  parser = port.pipe(new ReadlineParser({ delimiter: "\r\n" }));

  parser.on("data", (data) => {
    console.log("Arduino:", data);
    io.emit("counter", data);
  });

  port.on("open", () => console.log(`Arduino terhubung di ${path}`));
  port.on("error", (err) => console.error("Serial error:", err.message));
  port.on("close", () => {
    console.log("Port tertutup. Scan ulang dalam 5 detik...");
    setTimeout(findArduinoPort, 5000);
  });
}

// =========================
// API: SERVER INFO
// =========================
app.get("/api/server-ip", (req, res) => {
  res.json({ ip: getServerIP(), port: PORT });
});

// =========================
// ROUTE ADMIN
// =========================
const routeFile = path.join(__dirname, "route.json");

app.get("/", (req, res) => {
  if (fs.existsSync(routeFile)) {
    const routeData = JSON.parse(fs.readFileSync(routeFile));
    const activeEvent = routeData.route || "";
    if (activeEvent) return res.redirect(`/${activeEvent}`);
  }
  res.send("No active event set.");
});

app.get("/route.json", (req, res) => {
  if (fs.existsSync(routeFile)) res.sendFile(routeFile);
  else res.status(404).json({ error: "route.json tidak ditemukan" });
});

// =========================
// UPDATE CONFIG EVENT
// =========================
app.post("/update-config/:event", async (req, res) => {
  try {
    const event = req.params.event;
    const configPath = path.join(__dirname, "config", `${event}.json`);
    if (!fs.existsSync(configPath)) return res.status(404).send("Config event tidak ditemukan");

    const oldConfig = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    const newConfig = { ...oldConfig, ...req.body };

    fs.writeFileSync(configPath, JSON.stringify(newConfig, null, 2));

    console.log(`\n[CONFIG UPDATE] Event: ${event}`);
    for (const key in req.body) {
      console.log(`- ${key}: ${oldConfig[key]} → ${req.body[key]}`);
    }

    console.log("\n[CONFIG TERBARU]");
    console.log(JSON.stringify(newConfig, null, 2));

    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).send("Gagal update config");
  }
});

// =========================
// MULTER (UPLOAD TEMP)
// =========================
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const tempDir = path.join(__dirname, "temp_upload");
    if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });
    cb(null, tempDir);
  },
  filename: (req, file, cb) => cb(null, file.originalname),
});

// =========================
// REGISTRASI CSV
// =========================
app.post("/register", (req, res) => {
  let eventName = (req.body.event || "").trim();
  if (!eventName) {
    try {
      const ref = req.headers.referer || "";
      const url = new URL(ref);
      eventName = url.pathname.split("/").filter(Boolean)[0] || "default";
    } catch {
      eventName = "default";
    }
  }

  const { nama = "", nohp = "", email = "", field1 = "", field2 = "", field3 = "" } = req.body;
  const tanggal = new Date().toISOString();

  const dirEvent = path.join(process.cwd(), "public", eventName);
  const filePath = path.join(dirEvent, "guests.csv");

  fs.mkdirSync(dirEvent, { recursive: true });

  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, "Event,Nama,No HP,Email,Score,field1,field2,field3,Tanggal\n", "utf-8");
    console.log(`File baru dibuat: ${filePath}`);
  }

  const line = [
    csvEscape(eventName),
    csvEscape(nama),
    csvEscape(nohp),
    csvEscape(email),
    csvEscape(""),
    csvEscape(field1),
    csvEscape(field2),
    csvEscape(field3),
    csvEscape(tanggal)
  ].join(",") + "\n";

  fs.appendFile(filePath, line, (err) => {
    if (err) {
      console.error("Gagal simpan:", err);
      return res.status(500).send("Terjadi kesalahan saat menyimpan data.");
    }

    console.log("\n=========================================");
    console.log("[DATA REGISTRASI]");
    console.log("Event:", eventName);
    console.log("Data:", line.trim());
    console.log("=========================================");
    res.status(200).end();
  });
});

app.post("/update-score", (req, res) => {
  const { score, answers } = req.body;

  let eventName = (req.body.event || "").trim();
  if (!eventName) {
    try {
      const ref = req.headers.referer || "";
      const url = new URL(ref);
      eventName = url.pathname.split("/").filter(Boolean)[0] || "default";
    } catch {
      eventName = "default";
    }
  }

  const dirEvent = path.join(process.cwd(), "public", eventName);
  const filePath = path.join(dirEvent, "guests.csv");

  if (!fs.existsSync(filePath)) return res.status(400).send("File CSV belum ada, register dulu.");

  let lines = fs.readFileSync(filePath, "utf-8").trim().split("\n");
  if (lines.length < 2) return res.status(400).send("Belum ada data tamu.");

  const header = lines[0].split(",");
  const lastLine = lines[lines.length - 1].split(",");

  while (lastLine.length < header.length) lastLine.push("");

  lastLine[4] = String(score ?? "");
  lastLine[5] = String((answers && answers.q1) || lastLine[5] || "");
  lastLine[6] = String((answers && answers.q2) || lastLine[6] || "");
  lastLine[8] = formatDateLocal();

  lines[lines.length - 1] = lastLine.join(",");
  fs.writeFileSync(filePath, lines.join("\n") + "\n");

  console.log("\n=========================================");
  console.log("[UPDATE SCORE]");
  console.log("Event:", eventName);
  console.log("Score:", score);
  console.log("Data terakhir CSV:", lastLine.join(","));
  console.log("Waktu update:", formatDateLocal());
  console.log("=========================================");

  res.send("Score & survey updated");
});

// =========================
// DOWNLOAD CSV
// =========================
app.get("/api/guests/download-today", (req, res) => {
  const filePath = path.join(__dirname, "guests.csv");
  if (!fs.existsSync(filePath)) return res.status(404).send("File CSV tidak ditemukan.");

  const today = req.query.date || new Date().toISOString().slice(0, 10);
  const lines = fs.readFileSync(filePath, "utf-8").trim().split("\n");
  const filtered = [lines[0], ...lines.slice(1)].join("\n");

  res.setHeader("Content-Disposition", `attachment; filename=guests_${today}.csv`);
  res.set("Content-Type", "text/csv");
  res.send(filtered);
});


// ==================================================
// START PRIZES API (BARU, TAMBAHAN) SPIN OF WHEEL
// ==================================================

// Semua prizes disimpan di: public/<event>/prizes.json
const PRIZES_BASE = path.join(__dirname, "public");

function getPrizesFilePath(event) {
  return path.join(PRIZES_BASE, event, "prizes.json");
}

// GET: ambil daftar prizes untuk 1 event
app.get("/api/prizes/:event", (req, res) => {
  const event = (req.params.event || "").trim();
  if (!event) return res.status(400).json({ error: "Event wajib diisi" });

  const filePath = getPrizesFilePath(event);

  if (!fs.existsSync(filePath)) {
    // kalau file belum ada, kirim kosong
    return res.json({ prizes: [] });
  }

  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const data = JSON.parse(raw || "{}");
    const prizes = Array.isArray(data.prizes) ? data.prizes : [];
    res.json({ prizes });
  } catch (err) {
    console.error("Gagal baca prizes:", err);
    res.status(500).json({ error: "Gagal membaca prizes.json" });
  }
});

// POST: simpan FULL prizes.json (dipakai dari halaman setting)
// body: { prizes: [ {name, qty, status, show}, ... ] }
app.post("/api/prizes/:event", (req, res) => {
  const event = (req.params.event || "").trim();
  if (!event) return res.status(400).json({ error: "Event wajib diisi" });

  const filePath = getPrizesFilePath(event);
  const dirEvent = path.dirname(filePath);

  try {
    const prizes = Array.isArray(req.body.prizes) ? req.body.prizes : [];
    const payload = { prizes };

    fs.mkdirSync(dirEvent, { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(payload, null, 2));

    console.log(`\n[PRIZES SAVE] Event: ${event}`);
    console.log(JSON.stringify(payload, null, 2));

    res.json({ success: true });
  } catch (err) {
    console.error("Gagal simpan prizes:", err);
    res.status(500).json({ error: "Gagal menyimpan prizes.json" });
  }
});

// POST: decrement qty hadiah tiap kali ada yang menang
// body: { name: "Nama Hadiah" }
app.post("/api/prizes/:event/decrement", (req, res) => {
  const event = (req.params.event || "").trim();
  const { name } = req.body || {};

  if (!event) return res.status(400).json({ error: "Event wajib diisi" });
  if (!name) return res.status(400).json({ error: "Nama hadiah wajib diisi" });

  const filePath = getPrizesFilePath(event);

  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: "prizes.json belum ada" });
  }

  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const data = JSON.parse(raw || "{}");
    const prizes = Array.isArray(data.prizes) ? data.prizes : [];

    const prize = prizes.find(p => p.name === name);
    if (!prize) {
      return res.status(404).json({ error: "Hadiah tidak ditemukan" });
    }

    const currentQty = Number(prize.qty) || 0;
    if (currentQty > 0) {
      prize.qty = currentQty - 1;
    }

    fs.writeFileSync(filePath, JSON.stringify({ prizes }, null, 2));

    console.log(`\n[PRIZES DECREMENT] Event: ${event}, Hadiah: ${name}, Qty baru: ${prize.qty}`);

    res.json({ success: true, prizes, updatedPrize: prize });
  } catch (err) {
    console.error("Gagal decrement prize:", err);
    res.status(500).json({ error: "Gagal update prizes.json" });
  }
});

// ==================================================
// END PRIZES API (BARU, TAMBAHAN) SPIN OF WHEEL
// ==================================================


// =========================
// API: MODEL CARD (DAFTAR GAMBAR)
// =========================
app.get("/api/modelcard/:eventName", (req, res) => {
  const eventName = (req.params.eventName || "").trim();
  if (!eventName) {
    return res.json([]);
  }

  const dirEvent = path.join(__dirname, "public", eventName, "modelcard");

  fs.readdir(dirEvent, (err, files) => {
    if (err) {
      if (err.code === "ENOENT") {
        return res.json([]);
      }
      console.error("Gagal membaca folder gambar:", err);
      return res.status(500).json({ error: "Gagal membaca folder gambar." });
    }

    const allowedExt = [".png", ".jpg", ".jpeg", ".gif", ".webp"];

    const images = files
      .filter((f) => {
        const ext = path.extname(f).toLowerCase();
        return allowedExt.includes(ext) && f.toLowerCase() !== "question-mark.png";
      })
      .map((name) => `/${eventName}/modelcard/${name}`);

    return res.json(images);
  });
});

// =========================
// ROUTER PER EVENT (GAME)
// =========================
app.get("/:eventName", (req, res, next) => {
  const filePath = path.join(viewsDir, req.params.eventName, "index.html");
  if (!fs.existsSync(filePath)) return next();
  res.sendFile(filePath);
});

app.get("/:eventName/:pageName", (req, res, next) => {
  const filePath = path.join(viewsDir, req.params.eventName, `${req.params.pageName}.html`);
  if (!fs.existsSync(filePath)) return next();   // <- sudah balik ke existsSync
  res.sendFile(filePath);
});

app.get("/configGame", (req, res) => {
  res.sendFile(path.join(viewsDir, "configGame.html"));
});

// =========================
// SOCKET.IO
// =========================
let lastCounterLog = 0;

io.on("connection", (socket) => {
  console.log("User connected:", socket.id);

  // PlanB -> server -> broadcast ke game
  socket.on("counter", (value) => {
    const now = Date.now();
    if (now - lastCounterLog > 1000) {
      console.log("Counter dari client (sample):", value);
      lastCounterLog = now;
    }
    io.emit("counter", value);
  });

  socket.on("disconnect", (reason) => {
    console.log("User disconnected:", socket.id, "reason:", reason);
  });
});

// =========================
// START SERVER
// =========================
// =========================
// START SERVER
// =========================
server.listen(PORT, () => {
  const ip = getServerIP();
  const activeEvent = getActiveEvent();

  console.log("\n===========================================");
  console.log(`[${getNow()}] Server running`);
  console.log(`Local   : http://localhost:${PORT}`);
  console.log(`Network : http://${ip}:${PORT}`);

  if (activeEvent) {
    console.log(`Event   : ${activeEvent}`);
    console.log(`Game    : http://${ip}:${PORT}/${activeEvent}`);
    console.log(`PlanB   : http://${ip}:${PORT}/${activeEvent}/planB`);
  } else {
    console.log("No active event set in route.json");
  }

  console.log("===========================================\n");
});

