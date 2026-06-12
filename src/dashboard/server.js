import 'dotenv/config';
import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import mongoose from 'mongoose';
import Redis from 'ioredis';
import path from 'path';
import { fileURLToPath } from 'url';

import config from '../../config/default.js';
import { getRejectQueueModel } from '../memory/models/ModerationQueue.js';
import { Blacklist } from '../memory/models/Blacklist.js';
import { AuditLog } from '../memory/models/AuditLog.js';
import { BotDefinition } from '../memory/models/BotDefinition.js';
import { Persona } from '../memory/models/Persona.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
  }
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Connect to MongoDB
mongoose.connect(config.mongo.url)
  .then(() => console.log('✓ Dashboard MongoDB connected'))
  .catch((err) => console.error('✗ Dashboard MongoDB connection error:', err));

// Connect to Redis
const redisPub = new Redis(config.redis.url);
const redisSub = new Redis(config.redis.url);

redisPub.on('error', (err) => console.error('Redis Pub Client Error', err));
redisSub.on('error', (err) => console.error('Redis Sub Client Error', err));

// Subscribe to Redis moderation channel for new generated replies
redisSub.subscribe('moderation:channel', (err) => {
  if (err) {
    console.error('Failed to subscribe to Redis channel:', err);
  } else {
    console.log('✓ Subscribed to Redis moderation:channel');
  }
});

redisSub.on('message', (channel, message) => {
  if (channel === 'moderation:channel') {
    try {
      const parsed = JSON.parse(message);
      if (parsed.type === 'new_item') {
        console.log(`[Realtime] New queue item from bot: ${parsed.data.botId} in room: ${parsed.data.roomId}`);
        io.emit('moderation:new_item', parsed.data);
      }
    } catch (err) {
      console.error('Failed to process sub channel message:', err);
    }
  }
});

// Helper: Get active bots and their active rooms from Redis hash `bot:*:rooms`
async function getActiveBots() {
  try {
    const keys = await redisPub.keys('bot:*:rooms');
    const activeBots = [];

    // Also get all persona display names from MongoDB to enrich details
    const personas = await Persona.find({}).lean();
    const personasMap = new Map(personas.map(p => [p.botId, p]));

    for (const key of keys) {
      const botId = key.split(':')[1];
      const roomsData = await redisPub.hgetall(key);
      const broadcasterGroups = {};

      for (const [roomId, val] of Object.entries(roomsData)) {
        try {
          const room = JSON.parse(val);
          // Check if heartbeat exists in Redis
          const isAlive = await redisPub.exists(`bot:${botId}:room:${roomId}:heartbeat`);
          if (isAlive === 1) {
            const bId = room.broadcasterId;
            if (!broadcasterGroups[bId]) {
              broadcasterGroups[bId] = {
                broadcasterId: bId,
                roomName: room.roomName || roomId,
                roomId: roomId,
                joinedAt: room.joinedAt,
                owner: room.owner,
                allRoomIds: [roomId]
              };
            } else {
              broadcasterGroups[bId].allRoomIds.push(roomId);
              // Prefer LiveKit room names (usually starting with live_) as primary
              if (roomId.startsWith('live_')) {
                broadcasterGroups[bId].roomName = room.roomName || roomId;
                broadcasterGroups[bId].roomId = roomId;
              }
            }
          } else {
            // Prune dead room from Redis hash
            await redisPub.hdel(key, roomId);
          }
        } catch (err) {
          // ignore parsing/redis error
        }
      }

      const activeRooms = Object.values(broadcasterGroups);

      if (activeRooms.length > 0) {
        const personaInfo = personasMap.get(botId);
        activeBots.push({
          botId,
          displayName: personaInfo?.displayName || botId.replace('-bot', ''),
          roomsCount: activeRooms.length,
          rooms: activeRooms,
          persona: personaInfo || null
        });
      }
    }
    return activeBots;
  } catch (err) {
    console.error('Error fetching active bots:', err);
    return [];
  }
}

