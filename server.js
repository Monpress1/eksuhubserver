// server.js
// This script sets up a WebSocket server for a chat application with admin capabilities.
// It uses SQLite to persist chat messages, user profiles, and blocked users.
// It now supports persistent user IDs across server restarts and ensures database is ready before accepting connections.
// New: Admin can send broadcast messages to all chat clients, and these messages now persist in the database.
// Removed: Product advertisement features and the 'clear chat history' admin command.

// Import necessary modules
const { WebSocketServer } = require('ws');
const sqlite3 = require('sqlite3').verbose(); // Import sqlite3
const fs = require('fs'); // Import file system module for deleting the DB file
const path = require('path'); // Import path module for joining paths

// --- SQLite Database Configuration ---
// The database file will be created in your project directory.
// For Railway, it's often best to put this in a persistent volume if you want data to survive deploys.
// For now, it will be created in the ephemeral /app directory.
const DB_FILE_NAME = 'chatdb.sqlite';
const DB_DIR = process.env.DB_VOLUME_PATH || './'; // Use an environment variable for persistent volume path, or current directory
const DB_FILE = path.join(DB_DIR, DB_FILE_NAME);

let db; // SQLite database instance

// --- WebSocket Server Setup ---
// Initialize WebSocketServer, but don't set up connection listener yet
const PORT = process.env.PORT || 8080; // Use Railway's PORT environment variable or default to 8080
const wss = new WebSocketServer({ port: PORT });

// --- Data Stores (now primarily backed by SQLite) ---
// Map to store active clients, keyed by their unique SESSION ID.
// Each clientInfo will now also store a persistentUserId.
const clients = new Map();
let nextSessionId = 1; // Simple counter for unique SESSION IDs (for connected sessions)

// Set to store PERSISTENT IDs of blocked users (in-memory cache, synced with DB).
const blockedUsers = new Set();

// In-memory messages array, populated from DB on startup, updated on new messages/deletions.
const messages = [];
let nextMessageDbId = 1; // Simple sequential ID for messages for client-side use (from DB auto-increment)

