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
    content TEXT,
    image TEXT,
    timestamp INTEGER,
    readBy TEXT DEFAULT '[]'
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

// --- In-memory state for typing indicators ---
const usersTyping = new Map();
const TYPING_TIMEOUT = 3000;

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

function loadHistory(ws, callback) {
  // Use a JOIN to get user profile data for each message
  const messageQuery = `
    SELECT
      m.id, m.userId, m.content, m.image, m.timestamp, m.readBy,
      u.name AS username, u.gender, u.interests, u.bio
    FROM messages AS m
    INNER JOIN users AS u ON m.userId = u.id
    ORDER BY m.id ASC
  `;

  db.all(messageQuery, [], (err, messageRows) => {
    if (err) {
      console.error("❌ Error loading message history:", err);
      return callback([]);
    }
    const messages = messageRows.map((row) => {
      row.readBy = row.readBy ? JSON.parse(row.readBy) : [];
      return row;
    });

    db.all("SELECT * FROM broadcasts ORDER BY id ASC", [], (err, broadcastRows) => {
      const allHistory = messages.concat(broadcastRows.map(b => ({
          ...b,
          type: "broadcast",
          userId: "admin", // Add a user ID for consistency
          username: "Admin",
          content: b.content
      })));
      callback(allHistory);
    });
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

  ws.on("message", (msg) => {
    try {
      const data = JSON.parse(msg);

      if (data.type === "init") {
        userId = data.userId || randomUUID();
        const username = data.username || "User";

        db.get("SELECT * FROM blocked WHERE userId = ?", [userId], (err, row) => {
          if (row) {
            send(ws, "blocked", { reason: "You are banned." });
            ws.close();
          } else {
            clients.set(ws, { id: userId, name: username });
            db.run(
              `INSERT OR REPLACE INTO users (id, name, gender, interests, bio) VALUES (?, ?, ?, ?, ?)`,
              [userId, username, data.gender || "N/A", data.interests || "N/A", data.bio || ""]
            );
            
            // Wait for history to load before sending the initial data
            loadHistory(ws, (history) => {
                send(ws, "init", { 
                    userId, 
                    onlineUsers: getOnlineUsers(),
                    history
                });
            });
            
            // Broadcast user joined status
            broadcast("userStatus", { 
                type: "userJoined",
                id: userId, 
                name: username 
            }, ws);
          }
        });
      }
      
      else if (data.type === "typing") {
        if (!usersTyping.has(userId)) {
          usersTyping.set(userId, true);
          const username = clients.get(ws)?.name || "User";
          broadcast("typing", { userId, username });
        }
      } 
      
      else if (data.type === "stopTyping") {
        if (usersTyping.has(userId)) {
          usersTyping.delete(userId);
          broadcast("stopTyping", { userId });
        }
      }

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
                          send(client, "messageRead", { messageId, readerId: userId });
                      }
                  }
              }
          });
      }

      else if (data.type === "message") {
        const timestamp = Date.now();
        db.get("SELECT name, gender, interests, bio FROM users WHERE id = ?", [userId], (err, userRow) => {
            if (err || !userRow) {
                console.error("User not found for message.");
                return;
            }
            db.run(
              `INSERT INTO messages (userId, content, image, timestamp) VALUES (?, ?, ?, ?)`,
              [userId, data.content || "", data.image || null, timestamp],
              function () {
                const newMsg = {
                  id: this.lastID,
                  userId,
                  username: userRow.name,
                  gender: userRow.gender,
                  interests: userRow.interests,
                  bio: userRow.bio,
                  content: data.content || "",
                  image: data.image || null,
                  timestamp,
                  readBy: []
                };
                for (const client of wss.clients) {
                  if (client.readyState === WebSocket.OPEN) {
                    send(client, "message", newMsg);
                  }
                }
              }
            );
        });
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
      // Log the raw message to see what caused the parse error
      console.error("Malformed message:", msg);
    }
  });

  ws.on("close", () => {
    if (userId) {
      const user = clients.get(ws);
      if (user) {
        broadcast("userStatus", { 
            type: "userLeft",
            id: user.id, 
            name: user.name 
        });
        clients.delete(ws);
      }
    }
  });
});
