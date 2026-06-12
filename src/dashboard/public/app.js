// State Management
const state = {
  bots: [],
  queue: [],
  blacklist: [],
  logs: [],
  currentBotId: null,
  currentRoomId: null,
  currentRoomIds: [],
  currentTab: 'pending' // pending, held, blacklist, audit
};

// Connect to Socket.IO Server
const socket = io();

// UI Elements
const statusIndicator = document.querySelector('.status-indicator');
const statusText = document.querySelector('.status-text');

// Connection Event Handlers
socket.on('connect', () => {
  statusIndicator.className = 'status-indicator online';
  statusText.textContent = 'Connected (Live)';
});

socket.on('disconnect', () => {
  statusIndicator.className = 'status-indicator offline';
  statusText.textContent = 'Disconnected';
});

socket.on('connect_error', () => {
  statusIndicator.className = 'status-indicator offline';
  statusText.textContent = 'Connection Error';
});

// Init Event Handlers
socket.on('init:bots', (bots) => {
  state.bots = bots;
  renderBots();
});

socket.on('init:queue', (queue) => {
  state.queue = queue;
  renderQueues();
  updateBadges();
});

socket.on('init:blacklist', (blacklist) => {
  state.blacklist = blacklist;
  renderBlacklist();
});

socket.on('init:logs', (logs) => {
  state.logs = logs;
  renderAuditLogs();
});

// Update Event Handlers
socket.on('update:bots', (bots) => {
  state.bots = bots;
  renderBots();
  if (state.currentBotId) {
    updateRoomsView();
  }
});

socket.on('update:blacklist', (blacklist) => {
  state.blacklist = blacklist;
  renderBlacklist();
});

socket.on('update:logs', (logs) => {
  state.logs = logs;
  renderAuditLogs();
});

// Real-time Event Handlers
socket.on('moderation:new_item', (item) => {
  // Add item if not already in queue
  if (!state.queue.find(q => q._id === item._id)) {
    state.queue.push(item);
    renderQueues();
    updateBadges();
    playNotificationSound();
  }
});

socket.on('moderation:item_updated', (update) => {
  const { queueId, status } = update;
  // Update local queue item status
  const item = state.queue.find(q => q._id === queueId);
  if (item) {
    item.status = status;
    // Remove if it's no longer pending or held
    if (status !== 'pending' && status !== 'held') {
      state.queue = state.queue.filter(q => q._id !== queueId);
    }
    renderQueues();
    updateBadges();
  }
});

// Audio notification helper
function playNotificationSound() {
  try {
    const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const oscillator = audioCtx.createOscillator();
    const gainNode = audioCtx.createGain();
    
    oscillator.connect(gainNode);
    gainNode.connect(audioCtx.destination);
    
    oscillator.type = 'sine';
    oscillator.frequency.setValueAtTime(587.33, audioCtx.currentTime); // D5
    gainNode.gain.setValueAtTime(0.08, audioCtx.currentTime);
    
    oscillator.start();
    oscillator.stop(audioCtx.currentTime + 0.15);
  } catch (e) {
    // browser blocked audio
  }
}

// Navigation System
function navigateTo(page) {
  document.querySelectorAll('.page-section').forEach(section => {
    section.classList.remove('active');
  });

  if (page === 'bots') {
    document.getElementById('page-bots').classList.add('active');
    state.currentBotId = null;
    state.currentRoomId = null;
  } else if (page === 'rooms') {
    document.getElementById('page-rooms').classList.add('active');
    state.currentRoomId = null;
  } else if (page === 'moderation') {
    document.getElementById('page-moderation').classList.add('active');
  }
}

function selectBot(botId) {
  state.currentBotId = botId;
  navigateTo('rooms');
  updateRoomsView();
}

function selectRoom(botId, roomId) {
  state.currentBotId = botId;
  state.currentRoomId = roomId;

  const bot = state.bots.find(b => b.botId === botId);
  const room = bot?.rooms.find(r => r.roomId === roomId);
  state.currentRoomIds = room ? room.allRoomIds : [roomId];

  navigateTo('moderation');
  updateModerationView();
}