// --- SQLite Connection and Table Initialization Function ---
async function connectToSQLite() {
    return new Promise((resolve, reject) => {
        // --- START: CODE TO FORCE DATABASE RESET ON EVERY START ---
        // This is for development/testing on ephemeral file systems.
        // DO NOT use this in production if you need to retain data.
        // It will delete your chat history on every server restart/redeploy.
        if (fs.existsSync(DB_FILE)) {
            console.warn(`[DB Reset] Deleting existing database file: ${DB_FILE} to force a fresh start with updated schema.`);
            try {
                fs.unlinkSync(DB_FILE); // Synchronously delete the file
                console.log(`[DB Reset] Successfully deleted ${DB_FILE}.`);
            } catch (err) {
                console.error(`[DB Reset] Error deleting existing database file ${DB_FILE}:`, err.message);
                // Depending on severity, you might want to reject here, but letting it try to create a new one might still work.
            }
        } else {
            console.log(`[DB Reset] No existing database file found at ${DB_FILE}. Creating a new one.`);
        }
        // --- END: CODE TO FORCE DATABASE RESET ON EVERY START ---

        // Ensure the directory exists if it's a new path (e.g., for persistent volumes)
        if (!fs.existsSync(DB_DIR)) {
            console.log(`Creating database directory: ${DB_DIR}`);
            fs.mkdirSync(DB_DIR, { recursive: true });
        }


        db = new sqlite3.Database(DB_FILE, (err) => {
            if (err) {
                console.error('Error opening SQLite database:', err.message);
                return reject(err); // Reject the promise if opening the DB fails
            }
            console.log(`Connected to SQLite database: ${DB_FILE}`);

            db.serialize(async () => { // Make the serialize callback async
                try {
                    // Ensure PRAGMA foreign_keys is enabled first
                    await new Promise((res, rej) => db.run("PRAGMA foreign_keys = ON;", (err) => {
                        if (err) {
                            console.error("Error enabling foreign keys:", err.message);
                            rej(err);
                        } else {
                            res();
                        }
                    }));
                    console.log('PRAGMA foreign_keys enabled.');

                    // Users table to store user profiles, now with persistentUserId as PRIMARY KEY
                    await new Promise((res, rej) => {
                        db.run(`
                            CREATE TABLE IF NOT EXISTS users (
                                persistentUserId TEXT PRIMARY KEY, -- Now using persistent UUID
                                nickname TEXT NOT NULL,
                                interest TEXT,
                                gender TEXT,
                                lastSeen INTEGER
                            )
                        `, (err) => {
                            if (err) {
                                console.error('Error creating users table:', err.message);
                                rej(err);
                            } else {
                                console.log('Users table checked/created.');
                                res();
                            }
                        });
                    });

                    // Messages table to store chat messages
                    // IMPORTANT: Ensure 'messageType' column is present here!
                    await new Promise((res, rej) => {
                        db.run(`
                            CREATE TABLE IF NOT EXISTS messages (
                                id INTEGER PRIMARY KEY AUTOINCREMENT,
                                senderPersistentId TEXT, -- Now references persistentUserId (can be 'admin_system' or actual user ID)
                                senderNickname TEXT,
                                senderProfile TEXT, -- Stored as JSON string
                                text TEXT,
                                image TEXT, -- Base64 string
                                fileName TEXT,
                                timestamp INTEGER,
                                messageType TEXT DEFAULT 'chatMessage', -- This is the crucial column!
                                FOREIGN KEY (senderPersistentId) REFERENCES users(persistentUserId) ON DELETE CASCADE
                            )
                        `, (err) => {
                            if (err) {
                                console.error('Error creating messages table:', err.message);
                                rej(err);
                            } else {
                                console.log('Messages table checked/created.');
                                res();
                            }
                        });
                    });

                    // Blocked Users table
                    // userId now references persistentUserId
                    await new Promise((res, rej) => {
                        db.run(`
                            CREATE TABLE IF NOT EXISTS blocked_users (
                                userId TEXT PRIMARY KEY, -- Now stores persistentUserId
                                timestamp INTEGER
                            )
                        `, (err) => {
                            if (err) {
                                console.error('Error creating blocked_users table:', err.message);
                                rej(err);
                            } else {
                                console.log('Blocked users table checked/created.');
                                res();
                            }
                        });
                    });

                    console.log('All SQLite tables initialized.');
                    resolve(); // Resolve the main promise only after all tables are created
                } catch (e) {
                    console.error('Error during SQLite table initialization sequence:', e);
                    reject(e);
                }
            });
        });
    });
}

// --- Load Initial Data from SQLite ---
async function loadInitialData() {
    return new Promise((resolve, reject) => {
        // Fetch messages
        db.all("SELECT * FROM messages ORDER BY timestamp ASC", [], (err, msgRows) => {
            if (err) {
                console.error('Error loading messages from SQLite:', err.message);
                return reject(err);
            }

            messages.length = 0; // Clear in-memory messages

            // Add regular chat messages and announcements to the in-memory array
            msgRows.forEach(row => {
                if (row.senderProfile) {
                    try {
                        row.senderProfile = JSON.parse(row.senderProfile);
                    } catch (e) {
                        console.error("Error parsing senderProfile from DB:", e, row.senderProfile);
                        row.senderProfile = {};
                    }
                } else {
                    row.senderProfile = {};
                }
                messages.push(row);
                if (row.id > nextMessageDbId) {
                    nextMessageDbId = row.id + 1; // Update next ID based on message IDs
                }
            });

            // Sort all messages (chat, announcements, user status) by timestamp
            messages.sort((a, b) => a.timestamp - b.timestamp);

            db.all("SELECT userId FROM blocked_users", [], (err, blockedRows) => {
                if (err) {
                    console.error('Error loading blocked users from SQLite:', err.message);
                    return reject(err);
                }
                blockedUsers.clear(); // Clear in-memory set
                blockedRows.forEach(row => blockedUsers.add(row.userId));

                console.log(`Loaded ${messages.length} total messages and ${blockedUsers.size} blocked users from DB. Next message DB ID will be: ${nextMessageDbId}`);
                resolve();
            });
        });
    });
}

// --- Helper Functions for Broadcasting and Sending Messages ---

/**
 * Sends a structured message to a specific client.
 * @param {WebSocket} ws - The WebSocket instance of the recipient client.
 * @param {string} type - The type of message (e.g., 'chatMessage', 'adminUpdate', 'systemMessage', 'systemAnnouncement', 'userStatusUpdate').
 * @param {object} payload - The data payload of the message.
 */
