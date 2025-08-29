// server.js
// WebSocket chat server with SQLite persistence, admin features, profiles, images, and broadcast support.

const WebSocket = require("ws");
const sqlite3 = require("sqlite3").verbose();
const { randomUUID } = require("crypto");

// ================== Database Setup ==================
const db = new sqlite3.Database("chat.db");

db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    name TEXT,
    gender TEXT,
    interests TEXT,
    bio TEXT
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    userId TEXT,
    username TEXT,
    content TEXT,
    image TEXT,
    timestamp INTEGER
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS blocked (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    userId TEXT UNIQUE
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS broadcasts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    content TEXT,
    timestamp INTEGER
  )`);
});

// ================== WebSocket Setup ==================
const wss = new WebSocket.Server({ port: 8080 }, () =>
  console.log("✅ WebSocket server running on ws://localhost:8080")
);

let clients = new Map(); // ws -> { id, name }

// ================== Helpers ==================
function send(ws, type, data) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type, ...data }));
  }
}

// FIX: This broadcast function now excludes the sender
function broadcast(type, data, senderWs = null) {
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN && client !== senderWs) {
      client.send(JSON.stringify({ type, ...data }));
    }
  }
}

function loadHistory(ws) {
  db.all("SELECT * FROM messages ORDER BY id ASC", [], (err, rows) => {
    if (!err) send(ws, "history", { messages: rows });
  });

  db.all("SELECT * FROM broadcasts ORDER BY id ASC", [], (err, rows) => {
    if (!err) send(ws, "broadcastHistory", { broadcasts: rows });
  });
}

function getOnlineUsers() {
  return [...clients.values()].map(u => ({ id: u.id, name: u.name }));
}

// ================== Connection Handling ==================
wss.on("connection", (ws) => {
  let userId = null;
  let username = null; // Store username to use later

  ws.on("message", (msg) => {
    try {
      const data = JSON.parse(msg);

      // ==== First-time connection ====
      if (data.type === "init") {
        userId = data.userId || randomUUID();
        username = data.username || "User"; // Store username here

        db.get("SELECT * FROM blocked WHERE userId = ?", [userId], (err, row) => {
          if (row) {
            send(ws, "blocked", { reason: "You are banned." });
            ws.close();
          } else {
            clients.set(ws, { id: userId, name: username });
            db.run(
              `INSERT OR REPLACE INTO users (id, name, gender, interests, bio) VALUES (?, ?, ?, ?, ?)`,
              [userId, username, data.gender || "", data.interests || "", data.bio || ""]
            );

            send(ws, "init", { userId, onlineUsers: getOnlineUsers() });
            loadHistory(ws);
            broadcast("userJoined", { id: userId, name: username }, ws); // Broadcast to others
          }
        });
      }

      // ==== Chat message ====
      else if (data.type === "message") {
        const timestamp = Date.now();
        db.run(
          `INSERT INTO messages (userId, username, content, image, timestamp) VALUES (?, ?, ?, ?, ?)`,
          [userId, username, data.content || "", data.image || null, timestamp],
          function () {
            const newMsg = {
              id: this.lastID,
              userId,
              username,
              content: data.content || "",
              image: data.image || null,
              timestamp
            };
            // FIX: Broadcast to all clients, INCLUDING the sender
            for (const client of wss.clients) {
              if (client.readyState === WebSocket.OPEN) {
                send(client, "message", newMsg);
              }
            }
          }
        );
      }

      // ==== Admin broadcast ====
      else if (data.type === "broadcast" && data.admin === true) {
        const timestamp = Date.now();
        db.run(
          `INSERT INTO broadcasts (content, timestamp) VALUES (?, ?)`,
          [data.content, timestamp],
          function () {
            const newBroadcast = { id: this.lastID, content: data.content, timestamp };
            broadcast("broadcast", newBroadcast);
          }
        );
      }

      // ==== Block user (admin) ====
      else if (data.type === "blockUser" && data.admin === true) {
        db.run("INSERT OR IGNORE INTO blocked (userId) VALUES (?)", [data.userId]);
        for (const [client, info] of clients.entries()) {
          if (info.id === data.userId) {
            send(client, "blocked", { reason: "You were banned by admin." });
            client.close();
            clients.delete(client);
          }
        }
      }

      // ==== Request online users ====
      else if (data.type === "getOnlineUsers") {
        send(ws, "onlineUsers", { users: getOnlineUsers() });
      }

    } catch (err) {
      console.error("❌ Error handling message:", err);
    }
  });

  ws.on("close", () => {
    if (userId) {
      const user = clients.get(ws);
      if (user) {
        broadcast("userLeft", { id: user.id, name: user.name });
        clients.delete(ws);
      }
    }
  });
});
