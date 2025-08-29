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
    timestamp INTEGER,
    readBy TEXT DEFAULT '[]'
  )`); // Added 'readBy' column to store read receipts

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

// --- New: In-memory state for typing indicators ---
const usersTyping = new Map(); // stores userId -> true/false
const TYPING_TIMEOUT = 3000; // 3 seconds

// ================== Helpers ==================
function send(ws, type, data) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type, ...data }));
  }
}

function broadcast(type, data, senderWs = null) {
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN && client !== senderWs) {
      client.send(JSON.stringify({ type, ...data }));
    }
  }
}

function loadHistory(ws) {
  const twentyFourHoursAgo = Date.now() - 24 * 60 * 60 * 1000;
  db.all("SELECT * FROM messages WHERE timestamp > ? ORDER BY id ASC", [twentyFourHoursAgo], (err, rows) => {
    if (!err) send(ws, "history", { messages: rows });
  });

  db.all("SELECT * FROM broadcasts WHERE timestamp > ? ORDER BY id ASC", [twentyFourHoursAgo], (err, rows) => {
    if (!err) send(ws, "broadcastHistory", { broadcasts: rows });
  });
}

function getOnlineUsers() {
  return [...clients.values()].map(u => ({ id: u.id, name: u.name }));
}

// ================== Automated Database Cleanup ==================
const ONE_DAY = 24 * 60 * 60 * 1000;

setInterval(() => {
    const twentyFourHoursAgo = Date.now() - ONE_DAY;
    console.log("⏰ Running database cleanup via polling...");
    db.run("DELETE FROM messages WHERE timestamp < ?", [twentyFourHoursAgo], (err) => {
        if (err) console.error("❌ Error clearing old messages:", err);
        else console.log("✅ Old messages cleared successfully.");
    });
    db.run("DELETE FROM broadcasts WHERE timestamp < ?", [twentyFourHoursAgo], (err) => {
        if (err) console.error("❌ Error clearing old broadcasts:", err);
        else console.log("✅ Old broadcasts cleared successfully.");
    });
}, ONE_DAY);

// ================== Connection Handling ==================
wss.on("connection", (ws) => {
  let userId = null;
  let username = null;

  ws.on("message", (msg) => {
    try {
      const data = JSON.parse(msg);

      if (data.type === "init") {
        userId = data.userId || randomUUID();
        username = data.username || "User";

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
            broadcast("userJoined", { id: userId, name: username }, ws);
          }
        });
      }
      
      // --- NEW: Typing Indicator Logic ---
      else if (data.type === "typing") {
        if (!usersTyping.has(userId)) {
          usersTyping.set(userId, true);
          broadcast("typing", { userId, username });
        }
      } 
      
      else if (data.type === "stopTyping") {
        if (usersTyping.has(userId)) {
          usersTyping.delete(userId);
          broadcast("stopTyping", { userId });
        }
      }

      // --- NEW: Read Receipts Logic ---
      else if (data.type === "messageRead") {
          const { messageId } = data;
          db.get("SELECT readBy FROM messages WHERE id = ?", [messageId], (err, row) => {
              if (err || !row) return;

              let readers = JSON.parse(row.readBy);
              if (!readers.includes(userId)) {
                  readers.push(userId);
                  const updatedReadBy = JSON.stringify(readers);
                  db.run("UPDATE messages SET readBy = ? WHERE id = ?", [updatedReadBy, messageId]);
                  
                  for (const client of wss.clients) {
                      if (client.readyState === WebSocket.OPEN) {
                          send(client, "messageRead", { messageId, userId });
                      }
                  }
              }
          });
      }

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
              timestamp,
              readBy: JSON.stringify([]) // Initialize with an empty array
            };
            for (const client of wss.clients) {
              if (client.readyState === WebSocket.OPEN) {
                send(client, "message", newMsg);
              }
            }
          }
        );
      }

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