function sendToClient(ws, type, payload) {
    if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify({ type, payload }));
    }
}

/**
 * Broadcasts a structured message to all connected chat clients.
 * @param {string} type - The type of message.
 * @param {object} payload - The data payload.
 */
function broadcastToChatClients(type, payload) {
    clients.forEach((clientInfo) => { // Iterate over clientInfo objects
        // Only send to regular chat clients, not the admin dashboard
        // If a user is blocked (by their persistent ID), they should not receive new chat messages.
        if (clientInfo.type === 'chat' && !blockedUsers.has(clientInfo.persistentUserId)) {
             sendToClient(clientInfo.ws, type, payload);
        }
    });
}

/**
 * Sends an update to the admin dashboard.
 * This function will be called whenever there's a change in users or messages.
 * If a specific adminWs is provided, it sends only to that admin.
 * Otherwise, it broadcasts to all connected admin clients.
 * @param {WebSocket} [specificAdminWs] - Optional: The WebSocket instance of a specific admin to send to.
 */
async function sendAdminUpdate(specificAdminWs = null) {
    // Fetch latest user profiles from DB for admin view
    const allUsersInDb = await new Promise((resolve, reject) => {
        db.all("SELECT * FROM users", [], (err, rows) => {
            if (err) reject(err);
            else resolve(rows);
        });
    });

    // Map active clients to their data, merging with persistent user profiles from DB
    const activeClientsData = Array.from(clients.values()).map(c => {
        const dbProfile = allUsersInDb.find(u => u.persistentUserId === c.persistentUserId);
        return {
            id: c.sessionId, // Use session ID for display in admin, but persistent ID for actions
            persistentUserId: c.persistentUserId, // Include persistent ID for actions
            type: c.type,
            status: c.ws.readyState === c.ws.OPEN ? 'online' : 'offline',
            isBlocked: blockedUsers.has(c.persistentUserId), // Check blocked status using persistent ID
            nickname: c.userProfile.nickname || (dbProfile ? dbProfile.nickname : `User ${c.sessionId}`),
            interest: c.userProfile.interest || (dbProfile ? dbProfile.interest : ''),
            gender: c.userProfile.gender || (dbProfile ? dbProfile.gender : '')
        };
    });

    const dataToSend = {
        users: activeClientsData,
        messages: messages // Messages array is kept in-memory and updated from DB actions
    };

    if (specificAdminWs) {
        // Send only to the specified admin WebSocket (e.g., on successful login or explicit refresh request)
        if (specificAdminWs.readyState === specificAdminWs.OPEN) {
            sendToClient(specificAdminWs, 'adminData', dataToSend);
            console.log(`Server: Sent adminData to specific admin (Session ID: ${Array.from(clients.values()).find(c => c.ws === specificAdminWs)?.sessionId || 'unknown'})`);
        }
    } else {
        // Broadcast to all connected admin clients (e.g., on chat message, block/unblock)
        console.log('Server: Broadcasting adminData to all active admin clients.');
        clients.forEach((clientInfo) => {
            if (clientInfo.type === 'admin' && clientInfo.ws.readyState === clientInfo.ws.OPEN) {
                sendToClient(clientInfo.ws, 'adminData', dataToSend);
                console.log(`Server: Sent adminData to admin client Session ID: ${clientInfo.sessionId}`);
            }
        });
    }
}