function refreshBotsData() {
  socket.emit('refresh:bots');
}

// Rendering Functions
function renderBots() {
  const grid = document.getElementById('bots-grid');
  if (state.bots.length === 0) {
    grid.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">🤖</div>
        <h3>No active bots detected</h3>
        <p>Ensure your BotRunner processes are connected to Redis and running.</p>
        <button class="btn btn-primary" onclick="refreshBotsData()" style="margin-top: 1rem;">🔄 Retry Scan</button>
      </div>
    `;
    return;
  }

  grid.innerHTML = state.bots.map(bot => `
    <div class="bot-card">
      <div class="bot-header">
        <div class="bot-title-area">
          <h3>${escapeHtml(bot.displayName)}</h3>
          <span class="bot-subtitle">${escapeHtml(bot.botId)}</span>
        </div>
        <div class="bot-status-tag">
          <span class="status-indicator online"></span> ONLINE
        </div>
      </div>
      
      <div class="bot-rooms-stat">
        <div class="label">Connected Rooms</div>
        <div class="value">${bot.roomsCount}</div>
      </div>

      <button class="btn btn-primary" style="width: 100%; justify-content: center;" onclick="selectBot('${escapeHtml(bot.botId)}')">
        Manage Rooms &rarr;
      </button>
    </div>
  `).join('');
}

function updateRoomsView() {
  const bot = state.bots.find(b => b.botId === state.currentBotId);
  const breadcrumb = document.getElementById('current-bot-breadcrumb');
  
  if (!bot) {
    breadcrumb.textContent = state.currentBotId;
    document.getElementById('rooms-list').innerHTML = `
      <div class="empty-state">
        <h3>Bot connection details not found</h3>
        <p>This bot might have disconnected.</p>
      </div>
    `;
    return;
  }

  breadcrumb.textContent = bot.displayName;

  const roomsList = document.getElementById('rooms-list');
  if (bot.rooms.length === 0) {
    roomsList.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">📹</div>
        <h3>No active livestream rooms</h3>
        <p>This chatbot is online but not connected to any active LiveKit/Socket.IO room sessions.</p>
      </div>
    `;
    return;
  }

  roomsList.innerHTML = bot.rooms.map(room => `
    <div class="room-card">
      <div class="room-details">
        <div class="room-id-area">
          <span class="room-id">${escapeHtml(room.roomName || room.roomId)}</span>
          <span class="room-name">Room ID: ${escapeHtml(room.roomId)}</span>
        </div>
        <div class="room-meta-item">
          <span class="lbl">Broadcaster ID</span>
          <span class="val">${escapeHtml(String(room.broadcasterId))}</span>
        </div>
        <div class="room-meta-item">
          <span class="lbl">Joined At</span>
          <span class="val">${new Date(room.joinedAt).toLocaleTimeString()}</span>
        </div>
      </div>
      <button class="btn btn-secondary" onclick="selectRoom('${escapeHtml(bot.botId)}', '${escapeHtml(room.roomId)}')">
        Open Moderation Console &rarr;
      </button>
    </div>
  `).join('');
}

function getCurrentRoomData() {
  const bot = state.bots.find(b => b.botId === state.currentBotId);
  if (!bot || !Array.isArray(bot.rooms)) return null;
  return bot.rooms.find(room => room.roomId === state.currentRoomId) || null;
}

function extractBroadcasterProfile(room) {
  const owner = room?.owner;
  if (!owner || typeof owner !== 'object') {
    return { name: 'Unknown', gender: 'Unknown' };
  }

  const rawName = owner.username || owner.name || owner.displayName || owner.fullName || owner.nickName || owner.nick || owner.userName || '';
  const rawGender = owner.gender || owner.sex || owner.userGender || '';

  const name = String(rawName || '').trim() || 'Unknown';
  const gender = String(rawGender || '').trim() || 'Unknown';

  return { name, gender };
}