// Helper: Get pending and held items across all bot reject queues
async function getPendingQueues() {
  const pendingQueue = [];
  try {
    const db = mongoose.connection.db;
    if (db) {
      const dbCollections = await db.listCollections().toArray();
      const rejectQueueCols = dbCollections.filter(c => c.name.startsWith('reject_queue/'));

      for (const col of rejectQueueCols) {
        const botName = col.name.replace('reject_queue/', '');
        const RejectQueue = getRejectQueueModel(botName);
        const items = await RejectQueue.find({ status: { $in: ['pending', 'held'] } }).sort({ timestamp: 1 }).lean();
        pendingQueue.push(...items);
      }
    }
  } catch (err) {
    console.error('Error fetching pending queues:', err);
  }
  return pendingQueue;
}

// Socket.IO Connection Handler
io.on('connection', async (socket) => {
  console.log('Admin client connected:', socket.id);

  // Send initial data
  try {
    const activeBots = await getActiveBots();
    socket.emit('init:bots', activeBots);

    const pendingQueue = await getPendingQueues();
    socket.emit('init:queue', pendingQueue);

    const blacklist = await Blacklist.find({}).sort({ addedAt: -1 }).lean();
    socket.emit('init:blacklist', blacklist);

    const logs = await AuditLog.find({}).sort({ timestamp: -1 }).limit(100).lean();
    socket.emit('init:logs', logs);
  } catch (err) {
    console.error('Error sending initial data to client:', err);
  }

  // Handle Refresh Action
  socket.on('refresh:bots', async () => {
    const activeBots = await getActiveBots();
    socket.emit('update:bots', activeBots);
  });

  // Handle Moderation Action (Approve, Reject, Hold, Blacklist)
  socket.on('action:moderation', async (payload, callback) => {
    const { queueId, botId, action, newAnswer } = payload;
    try {
      if (!botId) {
        return callback({ success: false, error: 'botId is required' });
      }
      const RejectQueue = getRejectQueueModel(botId);
      const item = await RejectQueue.findById(queueId);
      if (!item) {
        return callback({ success: false, error: 'Queue item not found' });
      }

      if (action === 'edit') {
        if (!newAnswer || !newAnswer.trim()) {
          return callback({ success: false, error: 'Answer cannot be empty' });
        }
        item.answer = newAnswer.trim();
        await item.save();

        // Save Audit Log
        await AuditLog.create({
          botId: item.botId,
          roomId: item.roomId,
          action: 'edit',
          details: `Edited reply from: "${item.question}" to: "${item.answer}"`,
        });

      } else if (action === 'approve') {
        item.status = 'approved';
        item.actionedAt = new Date();
        await item.save();

        // Save Audit Log
        await AuditLog.create({
          botId: item.botId,
          roomId: item.roomId,
          action: 'approve',
          details: `Approved reply: "${item.answer}" for question: "${item.question}"`,
        });

        // Publish approval to Redis pub/sub
        await redisPub.publish('moderation:channel', JSON.stringify({
          type: 'approved',
          botId: item.botId,
          roomId: item.roomId,
          queueId: item._id,
          text: item.answer,
          trigger: item.trigger,
          usage: item.usage,
        }));

      } else if (action === 'reject') {
        item.status = 'rejected';
        item.actionedAt = new Date();
        await item.save();

        // Save Audit Log
        await AuditLog.create({
          botId: item.botId,
          roomId: item.roomId,
          action: 'reject',
          details: `Rejected reply: "${item.answer}"`,
        });

      } else if (action === 'hold') {
        item.status = 'held';
        item.actionedAt = new Date();
        await item.save();

        // Save Audit Log
        await AuditLog.create({
          botId: item.botId,
          roomId: item.roomId,
          action: 'hold',
          details: `Held reply: "${item.answer}"`,
        });

      } else if (action === 'blacklist') {
        item.status = 'blacklisted';
        item.actionedAt = new Date();
        await item.save();

        // Add to Blacklist DB
        await Blacklist.updateOne(
          { phrase: item.answer },
          { $set: { phrase: item.answer, addedAt: new Date() } },
          { upsert: true }
        );

        // Save Audit Log
        await AuditLog.create({
          botId: item.botId,
          roomId: item.roomId,
          action: 'blacklist',
          details: `Blacklisted sentence and blocked reply: "${item.answer}"`,
        });

        // Notify client about blacklist update
        const updatedBlacklist = await Blacklist.find({}).sort({ addedAt: -1 }).lean();
        io.emit('update:blacklist', updatedBlacklist);
      }

      // Notify all clients about status update (except for edit action which doesn't change status)
      if (action !== 'edit') {
        io.emit('moderation:item_updated', { queueId: item._id, status: item.status, actionedAt: item.actionedAt });
      }

      const updatedLogs = await AuditLog.find({}).sort({ timestamp: -1 }).limit(100).lean();
      io.emit('update:logs', updatedLogs);

      callback({ success: true });
    } catch (err) {
      console.error('Error handling moderation action:', err);
      callback({ success: false, error: err.message });
    }
  });

  // Handle Custom Reply from Admin
  socket.on('action:custom_reply', async (payload, callback) => {
    const { botId, roomId, text } = payload;
    try {
      if (!botId || !roomId || !text?.trim()) {
        return callback({ success: false, error: 'botId, roomId, and text are required' });
      }

      // Publish approved response to Redis pub/sub channel moderation:channel
      // Passing trigger with question as null, and questionUser as admin
      await redisPub.publish('moderation:channel', JSON.stringify({
        type: 'approved',
        botId,
        roomId,
        text: text.trim(),
        trigger: { text: null, username: 'admin', userId: 'admin' },
        usage: { prompt_tokens: 0, completion_tokens: 0 }
      }));

      // Save Audit Log
      await AuditLog.create({
        botId,
        roomId,
        action: 'approve',
        details: `Sent custom reply: "${text.trim()}"`,
      });

      const updatedLogs = await AuditLog.find({}).sort({ timestamp: -1 }).limit(100).lean();
      io.emit('update:logs', updatedLogs);

      callback({ success: true });
    } catch (err) {
      console.error('Error sending custom reply:', err);
      callback({ success: false, error: err.message });
    }
  });

  // Handle Add Blacklist Phrase Manually
  socket.on('blacklist:add', async (phrase, callback) => {
    try {
      if (!phrase?.trim()) {
        return callback({ success: false, error: 'Phrase cannot be empty' });
      }

      await Blacklist.updateOne(
        { phrase: phrase.trim() },
        { $set: { phrase: phrase.trim(), addedAt: new Date() } },
        { upsert: true }
      );

      await AuditLog.create({
        action: 'blacklist',
        details: `Manually blacklisted phrase: "${phrase.trim()}"`,
      });

      const updatedBlacklist = await Blacklist.find({}).sort({ addedAt: -1 }).lean();
      io.emit('update:blacklist', updatedBlacklist);

      const updatedLogs = await AuditLog.find({}).sort({ timestamp: -1 }).limit(100).lean();
      io.emit('update:logs', updatedLogs);

      callback({ success: true });
    } catch (err) {
      console.error('Error adding manual blacklist phrase:', err);
      callback({ success: false, error: err.message });
    }
  });

  // Handle Remove Blacklist Phrase Manually
  socket.on('blacklist:remove', async (phraseId, callback) => {
    try {
      const item = await Blacklist.findById(phraseId);
      if (!item) {
        return callback({ success: false, error: 'Phrase not found' });
      }

      await Blacklist.findByIdAndDelete(phraseId);

      await AuditLog.create({
        action: 'reject', // or general log
        details: `Removed phrase from blacklist: "${item.phrase}"`,
      });

      const updatedBlacklist = await Blacklist.find({}).sort({ addedAt: -1 }).lean();
      io.emit('update:blacklist', updatedBlacklist);

      const updatedLogs = await AuditLog.find({}).sort({ timestamp: -1 }).limit(100).lean();
      io.emit('update:logs', updatedLogs);

      callback({ success: true });
    } catch (err) {
      console.error('Error removing blacklist phrase:', err);
      callback({ success: false, error: err.message });
    }
  });

  socket.on('disconnect', () => {
    console.log('Admin client disconnected:', socket.id);
  });
});

// Periodically broadcast active bots state to all connected clients
setInterval(async () => {
  try {
    const activeBots = await getActiveBots();
    io.emit('update:bots', activeBots);
  } catch (err) {
    console.error('Error in active bots broadcast interval:', err);
  }
}, 5000);

const PORT = process.env.PORT || 4000;
httpServer.listen(PORT, () => {
  console.log(`=========================================`);
  console.log(`  Dashboard server running on port ${PORT}`);
  console.log(`  Access dashboard at http://localhost:${PORT}`);
  console.log(`=========================================`);
});
