// server.js
// WebSocket chat server with SQLite persistence, image support, and admin features.

const WebSocket = require("ws");
const sqlite3 = require("sqlite3").verbose();
const { v4: uuidv4 } = require("uuid");

// --- Database Setup ---
const db = new sqlite3.Database("./chat.db");

// Initialize tables
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    userId TEXT,
    username TEXT,
    content TEXT,
    type TEXT,
    timestamp INTEGER
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS profiles (
    userId TEXT PRIMARY KEY,
    username TEXT,
    gender TEXT,
    interests TEXT,
    bio TEXT
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS blocked (
    userId TEXT PRIMARY KEY
  )`);
});

// --- Server Setup ---
const wss = new WebSocket.Server({ port: 8080 }, () => {
  console.log("✅ WebSocket server running on ws://localhost:8080");
});

let clients = new Map(); // socket → userId

// --- Helper Functions ---
function send(ws, type, data) {
  ws.send(JSON.stringify({ type, ...data }));
}

function broadcast(type, data, exclude = null) {
  const message = JSON.stringify({ type, ...data });
  for (let [client, userId] of clients) {
    if (client.readyState === WebSocket.OPEN && client !== exclude) {
      client.send(message);
    }
  }
}

function saveMessage(userId, username, content, type) {
  return new Promise((resolve, reject) => {
    const timestamp = Date.now();
    db.run(
      `INSERT INTO messages (userId, username, content, type, timestamp) VALUES (?, ?, ?, ?, ?)`,
      [userId, username, content, type, timestamp],
      function (err) {
        if (err) reject(err);
        else resolve({ id: this.lastID, userId, username, content, type, timestamp });
      }
    );
  });
}

// --- WebSocket Handlers ---
wss.on("connection", (ws) => {
  const userId = uuidv4();
  clients.set(ws, userId);
  console.log(`🔗 New connection: ${userId}`);

  // Send init data
  db.all("SELECT * FROM messages ORDER BY id ASC LIMIT 50", (err, rows) => {
    if (!err) send(ws, "init", { messages: rows, userId });
  });

  // Update online list
  broadcast("online", { users: Array.from(clients.values()) });

  ws.on("message", async (msg) => {
    try {
      const data = JSON.parse(msg);
      if (!data.type) return;

      switch (data.type) {
        case "profile":
          db.run(
            `INSERT OR REPLACE INTO profiles (userId, username, gender, interests, bio) VALUES (?, ?, ?, ?, ?)`,
            [userId, data.username, data.gender, data.interests, data.bio]
          );
          break;

        case "message":
          if (!data.content || !data.username) return;

          const saved = await saveMessage(userId, data.username, data.content, "text");
          // Send back to sender + broadcast to others
          send(ws, "message", saved);
          broadcast("message", saved, ws);
          break;

        case "image":
          if (!data.content || !data.username) return;

          const savedImg = await saveMessage(userId, data.username, data.content, "image");
          send(ws, "image", savedImg);
          broadcast("image", savedImg, ws);
          break;

        case "admin-broadcast":
          if (data.secret === "admin123" && data.content) {
            const savedAdmin = await saveMessage("ADMIN", "Admin", data.content, "admin");
            broadcast("admin", savedAdmin);
          }
          break;
      }
    } catch (err) {
      console.error("❌ Message error:", err);
    }
  });

  ws.on("close", () => {
    clients.delete(ws);
    console.log(`❌ Disconnected: ${userId}`);
    broadcast("online", { users: Array.from(clients.values()) });
  });
});
