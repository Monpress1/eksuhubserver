// server.js
// WebSocket chat server with PostgreSQL persistence, admin features, profiles, images, and broadcast support.

const WebSocket = require("ws");
const { randomUUID } = require("crypto");
const { Pool } = require("pg"); // Use the 'pg' library for PostgreSQL

// ================== Database Setup ==================
// Connect to the database using the DATABASE_URL environment variable
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false, // Required for Render's managed databases
  },
});

async function setupDatabase() {
  try {
    const client = await pool.connect();

    // PostgreSQL table creation syntax
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        name TEXT,
        gender TEXT,
        interests TEXT,
        bio TEXT
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS messages (
        id SERIAL PRIMARY KEY,
        userId TEXT,
        content TEXT,
        image TEXT,
        timestamp BIGINT,
        readBy TEXT DEFAULT '[]'
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS blocked (
        id SERIAL PRIMARY KEY,
        userId TEXT UNIQUE
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS broadcasts (
        id SERIAL PRIMARY KEY,
        content TEXT,
        timestamp BIGINT
      );
    `);

    console.log("✅ PostgreSQL tables ensured.");
    client.release();
  } catch (err) {
    console.error("❌ Error setting up PostgreSQL tables:", err);
  }
}

setupDatabase(); // Run the async setup function

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

async function loadHistory(ws, callback) {
  try {
    const messageQuery = `
      SELECT
        m.id, m.userId, m.content, m.image, m.timestamp, m.readBy,
        u.name AS username, u.gender, u.interests, u.bio
      FROM messages AS m
      INNER JOIN users AS u ON m.userId = u.id
      ORDER BY m.id ASC;
    `;
    const messagesResult = await pool.query(messageQuery);
    const messages = messagesResult.rows.map((row) => {
      row.readBy = row.readBy ? JSON.parse(row.readBy) : [];
      row.timestamp = new Date(Number(row.timestamp)).toISOString();
      return row;
    });

    const broadcastResult = await pool.query("SELECT * FROM broadcasts ORDER BY id ASC;");
    const allHistory = messages.concat(
      broadcastResult.rows.map((b) => ({
        ...b,
        type: "broadcast",
        userId: "admin",
        username: "Admin",
        content: b.content,
        timestamp: new Date(Number(b.timestamp)).toISOString(),
      }))
    );
    callback(allHistory);
  } catch (err) {
    console.error("❌ Error loading message history:", err);
    callback([]);
  }
}

function getOnlineUsers() {
  return [...clients.values()].map((u) => ({ id: u.id, name: u.name }));
}

// ================== Automated Database Cleanup ==================
const ONE_DAY = 24 * 60 * 60 * 1000;

setInterval(async () => {
  const twentyFourHoursAgo = Date.now() - ONE_DAY;
  console.log("⏰ Running database cleanup via polling...");
  try {
    await pool.query("DELETE FROM messages WHERE timestamp < $1", [
      twentyFourHoursAgo,
    ]);
    console.log("✅ Old messages cleared successfully.");

    await pool.query("DELETE FROM broadcasts WHERE timestamp < $1", [
      twentyFourHoursAgo,
    ]);
    console.log("✅ Old broadcasts cleared successfully.");
  } catch (err) {
    console.error("❌ Error clearing old data:", err);
  }
}, ONE_DAY);

// ================== Connection Handling ==================
wss.on("connection", (ws) => {
  let userId = null;

  ws.on("message", async (msg) => {
    try {
      const messageString = typeof msg === 'string' ? msg : msg.toString('utf8');
      const data = JSON.parse(messageString);

      if (data.type === "init") {
        userId = data.userId || randomUUID();
        const username = data.username || "User";

        const { rowCount } = await pool.query("SELECT 1 FROM blocked WHERE userId = $1", [userId]);
        if (rowCount > 0) {
          send(ws, "blocked", { reason: "You are banned." });
          ws.close();
        } else {
          clients.set(ws, { id: userId, name: username });
          await pool.query(
            `INSERT INTO users (id, name, gender, interests, bio) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, gender = EXCLUDED.gender, interests = EXCLUDED.interests, bio = EXCLUDED.bio;`,
            [userId, username, data.gender || "N/A", data.interests || "N/A", data.bio || ""]
          );

          loadHistory(ws, (history) => {
            // Include the current user's ID in the init payload
            send(ws, "init", {
              userId,
              onlineUsers: getOnlineUsers(),
              history,
            });
          });

          broadcast(
            "userStatus",
            {
              type: "userJoined",
              id: userId,
              name: username,
            },
            ws
          );
        }
      } else if (data.type === "typing") {
        if (!usersTyping.has(userId)) {
          usersTyping.set(userId, true);
          const username = clients.get(ws)?.name || "User";
          broadcast("typing", { userId, username });
        }
      } else if (data.type === "stopTyping") {
        if (usersTyping.has(userId)) {
          usersTyping.delete(userId);
          broadcast("stopTyping", { userId });
        }
      } else if (data.type === "messageRead") {
        const { messageId } = data;
        const { rows } = await pool.query("SELECT readBy FROM messages WHERE id = $1", [messageId]);
        if (rows.length > 0) {
          const row = rows[0];
          let readers = JSON.parse(row.readBy);
          if (!readers.includes(userId)) {
            readers.push(userId);
            const updatedReadBy = JSON.stringify(readers);
            await pool.query("UPDATE messages SET readBy = $1 WHERE id = $2", [
              updatedReadBy,
              messageId,
            ]);

            for (const client of wss.clients) {
              if (client.readyState === WebSocket.OPEN) {
                send(client, "messageRead", { messageId, readerId: userId });
              }
            }
          }
        }
      } else if (data.type === "message") {
        const timestamp = Date.now();
        const { rows } = await pool.query("SELECT name, gender, interests, bio FROM users WHERE id = $1", [userId]);
        if (rows.length === 0) {
          console.error("User not found for message.");
          return;
        }
        const userRow = rows[0];
        const result = await pool.query(
          `INSERT INTO messages (userId, content, image, timestamp) VALUES ($1, $2, $3, $4) RETURNING id`,
          [userId, data.content || "", data.image || null, timestamp]
        );
        const newMsg = {
          id: result.rows[0].id,
          userId,
          username: userRow.name,
          gender: userRow.gender,
          interests: userRow.interests,
          bio: userRow.bio,
          content: data.content || "",
          image: data.image || null,
          timestamp: new Date(timestamp).toISOString(),
          readBy: [],
        };
        for (const client of wss.clients) {
          if (client.readyState === WebSocket.OPEN) {
            send(client, "message", newMsg);
          }
        }
      } else if (data.type === "broadcast" && data.admin === true) {
        const timestamp = Date.now();
        const result = await pool.query(
          `INSERT INTO broadcasts (content, timestamp) VALUES ($1, $2) RETURNING id`,
          [data.content, timestamp]
        );
        const newBroadcast = { id: result.rows[0].id, content: data.content, timestamp: new Date(timestamp).toISOString() };
        broadcast("broadcast", newBroadcast);
      } else if (data.type === "blockUser" && data.admin === true) {
        await pool.query("INSERT INTO blocked (userId) VALUES ($1) ON CONFLICT (userId) DO NOTHING", [
          data.userId,
        ]);
        for (const [client, info] of clients.entries()) {
          if (info.id === data.userId) {
            send(client, "blocked", { reason: "You were banned by admin." });
            client.close();
            clients.delete(client);
          }
        }
      } else if (data.type === "getOnlineUsers") {
        send(ws, "onlineUsers", { users: getOnlineUsers() });
      }
    } catch (err) {
      console.error("❌ Error handling message:", err);
      console.error("Malformed message:", msg);
    }
  });

  ws.on("close", () => {
    if (userId) {
      const user = clients.get(ws);
      if (user) {
        broadcast(
          "userStatus",
          {
            type: "userLeft",
            id: user.id,
            name: user.name,
          },
          ws
        );
        clients.delete(ws);
      }
    }
  });
});