function updateBroadcasterMeta() {
  const nameEl = document.getElementById('broadcaster-name');
  const genderEl = document.getElementById('broadcaster-gender');
  if (!nameEl || !genderEl) return;

  const room = getCurrentRoomData();
  const profile = extractBroadcasterProfile(room);

  nameEl.textContent = profile.name;
  genderEl.textContent = profile.gender;
}

function syncCustomReplyHeight() {
  const customReplyCard = document.querySelector('.custom-reply-card');
  const leftPanel = document.querySelector('.console-left-panel');
  if (!customReplyCard) return;

  if (!leftPanel || window.innerWidth <= 1024) {
    customReplyCard.style.height = 'auto';
    customReplyCard.style.marginTop = '0';
    return;
  }

  const activeContent = document.querySelector('.tab-content.active');
  const alignTarget = activeContent?.querySelector('.queue-card, .empty-state, .blacklist-manager, .audit-log-container');

  if (!alignTarget) {
    customReplyCard.style.height = 'auto';
    customReplyCard.style.marginTop = '0';
    return;
  }

  const leftPanelRect = leftPanel.getBoundingClientRect();
  const targetRect = alignTarget.getBoundingClientRect();
  const offsetTop = Math.max(0, targetRect.top - leftPanelRect.top);

  customReplyCard.style.marginTop = `${offsetTop}px`;
  customReplyCard.style.height = `${alignTarget.offsetHeight}px`;
}

function scheduleCustomReplyHeightSync() {
  requestAnimationFrame(syncCustomReplyHeight);
}

function updateModerationView() {
  const bot = state.bots.find(b => b.botId === state.currentBotId);
  const breadcrumbBot = document.getElementById('bot-breadcrumb-link');
  const breadcrumbRoom = document.getElementById('room-breadcrumb');
  
  breadcrumbBot.textContent = bot ? bot.displayName : state.currentBotId;
  breadcrumbBot.onclick = () => selectBot(state.currentBotId);
  breadcrumbRoom.textContent = state.currentRoomId;
  updateBroadcasterMeta();

  // Render console content

  renderQueues();
  renderAuditLogs();
  scheduleCustomReplyHeightSync();
}

function updateBadges() {
  const filtered = state.queue.filter(q => q.botId === state.currentBotId && state.currentRoomIds.includes(q.roomId));
  const pendingCount = filtered.filter(q => q.status === 'pending').length;
  const heldCount = filtered.filter(q => q.status === 'held').length;

  document.getElementById('badge-pending').textContent = pendingCount;
  document.getElementById('badge-held').textContent = heldCount;
}

function switchTab(tab) {
  state.currentTab = tab;
  
  // Update tab buttons
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.classList.remove('active');
  });
  document.getElementById(`tab-${tab}`).classList.add('active');

  // Update tab contents
  document.querySelectorAll('.tab-content').forEach(content => {
    content.classList.remove('active');
  });
  document.getElementById(`content-${tab}`).classList.add('active');

  scheduleCustomReplyHeightSync();
}

function renderQueues() {
  const filtered = state.queue.filter(q => q.botId === state.currentBotId && state.currentRoomIds.includes(q.roomId));
  
  // Render Pending
  const pendingList = document.getElementById('pending-queue-list');
  const pendingItems = filtered.filter(q => q.status === 'pending');
  
  if (pendingItems.length === 0) {
    pendingList.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">☕</div>
        <h3>Queue is empty</h3>
        <p>Awaiting new messages. Responses generated by the AI bot will appear here in real-time.</p>
      </div>
    `;
  } else {
    pendingList.innerHTML = pendingItems.map(item => renderQueueCard(item)).join('');
  }

  // Render Held
  const heldList = document.getElementById('held-queue-list');
  const heldItems = filtered.filter(q => q.status === 'held');

  if (heldItems.length === 0) {
    heldList.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">📂</div>
        <h3>No held messages</h3>
        <p>Items placed on HOLD will stay here for later review.</p>
      </div>
    `;
  } else {
    heldList.innerHTML = heldItems.map(item => renderQueueCard(item)).join('');
  }

  updateBadges();
  scheduleCustomReplyHeightSync();
}