// --- WebSocket Server Event Listener (Will be set up AFTER DB is ready) ---
function setupWebSocketListeners() {
    wss.on('connection', function connection(ws) {
        const currentSessionId = nextSessionId++; // Assign a unique SESSION ID to the new client
        // Store client info with a default type 'chat', empty profile, and NO persistent ID yet.
        // The persistent ID will be set once 'initialUserData' is received.
        const clientInfo = { sessionId: currentSessionId, ws: ws, type: 'chat', userProfile: {}, persistentUserId: null }; 
        clients.set(currentSessionId, clientInfo);
        console.log(`Client (Session ID: ${currentSessionId}, initial type: chat) connected. Total clients: ${clients.size}`);
        console.log(`Client ${currentSessionId} connected. Current messages in memory (before sending initialData): ${messages.length}`);

        // Send initial data to the connecting client (their session ID and current messages/users)
        // Messages array is already populated from DB on server startup.
        sendToClient(ws, 'initialData', {
            clientId: currentSessionId, // Send session ID to client
            messages: messages, // This now includes chat messages, announcements, and user status updates
            users: Array.from(clients.values()).map(c => ({
                id: c.sessionId, // Use session ID for display in chat client's user list
                persistentUserId: c.persistentUserId, // Include persistent ID if known
                type: c.type,
                status: c.ws.readyState === c.ws.OPEN ? 'online' : 'offline',
                isBlocked: blockedUsers.has(c.persistentUserId), // Check blocked status using persistent ID
                nickname: c.userProfile ? c.userProfile.nickname : `User ${c.sessionId}`
            }))
        });

        sendAdminUpdate(); // Update all admin dashboards on new connection (for user joins/leaves)

        // Event listener for when the server receives a message from this specific client.
        ws.on('message', async function incoming(message) { // Made async to await DB operations
            // Retrieve the client's current info from the map to ensure we have the latest type and profile
            const currentClientInfo = clients.get(currentSessionId);

            try {
                const parsedMessage = JSON.parse(message.toString()); 
                console.log(`Received message from client (Session ID: ${currentSessionId}, type: ${currentClientInfo.type}):`, parsedMessage);

                // Handle different types of messages
                switch (parsedMessage.type) {
                    case 'initialUserData': // Handle initial user profile data
                        const clientPersistentId = parsedMessage.payload.persistentUserId;
                        if (!clientPersistentId) {
                            console.error(`Client (Session ID: ${currentSessionId}) sent initialUserData without persistentUserId.`);
                            sendToClient(ws, 'systemMessage', { text: 'Authentication error: Missing user ID.' });
                            ws.close(); // Close connection due to invalid data
                            return;
                        }

                        currentClientInfo.persistentUserId = clientPersistentId; // Set persistent ID
                        currentClientInfo.userProfile = parsedMessage.payload;
                        clients.set(currentSessionId, currentClientInfo); // Update client info in map

                        // Save/Update user profile in SQLite using persistentUserId as PK
                        await new Promise((resolve, reject) => {
                            db.run(`
                                INSERT INTO users (persistentUserId, nickname, interest, gender, lastSeen)
                                VALUES (?, ?, ?, ?, ?)
                                ON CONFLICT(persistentUserId) DO UPDATE SET
                                    nickname = excluded.nickname,
                                    interest = excluded.interest,
                                    gender = excluded.gender,
                                    lastSeen = excluded.lastSeen
                            `, [
                                clientPersistentId, // Use persistent ID here
                                parsedMessage.payload.nickname,
                                parsedMessage.payload.interest,
                                parsedMessage.payload.gender,
                                Date.now()
                            ], function(err) {
                                if (err) {
                                    console.error("Error saving/updating user profile in DB:", err.message);
                                    reject(err);
                                }
                                else resolve();
                            });
                        });
                        console.log(`Client (Persistent ID: ${clientPersistentId}) profile saved/updated in DB.`);
                        
                        // Now that we have the nickname, broadcast a more informative join message
                        broadcastToChatClients('userStatusUpdate', { 
                            persistentUserId: clientPersistentId,
                            nickname: currentClientInfo.userProfile.nickname,
                            status: 'joined'
                        });
                        sendAdminUpdate(); // Update admin dashboard with new user profile
                        break;

                    case 'chatMessage':
                        // If the sender is blocked (by their persistent ID), ignore their message.
                        if (!currentClientInfo.persistentUserId || blockedUsers.has(currentClientInfo.persistentUserId)) {
                            console.log(`User (Persistent ID: ${currentClientInfo.persistentUserId}) is blocked or not identified. Message ignored.`);
                            sendToClient(ws, 'systemMessage', { text: 'You are currently blocked from sending messages or not fully identified.' });
                            return;
                        }

                        // Create a new message object
                        const newMessage = {
                            senderSessionId: currentSessionId, // For temporary session reference
                            senderPersistentId: currentClientInfo.persistentUserId, // The stable ID for DB
                            senderNickname: currentClientInfo.userProfile.nickname || `User ${currentSessionId}`,
                            senderProfile: JSON.stringify(currentClientInfo.userProfile), // Store as JSON string
                            text: parsedMessage.payload.text || null,
                            image: parsedMessage.payload.image || null, // Base64 string
                            fileName: parsedMessage.payload.fileName || null, // Image file name
                            timestamp: Date.now(),
                            messageType: 'chatMessage', // Explicitly set message type
                        };

                        // Save message to SQLite
                        await new Promise((resolve, reject) => {
                            db.run(`
                                INSERT INTO messages (senderPersistentId, senderNickname, senderProfile, text, image, fileName, timestamp, messageType)
                                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                            `, [
                                newMessage.senderPersistentId, // Use persistent ID here
                                newMessage.senderNickname,
                                newMessage.senderProfile,
                                newMessage.text,
                                newMessage.image,
                                newMessage.fileName,
                                newMessage.timestamp,
                                newMessage.messageType
                            ], function(err) {
                                if (err) {
                                    console.error("Error inserting message into DB:", err.message);
                                    reject(err);
                                }
                                else {
                                    newMessage.id = this.lastID; // Get the auto-incremented ID from SQLite
                                    console.log(`Message inserted into DB with ID: ${newMessage.id}`);
                                    // Add a log to confirm the count in DB immediately after insertion
                                    db.get("SELECT COUNT(*) AS count FROM messages", [], (countErr, result) => {
                                        if (countErr) console.error("Error getting message count after insert:", countErr.message);
                                        else console.log(`Current messages in DB after insert: ${result.count}`);
                                    });
                                    resolve();
                                }
                            });
                        });

                        // Convert senderProfile back to object for in-memory array and broadcast
                        newMessage.senderProfile = currentClientInfo.userProfile;
                        messages.push(newMessage); // Store the message in-memory
                        console.log(`Message added to in-memory array. Current messages in memory: ${messages.length}`);
                        broadcastToChatClients('chatMessage', newMessage); // Broadcast to all chat clients
                        sendAdminUpdate(); // Update admin dashboard
                        break;

                    case 'adminLogin':
                        // This is a placeholder for actual admin authentication.
                        // For now, any password will grant admin access.
                        if (parsedMessage.payload.password === 'adminpass') { // Simple password check
                            currentClientInfo.type = 'admin'; // Update the client's type in the map
                            sendToClient(ws, 'systemMessage', { text: 'Logged in as Admin.' });
                            sendAdminUpdate(ws); // Send adminData to THIS admin client immediately
                            console.log(`Client (Session ID: ${currentSessionId}) type changed to Admin.`);
                        } else {
                            sendToClient(ws, 'systemMessage', { text: 'Admin login failed.' });
                        }
                        break;

                    case 'requestAdminData': // For the refresh button
                        if (currentClientInfo.type === 'admin') {
                            sendAdminUpdate(ws); // Send current admin data to the requesting admin client
                            console.log(`Admin (Session ID: ${currentSessionId}) requested data refresh.`);
                        } else {
                            sendToClient(ws, 'systemMessage', { text: 'Permission denied for data refresh.' });
                        }
                        break;

                    case 'adminBroadcast': // Handle admin broadcast message
                        if (currentClientInfo.type === 'admin') {
                            const announcementText = parsedMessage.payload.text;
                            if (announcementText) {
                                console.log(`Admin (Session ID: ${currentSessionId}) sending broadcast: "${announcementText}"`);
                                
                                // Create announcement message object to save to DB
                                const announcementMessage = {
                                    senderPersistentId: 'admin_system', // Special ID for admin announcements
                                    senderNickname: 'Admin',
                                    senderProfile: JSON.stringify({ nickname: 'Admin', interest: 'Moderation', gender: 'N/A' }), // Basic admin profile
                                    text: announcementText,
                                    image: null,
                                    fileName: null,
                                    timestamp: Date.now(),
                                    messageType: 'systemAnnouncement' // Explicitly set message type
                                };

                                // Save announcement to SQLite
                                await new Promise((resolve, reject) => {
                                    db.run(`
                                        INSERT INTO messages (senderPersistentId, senderNickname, senderProfile, text, image, fileName, timestamp, messageType)
                                        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                                    `, [
                                        announcementMessage.senderPersistentId,
                                        announcementMessage.senderNickname,
                                        announcementMessage.senderProfile,
                                        announcementMessage.text,
                                        announcementMessage.image,
                                        announcementMessage.fileName,
                                        announcementMessage.timestamp,
                                        announcementMessage.messageType
                                    ], function(err) {
                                        if (err) {
                                            console.error("Error inserting announcement into DB:", err.message);
                                            reject(err);
                                        }
                                        else {
                                            announcementMessage.id = this.lastID;
                                            console.log(`Announcement inserted into DB with ID: ${announcementMessage.id}`);
                                            resolve();
                                        }
                                    });
                                });

                                // Add to in-memory messages array
                                messages.push(announcementMessage);
                                messages.sort((a, b) => a.timestamp - b.timestamp); // Keep sorted
                                console.log(`Announcement added to in-memory array. Current total messages: ${messages.length}`);

                                // Broadcast to all chat clients
                                broadcastToChatClients('systemAnnouncement', { text: announcementText });
                                sendToClient(ws, 'systemMessage', { text: 'Announcement sent.' });
                                sendAdminUpdate(); // Update admin dashboard
                            }
                        } else {
                            sendToClient(ws, 'systemMessage', { text: 'Permission denied for broadcasting.' });
                        }
                        break;

                    case 'deleteMessage':
                        if (currentClientInfo.type === 'admin') { // Use currentClientInfo for type check
                            const messageIdToDelete = parsedMessage.payload.messageId;
                            
                            // Delete from SQLite
                            await new Promise((resolve, reject) => {
                                db.run(`DELETE FROM messages WHERE id = ?`, [messageIdToDelete], function(err) {
                                    if (err) {
                                        console.error(`Error deleting message from DB:`, err.message);
                                        reject(err);
                                    }
                                    else resolve(this.changes); // Number of rows deleted
                                });
                            }).then(changes => {
                                if (changes > 0) {
                                    // Remove from in-memory array
                                    const index = messages.findIndex(msg => msg.id === messageIdToDelete);
                                    if (index > -1) {
                                        messages.splice(index, 1);
                                    }
                                    console.log(`Message ID ${messageIdToDelete} deleted from DB and in-memory array.`);
                                    broadcastToChatClients('messageDeleted', { messageId: messageIdToDelete });
                                    sendAdminUpdate(); // Update all admin dashboards
                                    console.log(`Admin (Session ID: ${currentSessionId}) deleted message ID: ${messageIdToDelete}`);
                                } else {
                                    sendToClient(ws, 'systemMessage', { text: `Message ID ${messageIdToDelete} not found.` });
                                }
                            }).catch(err => {
                                console.error(`Error deleting message from DB (catch block):`, err.message);
                                sendToClient(ws, 'systemMessage', { text: 'Error deleting message.' });
                            });
                        } else {
                            sendToClient(ws, 'systemMessage', { text: 'Permission denied.' });
                        }
                        break;

                    case 'blockUser':
                        if (currentClientInfo.type === 'admin') { // Use currentClientInfo for type check
                            const userIdToBlock = parsedMessage.payload.userId; // This is the persistentUserId from admin client
                            
                            // Check if user exists in active clients or in DB
                            const userExists = Array.from(clients.values()).some(c => c.persistentUserId === userIdToBlock) || await new Promise((resolve, reject) => {
                                db.get("SELECT persistentUserId FROM users WHERE persistentUserId = ?", [userIdToBlock], (err, row) => {
                                    if (err) reject(err);
                                    else resolve(!!row); // True if row exists, false otherwise
                                });
                            });
                            
                            if (userExists) { 
                                if (!blockedUsers.has(userIdToBlock)) {
                                    blockedUsers.add(userIdToBlock);
                                    // Save to blocked_users table
                                    await new Promise((res, rej) => {
                                        db.run("INSERT INTO blocked_users (userId, timestamp) VALUES (?, ?)", [userIdToBlock, Date.now()], function(err) {
                                            if (err) {
                                                console.error("Error blocking user in DB:", err.message);
                                                rej(err);
                                            }
                                            else res();
                                        });
                                    });
                                    console.log(`User (Persistent ID: ${userIdToBlock}) blocked and saved to DB.`);
                                }
                                sendToClient(ws, 'systemMessage', { text: `User ${userIdToBlock} blocked.` });
                                broadcastToChatClients('systemMessage', { text: `User ${userIdToBlock.substring(0,8)}... has been blocked by an admin.` });
                                sendAdminUpdate(); // Update all admin dashboards
                                console.log(`Admin (Session ID: ${currentSessionId}) blocked user (Persistent ID: ${userIdToBlock}).`);
                            } else {
                                sendToClient(ws, 'systemMessage', { text: `User ID ${userIdToBlock} not found.` });
                            }
                        } else {
                            sendToClient(ws, 'systemMessage', { text: 'Permission denied.' });
                        }
                        break;

                    case 'unblockUser':
                        if (currentClientInfo.type === 'admin') { // Use currentClientInfo for type check
                            const userIdToUnblock = parsedMessage.payload.userId; // This is the persistentUserId from admin client
                            if (blockedUsers.delete(userIdToUnblock)) {
                                // Remove from blocked_users table
                                await new Promise((res, rej) => {
                                    db.run("DELETE FROM blocked_users WHERE userId = ?", [userIdToUnblock], function(err) {
                                        if (err) {
                                            console.error("Error unblocking user in DB:", err.message);
                                            rej(err);
                                        }
                                        else res();
                                    });
                                });
                                console.log(`User (Persistent ID: ${userIdToUnblock}) unblocked and removed from DB.`);
                            }
                            sendToClient(ws, 'systemMessage', { text: `User ${userIdToUnblock} unblocked.` });
                            broadcastToChatClients('systemMessage', { text: `User ${userIdToUnblock.substring(0,8)}... has been unblocked by an admin.` });
                            sendAdminUpdate(); // Update all admin dashboards
                            console.log(`Admin (Session ID: ${currentSessionId}) unblocked user (Persistent ID: ${userIdToUnblock}).`);
                        } else {
                            sendToClient(ws, 'systemMessage', { text: 'Permission denied.' });
                        }
                        break;

                    default:
                        console.warn(`Unknown message type: ${parsedMessage.type}`);
                        sendToClient(ws, 'systemMessage', { text: 'Unknown command.' });
                }
            } catch (e) {
                console.error('Failed to parse message or handle:', e);
                sendToClient(ws, 'systemMessage', { text: 'Error processing message.' });
            }
        });

        // Event listener for when a client disconnects.
        wss.on('close', async () => { // Made async to await DB operations
            const disconnectedClientInfo = clients.get(currentSessionId);
            if (disconnectedClientInfo && disconnectedClientInfo.persistentUserId) { // Use persistentUserId
                // Update lastSeen for user in DB
                await new Promise((resolve, reject) => {
                    db.run(`UPDATE users SET lastSeen = ? WHERE persistentUserId = ?`, [Date.now(), disconnectedClientInfo.persistentUserId], function(err) {
                        if (err) {
                            console.error("Error updating lastSeen in DB:", err.message);
                            reject(err);
                        }
                        else resolve();
                    });
                });
                console.log(`User (Persistent ID: ${disconnectedClientInfo.persistentUserId}) last seen updated in DB.`);

                // Broadcast user left status with nickname
                broadcastToChatClients('userStatusUpdate', {
                    persistentUserId: disconnectedClientInfo.persistentUserId,
                    nickname: disconnectedClientInfo.userProfile.nickname,
                    status: 'left'
                });
            }

            clients.delete(currentSessionId); // Delete by session ID
            console.log(`Client (Session ID: ${currentSessionId}) disconnected. Total clients: ${clients.size}`);
            sendAdminUpdate(); // Update admin dashboard on disconnect
        });

        // Event listener for any errors that occur with this client's connection.
        ws.on('error', (error) => {
            console.error(`WebSocket error for client (Session ID: ${currentSessionId}):`, error);
        });
    });
}


// Connect to SQLite and load data, then start WebSocket listeners
connectToSQLite().then(() => {
    return loadInitialData();
}).then(() => {
    console.log('Initial data loaded. Server ready.');
    setupWebSocketListeners(); // ONLY setup listeners AFTER DB is ready
    console.log(`WebSocket server started on port ${PORT}`); // Moved this log here
}).catch(err => {
    console.error('Server startup failed:', err);
    process.exit(1);
});
