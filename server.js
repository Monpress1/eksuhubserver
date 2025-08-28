// server.js
// This script sets up a WebSocket server for a chat application with admin capabilities.
// It uses SQLite to persist chat messages, user profiles, and blocked users.
// It now supports persistent user IDs across server restarts and ensures database is ready before accepting connections.
// New: Admin can send broadcast messages to all chat clients, and these messages now persist in the database.
// Removed: Product advertisement features and the 'clear chat history' admin command.
// New Features: Online user indicators and connection status tracking.

// Import necessary modules
const { WebSocketServer } = require('ws');
const sqlite3 = require('sqlite3').verbose(); // Import sqlite3
const fs = require('fs'); // Import file system module for deleting the DB file
const path = require('path'); // Import path module for joining paths

// --- SQLite Database Configuration ---
const DB_FILE_NAME = 'chatdb.sqlite';
const DB_DIR = process.env.DB_VOLUME_PATH || './';
const DB_FILE = path.join(DB_DIR, DB_FILE_NAME);

let db;
const clients = new Map();
let nextSessionId = 1;
const blockedUsers = new Set();
const messages = [];
let nextMessageDbId = 1;

// --- SQLite Connection and Table Initialization Function ---
async function connectToSQLite() {
    return new Promise((resolve, reject) => {
        // --- START: CODE TO FORCE DATABASE RESET ON EVERY START ---
        // This is for development/testing on ephemeral file systems.
        // DO NOT use this in production if you need to retain data.
        if (fs.existsSync(DB_FILE)) {
            console.warn(`[DB Reset] Deleting existing database file: ${DB_FILE} to force a fresh start with updated schema.`);
            try {
                fs.unlinkSync(DB_FILE);
                console.log(`[DB Reset] Successfully deleted ${DB_FILE}.`);
            } catch (err) {
                console.error(`[DB Reset] Error deleting existing database file ${DB_FILE}:`, err.message);
            }
        } else {
            console.log(`[DB Reset] No existing database file found at ${DB_FILE}. Creating a new one.`);
        }
        // --- END: CODE TO FORCE DATABASE RESET ON EVERY START ---

        if (!fs.existsSync(DB_DIR)) {
            console.log(`Creating database directory: ${DB_DIR}`);
            fs.mkdirSync(DB_DIR, { recursive: true });
        }

        db = new sqlite3.Database(DB_FILE, (err) => {
            if (err) {
                console.error('Error opening SQLite database:', err.message);
                return reject(err);
            }
            console.log(`Connected to SQLite database: ${DB_FILE}`);

            db.serialize(async () => {
                try {
                    await new Promise((res, rej) => db.run("PRAGMA foreign_keys = ON;", (err) => {
                        if (err) { rej(err); } else { res(); }
                    }));
                    console.log('PRAGMA foreign_keys enabled.');

                    await new Promise((res, rej) => {
                        db.run(`
                            CREATE TABLE IF NOT EXISTS users (
                                persistentUserId TEXT PRIMARY KEY,
                                nickname TEXT NOT NULL,
                                interest TEXT,
                                gender TEXT,
                                lastSeen INTEGER
                            )
                        `, (err) => {
                            if (err) { rej(err); } else { console.log('Users table checked/created.'); res(); }
                        });
                    });

                    await new Promise((res, rej) => {
                        db.run(`
                            CREATE TABLE IF NOT EXISTS messages (
                                id INTEGER PRIMARY KEY AUTOINCREMENT,
                                senderPersistentId TEXT,
                                senderNickname TEXT,
                                senderProfile TEXT,
                                text TEXT,
                                image TEXT,
                                fileName TEXT,
                                timestamp INTEGER,
                                messageType TEXT DEFAULT 'chatMessage',
                                FOREIGN KEY (senderPersistentId) REFERENCES users(persistentUserId) ON DELETE CASCADE
                            )
                        `, (err) => {
                            if (err) { rej(err); } else { console.log('Messages table checked/created.'); res(); }
                        });
                    });

                    await new Promise((res, rej) => {
                        db.run(`
                            CREATE TABLE IF NOT EXISTS blocked_users (
                                userId TEXT PRIMARY KEY,
                                timestamp INTEGER
                            )
                        `, (err) => {
                            if (err) { rej(err); } else { console.log('Blocked users table checked/created.'); res(); }
                        });
                    });

                    console.log('All SQLite tables initialized.');
                    resolve();
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
        db.all("SELECT * FROM messages ORDER BY timestamp ASC", [], (err, msgRows) => {
            if (err) {
                console.error('Error loading messages from SQLite:', err.message);
                return reject(err);
            }
            messages.length = 0;
            msgRows.forEach(row => {
                if (row.senderProfile) {
                    try { row.senderProfile = JSON.parse(row.senderProfile); } catch (e) { console.error("Error parsing senderProfile from DB:", e, row.senderProfile); row.senderProfile = {}; }
                } else {
                    row.senderProfile = {};
                }
                messages.push(row);
                if (row.id > nextMessageDbId) {
                    nextMessageDbId = row.id + 1;
                }
            });
            messages.sort((a, b) => a.timestamp - b.timestamp);
            db.all("SELECT userId FROM blocked_users", [], (err, blockedRows) => {
                if (err) {
                    console.error('Error loading blocked users from SQLite:', err.message);
                    return reject(err);
                }
                blockedUsers.clear();
                blockedRows.forEach(row => blockedUsers.add(row.userId));
                console.log(`Loaded ${messages.length} total messages and ${blockedUsers.size} blocked users from DB. Next message DB ID will be: ${nextMessageDbId}`);
                resolve();
            });
        });
    });
}

// --- Helper Functions for Broadcasting and Sending Messages ---

function sendToClient(ws, type, payload) {
    if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify({ type, payload }));
    }
}

/**
 * NEW: Get a list of online persistent user IDs.
 * @returns {string[]} An array of persistent user IDs of currently connected chat clients.
 */
function getOnlineUsers() {
    const onlineUsers = [];
    clients.forEach((clientInfo) => {
        if (clientInfo.type === 'chat' && clientInfo.persistentUserId) {
            onlineUsers.push(clientInfo.persistentUserId);
        }
    });
    return onlineUsers;
}

/**
 * Broadcasts a structured message to all connected chat clients.
 * @param {string} type - The type of message.
 * @param {object} payload - The data payload.
 */
function broadcastToChatClients(type, payload) {
    const onlineUsers = getOnlineUsers();
    clients.forEach((clientInfo) => {
        if (clientInfo.type === 'chat' && !blockedUsers.has(clientInfo.persistentUserId)) {
             // Add the list of online users to every message payload
             const payloadWithOnlineUsers = { ...payload, onlineUsers: onlineUsers };
             sendToClient(clientInfo.ws, type, payloadWithOnlineUsers);
        }
    });
}

async function sendAdminUpdate(specificAdminWs = null) {
    const allUsersInDb = await new Promise((resolve, reject) => {
        db.all("SELECT * FROM users", [], (err, rows) => {
            if (err) reject(err);
            else resolve(rows);
        });
    });

    const activeClientsData = Array.from(clients.values()).map(c => {
        const dbProfile = allUsersInDb.find(u => u.persistentUserId === c.persistentUserId);
        return {
            id: c.sessionId,
            persistentUserId: c.persistentUserId,
            type: c.type,
            status: c.ws.readyState === c.ws.OPEN ? 'online' : 'offline',
            isBlocked: blockedUsers.has(c.persistentUserId),
            nickname: c.userProfile.nickname || (dbProfile ? dbProfile.nickname : `User ${c.sessionId}`),
            interest: c.userProfile.interest || (dbProfile ? dbProfile.interest : ''),
            gender: c.userProfile.gender || (dbProfile ? dbProfile.gender : '')
        };
    });

    const dataToSend = {
        users: activeClientsData,
        messages: messages
    };

    if (specificAdminWs) {
        if (specificAdminWs.readyState === specificAdminWs.OPEN) {
            sendToClient(specificAdminWs, 'adminData', dataToSend);
            console.log(`Server: Sent adminData to specific admin (Session ID: ${Array.from(clients.values()).find(c => c.ws === specificAdminWs)?.sessionId || 'unknown'})`);
        }
    } else {
        console.log('Server: Broadcasting adminData to all active admin clients.');
        clients.forEach((clientInfo) => {
            if (clientInfo.type === 'admin' && clientInfo.ws.readyState === clientInfo.ws.OPEN) {
                sendToClient(clientInfo.ws, 'adminData', dataToSend);
                console.log(`Server: Sent adminData to admin client Session ID: ${clientInfo.sessionId}`);
            }
        });
    }
}

// --- WebSocket Server Event Listener ---
function setupWebSocketListeners() {
    wss.on('connection', function connection(ws) {
        const currentSessionId = nextSessionId++;
        const clientInfo = { sessionId: currentSessionId, ws: ws, type: 'chat', userProfile: {}, persistentUserId: null };
        clients.set(currentSessionId, clientInfo);
        console.log(`Client (Session ID: ${currentSessionId}, initial type: chat) connected. Total clients: ${clients.size}`);

        sendAdminUpdate();

        ws.on('message', async function incoming(message) {
            const currentClientInfo = clients.get(currentSessionId);
            try {
                const parsedMessage = JSON.parse(message.toString());
                console.log(`Received message from client (Session ID: ${currentSessionId}, type: ${currentClientInfo.type}):`, parsedMessage);

                switch (parsedMessage.type) {
                    case 'initialUserData':
                        const clientPersistentId = parsedMessage.payload.persistentUserId;
                        if (!clientPersistentId) {
                            console.error(`Client (Session ID: ${currentSessionId}) sent initialUserData without persistentUserId.`);
                            ws.close();
                            return;
                        }

                        currentClientInfo.persistentUserId = clientPersistentId;
                        currentClientInfo.userProfile = parsedMessage.payload;
                        clients.set(currentSessionId, currentClientInfo);

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
                                clientPersistentId,
                                parsedMessage.payload.nickname,
                                parsedMessage.payload.interest,
                                parsedMessage.payload.gender,
                                Date.now()
                            ], function(err) {
                                if (err) { reject(err); } else { resolve(); }
                            });
                        });
                        console.log(`Client (Persistent ID: ${clientPersistentId}) profile saved/updated in DB.`);
                        
                        // NEW: Broadcast online status update to all clients
                        broadcastToChatClients('userStatusUpdate', {
                            persistentUserId: clientPersistentId,
                            nickname: currentClientInfo.userProfile.nickname,
                            status: 'joined'
                        });

                        sendAdminUpdate();
                        break;

                    case 'requestInitialData':
                        const lastFetchTimestamp = parsedMessage.payload.lastFetchTimestamp || 0;
                        console.log(`Client (Session ID: ${currentSessionId}) requested initial data newer than timestamp: ${lastFetchTimestamp}`);
                        db.all("SELECT * FROM messages WHERE timestamp > ? ORDER BY timestamp ASC", [lastFetchTimestamp], (err, newMsgRows) => {
                            if (err) { console.error('Error loading new messages from SQLite for client:', err.message); return; }
                            const preparedNewMessages = newMsgRows.map(row => {
                                if (row.senderProfile) {
                                    try { row.senderProfile = JSON.parse(row.senderProfile); } catch (e) { row.senderProfile = {}; }
                                } else { row.senderProfile = {}; }
                                return row;
                            });
                            sendToClient(ws, 'initialData', { messages: preparedNewMessages, onlineUsers: getOnlineUsers() });
                            console.log(`Sent ${preparedNewMessages.length} new messages to client (Session ID: ${currentSessionId}).`);
                        });
                        break;

                    case 'chatMessage':
                        if (!currentClientInfo.persistentUserId || blockedUsers.has(currentClientInfo.persistentUserId)) {
                            console.log(`User (Persistent ID: ${currentClientInfo.persistentUserId}) is blocked or not identified. Message ignored.`);
                            return;
                        }

                        const newMessage = {
                            senderSessionId: currentSessionId,
                            senderPersistentId: currentClientInfo.persistentUserId,
                            senderNickname: currentClientInfo.userProfile.nickname || `User ${currentSessionId}`,
                            senderProfile: JSON.stringify(currentClientInfo.userProfile),
                            text: parsedMessage.payload.text || null,
                            image: parsedMessage.payload.image || null,
                            fileName: parsedMessage.payload.fileName || null,
                            timestamp: Date.now(),
                            messageType: 'chatMessage',
                        };

                        await new Promise((resolve, reject) => {
                            db.run(`
                                INSERT INTO messages (senderPersistentId, senderNickname, senderProfile, text, image, fileName, timestamp, messageType)
                                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                            `, [
                                newMessage.senderPersistentId,
                                newMessage.senderNickname,
                                newMessage.senderProfile,
                                newMessage.text,
                                newMessage.image,
                                newMessage.fileName,
                                newMessage.timestamp,
                                newMessage.messageType
                            ], function(err) {
                                if (err) { reject(err); } else { newMessage.id = this.lastID; console.log(`Message inserted into DB with ID: ${newMessage.id}`); resolve(); }
                            });
                        });
                        newMessage.senderProfile = currentClientInfo.userProfile;
                        messages.push(newMessage);
                        console.log(`Message added to server's in-memory array. Current messages in memory: ${messages.length}`);
                        broadcastToChatClients('chatMessage', newMessage);
                        sendAdminUpdate();
                        break;

                    case 'adminLogin':
                        const enteredPassword = parsedMessage.payload.password;
                        const ADMIN_PASSWORD = 'Nakamoi';
                        if (enteredPassword === ADMIN_PASSWORD) {
                            currentClientInfo.type = 'admin';
                            sendToClient(ws, 'systemMessage', { text: 'Logged in as Admin.' });
                            sendAdminUpdate(ws);
                            console.log(`Client (Session ID: ${currentSessionId}) type changed to Admin.`);
                        } else {
                            sendToClient(ws, 'systemMessage', { text: 'Admin login failed.' });
                        }
                        break;

                    case 'requestAdminData':
                        if (currentClientInfo.type === 'admin') {
                            sendAdminUpdate(ws);
                            console.log(`Admin (Session ID: ${currentSessionId}) requested data refresh.`);
                        } else {
                            sendToClient(ws, 'systemMessage', { text: 'Permission denied for data refresh.' });
                        }
                        break;

                    case 'adminBroadcast':
                        if (currentClientInfo.type === 'admin') {
                            const announcementText = parsedMessage.payload.text;
                            if (announcementText) {
                                console.log(`Admin (Session ID: ${currentSessionId}) sending broadcast: "${announcementText}"`);
                                const announcementMessage = {
                                    senderPersistentId: 'admin_system',
                                    senderNickname: 'Admin',
                                    senderProfile: JSON.stringify({ nickname: 'Admin', interest: 'Moderation', gender: 'N/A' }),
                                    text: announcementText,
                                    image: null,
                                    fileName: null,
                                    timestamp: Date.now(),
                                    messageType: 'systemAnnouncement'
                                };
                                await new Promise((resolve, reject) => {
                                    db.run(`INSERT INTO messages (senderPersistentId, senderNickname, senderProfile, text, image, fileName, timestamp, messageType) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [announcementMessage.senderPersistentId, announcementMessage.senderNickname, announcementMessage.senderProfile, announcementMessage.text, announcementMessage.image, announcementMessage.fileName, announcementMessage.timestamp, announcementMessage.messageType], function(err) {
                                        if (err) { reject(err); } else { announcementMessage.id = this.lastID; resolve(); }
                                    });
                                });
                                messages.push(announcementMessage);
                                messages.sort((a, b) => a.timestamp - b.timestamp);
                                console.log(`Announcement added to in-memory array. Current total messages: ${messages.length}`);
                                broadcastToChatClients('systemAnnouncement', { text: announcementText });
                                sendToClient(ws, 'systemMessage', { text: 'Announcement sent.' });
                                sendAdminUpdate();
                            }
                        } else {
                            sendToClient(ws, 'systemMessage', { text: 'Permission denied for broadcasting.' });
                        }
                        break;

                    case 'deleteMessage':
                        if (currentClientInfo.type === 'admin') {
                            const messageIdToDelete = parsedMessage.payload.messageId;
                            await new Promise((resolve, reject) => {
                                db.run(`DELETE FROM messages WHERE id = ?`, [messageIdToDelete], function(err) {
                                    if (err) { reject(err); } else { resolve(this.changes); }
                                });
                            }).then(changes => {
                                if (changes > 0) {
                                    const index = messages.findIndex(msg => msg.id === messageIdToDelete);
                                    if (index > -1) {
                                        messages.splice(index, 1);
                                    }
                                    console.log(`Message ID ${messageIdToDelete} deleted from DB and in-memory array.`);
                                    broadcastToChatClients('messageDeleted', { messageId: messageIdToDelete });
                                    sendAdminUpdate();
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
                        if (currentClientInfo.type === 'admin') {
                            const userIdToBlock = parsedMessage.payload.userId;
                            const userExists = Array.from(clients.values()).some(c => c.persistentUserId === userIdToBlock) || await new Promise((resolve, reject) => {
                                db.get("SELECT persistentUserId FROM users WHERE persistentUserId = ?", [userIdToBlock], (err, row) => {
                                    if (err) reject(err);
                                    else resolve(!!row);
                                });
                            });
                            
                            if (userExists) {
                                if (!blockedUsers.has(userIdToBlock)) {
                                    blockedUsers.add(userIdToBlock);
                                    await new Promise((res, rej) => {
                                        db.run("INSERT INTO blocked_users (userId, timestamp) VALUES (?, ?)", [userIdToBlock, Date.now()], function(err) {
                                            if (err) { rej(err); } else { res(); }
                                        });
                                    });
                                    console.log(`User (Persistent ID: ${userIdToBlock}) blocked and saved to DB.`);
                                }
                                sendToClient(ws, 'systemMessage', { text: `User ${userIdToBlock} blocked.` });
                                broadcastToChatClients('systemMessage', { text: `User ${userIdToBlock.substring(0,8)}... has been blocked by an admin.` });
                                sendAdminUpdate();
                                console.log(`Admin (Session ID: ${currentSessionId}) blocked user (Persistent ID: ${userIdToBlock}).`);
                            } else {
                                sendToClient(ws, 'systemMessage', { text: `User ID ${userIdToBlock} not found.` });
                            }
                        } else {
                            sendToClient(ws, 'systemMessage', { text: 'Permission denied.' });
                        }
                        break;

                    case 'unblockUser':
                        if (currentClientInfo.type === 'admin') {
                            const userIdToUnblock = parsedMessage.payload.userId;
                            if (blockedUsers.delete(userIdToUnblock)) {
                                await new Promise((res, rej) => {
                                    db.run("DELETE FROM blocked_users WHERE userId = ?", [userIdToUnblock], function(err) {
                                        if (err) { rej(err); } else { res(); }
                                    });
                                });
                                console.log(`User (Persistent ID: ${userIdToUnblock}) unblocked and removed from DB.`);
                            }
                            sendToClient(ws, 'systemMessage', { text: `User ${userIdToUnblock} unblocked.` });
                            broadcastToChatClients('systemMessage', { text: `User ${userIdToUnblock.substring(0,8)}... has been unblocked by an admin.` });
                            sendAdminUpdate();
                            console.log(`Admin (Session ID: ${currentSessionId}) unblocked user (Persistent ID: ${userIdToUnblock}).`);
                        } else {
                            sendToClient(ws, 'systemMessage', { text: 'Permission denied.' });
                        }
                        break;

                    default:
                        console.warn(`Unknown message type: ${parsedMessage.type}`);
                }
            } catch (e) {
                console.error('Failed to parse message or handle:', e);
            }
        });

        ws.on('close', async () => {
            const disconnectedClientInfo = clients.get(currentSessionId);
            if (disconnectedClientInfo && disconnectedClientInfo.persistentUserId) {
                await new Promise((resolve, reject) => {
                    db.run(`UPDATE users SET lastSeen = ? WHERE persistentUserId = ?`, [Date.now(), disconnectedClientInfo.persistentUserId], function(err) {
                        if (err) { reject(err); } else { resolve(); }
                    });
                });
                console.log(`User (Persistent ID: ${disconnectedClientInfo.persistentUserId}) last seen updated in DB.`);
                
                // NEW: Broadcast left status to all clients
                broadcastToChatClients('userStatusUpdate', {
                    persistentUserId: disconnectedClientInfo.persistentUserId,
                    nickname: disconnectedClientInfo.userProfile.nickname,
                    status: 'left'
                });
            }
            clients.delete(currentSessionId);
            console.log(`Client (Session ID: ${currentSessionId}) disconnected. Total clients: ${clients.size}`);
            sendAdminUpdate();
        });

        ws.on('error', (error) => {
            console.error(`WebSocket error for client (Session ID: ${currentSessionId}):`, error);
        });
    });
}

function deleteOldMessages() {
    const twoDaysAgo = Date.now() - (2 * 24 * 60 * 60 * 1000);
    db.run("DELETE FROM messages WHERE timestamp < ?", [twoDaysAgo], function(err) {
        if (err) {
            console.error("Error deleting old messages from DB:", err.message);
        } else {
            console.log(`Successfully deleted ${this.changes} old messages from the database.`);
            const initialLength = messages.length;
            const newMessages = messages.filter(msg => msg.timestamp >= twoDaysAgo);
            messages.length = 0;
            messages.push(...newMessages);
            console.log(`Removed ${initialLength - messages.length} messages from the in-memory array.`);
        }
    });
}

// --- STARTUP SEQUENCE ---
connectToSQLite().then(() => {
    return loadInitialData();
}).then(() => {
    console.log('Initial data loaded. Server ready.');
    const wss = new WebSocketServer({ port: PORT });
    setupWebSocketListeners();
    console.log(`WebSocket server started on port ${PORT}`);
    setInterval(deleteOldMessages, 24 * 60 * 60 * 1000);
    console.log('Periodic message cleanup job scheduled to run every 24 hours.');
}).catch(err => {
    console.error('Server startup failed:', err);
    process.exit(1);
});