function renderQueueCard(item) {
  const isHeld = item.status === 'held';
  const answerHtml = `<div class="qa-bubble answer editable" onclick="startEditingAnswer(this, '${item._id}')" data-item-id="${item._id}">${escapeHtml(item.answer)}</div>`;
  
  return `
    <div class="queue-card" id="card-${item._id}">
      <div class="queue-card-header">
        <div class="queue-card-meta">
          <span class="path-badge">${escapeHtml(item.botId)}</span>
          <span class="path-arrow">&rarr;</span>
          <span class="path-badge">${escapeHtml(item.roomId)}</span>
          ${isHeld ? '<span class="held-indicator">HOLD</span>' : ''}
        </div>
        <span class="time-stamp">${new Date(item.timestamp).toLocaleTimeString()}</span>
      </div>

      <div class="qa-layout">
        <div class="qa-row">
          <span class="qa-label">Question:</span>
          <div class="qa-bubble question">"${escapeHtml(item.question)}"</div>
        </div>
        <div class="qa-row">
          <span class="qa-label">Answer:</span>
          ${answerHtml}
        </div>
      </div>

      <div class="queue-card-actions">
        <button class="btn btn-secondary btn-icon" onclick="moderationAction('${item._id}', 'hold')" ${isHeld ? 'disabled' : ''}>
          ⏳ Hold
        </button>
        <button class="btn btn-dark btn-icon" onclick="moderationAction('${item._id}', 'blacklist')">
          🚫 Blacklist Reply
        </button>
        <button class="btn btn-danger btn-icon" onclick="moderationAction('${item._id}', 'reject')">
          ❌ Reject
        </button>
        <button class="btn btn-success btn-icon" onclick="moderationAction('${item._id}', 'approve')">
          ✅ Approve & Send
        </button>
      </div>
    </div>
  `;
}

function renderBlacklist() {
  const container = document.getElementById('blacklist-items');
  if (state.blacklist.length === 0) {
    container.innerHTML = `<p style="color: var(--text-dark); text-align: center; padding: 2rem 0;">No phrases blacklisted yet.</p>`;
    return;
  }

  container.innerHTML = state.blacklist.map(item => `
    <div class="blacklist-item">
      <span class="blacklist-phrase">"${escapeHtml(item.phrase)}"</span>
      <button class="btn-trash" onclick="removeBlacklist('${item._id}')" title="Remove phrase">
        🗑️
      </button>
    </div>
  `).join('');

  scheduleCustomReplyHeightSync();
}

function renderAuditLogs() {
  const container = document.getElementById('audit-log-items');
  
  // Filter logs related to current bot/room or global manual blacklists
  const filteredLogs = state.logs.filter(log => {
    if (!state.currentBotId) return true;
    return (!log.botId || log.botId === state.currentBotId) && (!log.roomId || state.currentRoomIds.includes(log.roomId));
  });

  if (filteredLogs.length === 0) {
    container.innerHTML = `<p style="color: var(--text-dark); text-align: center; padding: 2rem 0;">No logs recorded yet.</p>`;
    return;
  }

  container.innerHTML = filteredLogs.map(log => `
    <div class="audit-item ${log.action}">
      <span class="audit-time">${new Date(log.timestamp).toLocaleTimeString()}</span>
      <span class="audit-desc">${escapeHtml(log.details)}</span>
    </div>
  `).join('');

  scheduleCustomReplyHeightSync();
}

// Socket Emit Handlers
function moderationAction(queueId, action) {
  const item = state.queue.find(q => q._id === queueId);
  const botId = item ? item.botId : null;

  const card = document.getElementById(`card-${queueId}`);
  if (card) card.style.opacity = '0.5';

  socket.emit('action:moderation', { queueId, botId, action }, (res) => {
    if (!res.success) {
      alert('Failed to execute action: ' + res.error);
      if (card) card.style.opacity = '1';
    }
  });
}

function removeBlacklist(phraseId) {
  if (confirm('Are you sure you want to remove this phrase from the blacklist?')) {
    socket.emit('blacklist:remove', phraseId, (res) => {
      if (!res.success) {
        alert('Failed to remove from blacklist: ' + res.error);
      }
    });
  }
}

// Edit Modal Functions
let currentEditingItemId = null;

function startEditingAnswer(answerElement, queueId) {
  // Prevent if already editing
  if (answerElement.classList.contains('editing')) {
    return;
  }

  const item = state.queue.find(q => q._id === queueId);
  if (!item) return;

  currentEditingItemId = queueId;
  const currentAnswer = item.answer;

  // Create edit container
  const editContainer = document.createElement('div');
  editContainer.className = 'edit-textarea-container';
  editContainer.innerHTML = `
    <textarea class="edit-answer-input">${escapeHtml(currentAnswer)}</textarea>
    <div class="edit-action-buttons">
      <button class="btn btn-success btn-sm" onclick="performActionWithEdit('${queueId}', 'approve')">✈️ Send</button>
      <button class="btn btn-danger btn-sm" onclick="performActionWithEdit('${queueId}', 'reject')">❌ Reject</button>
      <button class="btn btn-secondary btn-sm" onclick="performActionWithEdit('${queueId}', 'hold')">⏳ Hold</button>
      <button class="btn btn-dark btn-sm" onclick="cancelEditingAnswer('${queueId}')">Cancel</button>
    </div>
  `;

  // Replace answer content with edit container
  answerElement.classList.add('editing');
  answerElement.innerHTML = '';
  answerElement.appendChild(editContainer);
  
  // Focus textarea
  const textarea = editContainer.querySelector('.edit-answer-input');
  textarea.focus();
  textarea.select();
}

function cancelEditingAnswer(queueId) {
  const item = state.queue.find(q => q._id === queueId);
  if (!item) return;

  const card = document.getElementById(`card-${queueId}`);
  if (card) {
    renderQueues();
  }
  currentEditingItemId = null;
}

function performActionWithEdit(queueId, action) {
  const item = state.queue.find(q => q._id === queueId);
  if (!item) return;

  const card = document.getElementById(`card-${queueId}`);
  const textarea = card.querySelector('.edit-answer-input');
  const newAnswer = textarea.value.trim();

  if (!newAnswer) {
    alert('Answer cannot be empty');
    return;
  }

  // First save the edit, then perform the action
  socket.emit('action:moderation', { queueId, botId: item.botId, action: 'edit', newAnswer }, (res) => {
    if (!res.success) {
      alert('Failed to edit comment: ' + res.error);
    } else {
      item.answer = newAnswer;
      
      // Now perform the requested action
      socket.emit('action:moderation', { queueId, botId: item.botId, action }, (res2) => {
        if (!res2.success) {
          alert('Failed to perform action: ' + res2.error);
          renderQueues();
        }
      });
    }
  });
}

// Add Blacklist Manually
document.getElementById('add-blacklist-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = document.getElementById('blacklist-input');
  const phrase = input.value;
  
  socket.emit('blacklist:add', phrase, (res) => {
    if (res.success) {
      input.value = '';
    } else {
      alert('Failed to add phrase: ' + res.error);
    }
  });
});

// Send Custom Reply
const customReplyForm = document.getElementById('custom-reply-form');
const customReplyInput = document.getElementById('custom-reply-input');

customReplyForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const text = customReplyInput.value;
  
  if (!state.currentBotId || !state.currentRoomId) {
    alert('Please select an active bot and room first.');
    return;
  }

  socket.emit('action:custom_reply', {
    botId: state.currentBotId,
    roomId: state.currentRoomId,
    text: text
  }, (res) => {
    if (res.success) {
      customReplyInput.value = '';
    } else {
      alert('Failed to send custom reply: ' + res.error);
    }
  });
});

customReplyInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    customReplyForm.requestSubmit();
  }
});

window.addEventListener('resize', scheduleCustomReplyHeightSync);

// HTML escaping helper
function escapeHtml(str) {
  if (!str) return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// Trigger initial scan of active bots
setTimeout(refreshBotsData, 1000);
