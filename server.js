const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const crypto = require("crypto");

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static("."));

let nextPlayerId = 1;

const players = new Map();
const rooms = new Map();
const sessionsByToken = new Map();

function generateRoomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";

  for (let i = 0; i < 6; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }

  return code;
}

function createRoom() {
  let code;

  do {
    code = generateRoomCode();
  } while (rooms.has(code));

  rooms.set(code, {
    players: new Set(),
    gameStarted: false,
    boss: {
      x: 800,
      y: 400,
      targetPlayerId: null,
      type: 1
    }
  });

  return code;
}

function broadcastToRoom(roomCode, message) {
  const room = rooms.get(roomCode);

  if (!room) return;

  room.players.forEach((playerId) => {
    const player = players.get(playerId);

    if (
      player &&
      player.socket.readyState === WebSocket.OPEN
    ) {
      player.socket.send(JSON.stringify(message));
    }
  });
}

function replayCardEntrance(){
  document.querySelectorAll('.boss-card').forEach(c=>{
    c.classList.remove('card-in');
    void c.offsetWidth; // force reflow so remove+readd actually restarts the animation
    c.classList.add('card-in');
  });
}

function countAlive(roomCode) {
  const room = rooms.get(roomCode);
  if (!room) return 0;
  let count = 0;
  room.players.forEach((pid) => {
    const pl = players.get(pid);
    if (pl && pl.alive) count++;
  });
  return count;
}

function sendRoomPlayers(roomCode) {
  const room = rooms.get(roomCode);

  if (!room) return;

  const playerList = [];

  room.players.forEach((playerId) => {
    const player = players.get(playerId);

    if (player) {
      playerList.push({
        playerId: playerId,
        host: playerId === room.hostId
      });
    }
  });

  broadcastToRoom(roomCode, {
    type: "roomPlayers",
    players: playerList
  });
}

function finalizeDisconnect(playerId) {
  const player = players.get(playerId);
  if (!player || !player.pendingRemoval) return; // they reconnected already, nothing to do

  const roomCode = player.roomCode;

  if (roomCode) {
    const room = rooms.get(roomCode);

    if (room) {
      room.players.delete(playerId);

      if (room.hostId === playerId) {
        const newHostId = room.players.values().next().value;
        if (newHostId) {
          room.hostId = newHostId;
          const newHost = players.get(newHostId);
          if (newHost && newHost.socket.readyState === WebSocket.OPEN) {
            newHost.socket.send(JSON.stringify({ type: "hostChanged", host: true }));
          }
        }
      }

      if (room.players.size > 0) {
        sendRoomPlayers(roomCode);
      } else {
        rooms.delete(roomCode);
        console.log(`Room ${roomCode} deleted`);
      }
    }
  }

  sessionsByToken.delete(player.sessionToken);
  players.delete(playerId);
  console.log(`Player ${playerId} disconnected (grace period expired)`);
}

wss.on("connection", (socket) => {
  const playerId = nextPlayerId++;
  const sessionToken = crypto.randomUUID();

  players.set(playerId, {
    socket: socket,
    roomCode: null,
    x: 400,
    y: 300,
    alive: true,
    sessionToken: sessionToken,
    disconnectTimer: null,
    pendingRemoval: false
  });

  sessionsByToken.set(sessionToken, playerId);

  console.log(`Player ${playerId} connected`);

  socket.send(JSON.stringify({
    type: "connected",
    playerId: playerId,
    sessionToken: sessionToken
  }));

  socket.on("message", (message) => {
    const data = JSON.parse(message);
    if (data.type === "resume") {
      const oldPlayerId = sessionsByToken.get(data.sessionToken);
      const oldPlayer = oldPlayerId != null ? players.get(oldPlayerId) : null;

      if (!oldPlayer || !oldPlayer.pendingRemoval || !oldPlayer.roomCode) {
        socket.send(JSON.stringify({ type: "resumeFailed" }));
        return;
      }

      clearTimeout(oldPlayer.disconnectTimer);
      oldPlayer.disconnectTimer = null;
      oldPlayer.pendingRemoval = false;
      oldPlayer.socket = socket;

      // retire the throwaway connection created for this fresh socket
      if (playerId !== oldPlayerId) {
        const throwaway = players.get(playerId);
        if (throwaway) sessionsByToken.delete(throwaway.sessionToken);
        players.delete(playerId);
      }

      const room = rooms.get(oldPlayer.roomCode);

      socket.send(JSON.stringify({
        type: "resumed",
        playerId: oldPlayerId,
        roomCode: oldPlayer.roomCode,
        host: room ? room.hostId === oldPlayerId : false,
        bossType: room ? room.boss.type : null
      }));

      if (room) {
        broadcastToRoom(oldPlayer.roomCode, { type: "playerReconnected", playerId: oldPlayerId });
        sendRoomPlayers(oldPlayer.roomCode);
      }

      return;
    }

    const player = players.get(playerId);

    if (!player) return;

    if (data.type === "gamePaused") {
        if (!player.roomCode) return;
        const room = rooms.get(player.roomCode);
        if (!room) return;
        const wantsPause = !!data.paused;
        if (!wantsPause && room.hostId !== playerId) return;

        broadcastToRoom(player.roomCode, {
            type: "gamePaused",
            paused: wantsPause
        });
        return;
    }

    if (data.type === "playerDied") {
        if (!player.roomCode) return;
        const room = rooms.get(player.roomCode);
        if (!room) return;

        player.alive = false;

        broadcastToRoom(player.roomCode, {
            type: "playerDied",
            playerId: playerId
        });

        if (countAlive(player.roomCode) <= 0) {
            broadcastToRoom(player.roomCode, { type: "teamWiped" });
        }
        return;
    }

    if (data.type === "playerRespawned") {
        if (!player.roomCode) return;
        const room = rooms.get(player.roomCode);
        if (!room) return;

        player.alive = true;

        broadcastToRoom(player.roomCode, {
            type: "playerRespawned",
            playerId: playerId
        });
        return;
    }

    if (data.type === "createRoom") {
      if (player.roomCode) {
        socket.send(JSON.stringify({
          type: "roomError",
          message: "You are already in a room."
        }));

        return;
      }

      const roomCode = createRoom();

      player.roomCode = roomCode;

      const room = rooms.get(roomCode);

      room.players.add(playerId);
      room.hostId = playerId;

      socket.send(JSON.stringify({
        type: "roomJoined",
        roomCode: roomCode,
        playerId: playerId,
        host: true
      }));

      socket.send(JSON.stringify({
        type: "bossSelected",
        bossType: room.boss.type
      }));

      sendRoomPlayers(roomCode);

      console.log(`Player ${playerId} created room ${roomCode}`);

      return;
    }

    if (data.type === "joinRoom") {
      if (player.roomCode) {
        socket.send(JSON.stringify({
          type: "roomError",
          message: "You are already in a room."
        }));

        return;
      }

      const roomCode = String(data.roomCode || "")
        .trim()
        .toUpperCase();

      const room = rooms.get(roomCode);

      if (!room) {
        socket.send(JSON.stringify({
          type: "roomError",
          message: "Room does not exist."
        }));

        return;
      }

      if (room.players.size >= 4) {
        socket.send(JSON.stringify({
          type: "roomError",
          message: "Room is full."
        }));

        return;
      }

      if (room.gameStarted) {
        socket.send(JSON.stringify({
          type: "roomError",
          message: "Game already in progress."
        }));
        return;
      }

      player.roomCode = roomCode;
      room.players.add(playerId);

      socket.send(JSON.stringify({
        type: "roomJoined",
        roomCode: roomCode,
        playerId: playerId,
        host: false
      }));

      sendRoomPlayers(roomCode);

      console.log(`Player ${playerId} joined room ${roomCode}`);

      return;
    }

    if (data.type === "leaveRoom") {
      if (!player.roomCode) return;

      const roomCode = player.roomCode;
      const room = rooms.get(roomCode);

      if (!room) return;

      room.players.delete(playerId);
      player.roomCode = null;

      if (room.hostId === playerId) {
        const newHostId = room.players.values().next().value;

        if (newHostId) {
          room.hostId = newHostId;

          const newHost = players.get(newHostId);

          if (newHost) {
            newHost.socket.send(JSON.stringify({
              type: "hostChanged",
              host: true
            }));
          }
        }
      }

      if (room.players.size > 0) {
        sendRoomPlayers(roomCode);
      } else {
        rooms.delete(roomCode);
        console.log(`Room ${roomCode} deleted`);
      }

      socket.send(JSON.stringify({
        type: "roomLeft"
      }));

      console.log(`Player ${playerId} left room ${roomCode}`);

      return;
    }

    if (data.type === "position") {
      if (!player.roomCode) return;

      const room = rooms.get(player.roomCode);

      if (!room) return;

      player.x = data.x;
      player.y = data.y;

      let nearestPlayerId = null;
      let nearestDistance = Infinity;

      room.players.forEach((otherPlayerId) => {
        const otherPlayer = players.get(otherPlayerId);

        if (!otherPlayer || !otherPlayer.alive) return;

        const dx = room.boss.x - otherPlayer.x;
        const dy = room.boss.y - otherPlayer.y;

        const distance = Math.sqrt(
          dx * dx + dy * dy
        );

        if (distance < nearestDistance) {
          nearestDistance = distance;
          nearestPlayerId = otherPlayerId;
        }
      });

      room.boss.targetPlayerId = nearestPlayerId;

      const targetPlayer = players.get(
        room.boss.targetPlayerId
      );

      broadcastToRoom(player.roomCode, {
        type: "position",
        playerId: playerId,
        x: player.x,
        y: player.y,
        hp: data.hp,
        maxHp: data.maxHp
      });

      broadcastToRoom(player.roomCode, {
        type: "bossTarget",
        targetPlayerId: room.boss.targetPlayerId,
        targetX: targetPlayer
          ? targetPlayer.x
          : null,
        targetY: targetPlayer
          ? targetPlayer.y
          : null
      });

      return;
    }

    // ================= FIX: this handler was completely missing. =================
    // The client sends "bossCombatState" every ~50ms while it is the host (see
    // sendBossCombatState() in index.html), but nothing on the server ever
    // relayed it back out. It hit socket.on("message"), matched none of the
    // "if" blocks below, and was silently dropped -- so the non-host client's
    // `if (data.type === "bossCombatState")` handler never fired, and
    // game.boss on P2 was never updated (hp/phase/mode/etc. never synced).
    if (data.type === "bossCombatState") {
      if (!player.roomCode) return;

      const room = rooms.get(player.roomCode);

      if (!room) return;

      if (room.hostId !== playerId) return; // only the host may drive boss state

      broadcastToRoom(player.roomCode, {
        type: "bossCombatState",
        boss: data.boss
      });

      return;
    }

    if (data.type === "bossAttack") {
      if (!player.roomCode) return;

      const room = rooms.get(player.roomCode);

      if (!room) return;

      if (room.hostId !== playerId) return;

      broadcastToRoom(player.roomCode, {
        type: "bossAttack",
        attack: data.attack
      });

      return;
    }

    if (data.type === "damageBoss") {
        if (!player.roomCode) return;
        const room = rooms.get(player.roomCode);
        if (!room) return;
        if (room.hostId === playerId) return; // host doesn't need this relayed to itself

        const hostPlayer = players.get(room.hostId);
        if (hostPlayer && hostPlayer.socket.readyState === WebSocket.OPEN) {
            hostPlayer.socket.send(JSON.stringify({
            type: "damageBoss",
            amount: data.amount
            }));
        }
        return;
    }

    if (data.type === "bossPosition") {
      if (!player.roomCode) return;

      const room = rooms.get(player.roomCode);

      if (!room) return;

      if (room.hostId !== playerId) return;

      room.boss.x = data.x;
      room.boss.y = data.y;

      broadcastToRoom(player.roomCode, {
        type: "bossPosition",
        x: room.boss.x,
        y: room.boss.y
      });

      return;
    }

    // ================= NEW (optional but recommended): per-player damage relay =================
    // See client-patch.md, section 3. The host computes contact/mine/mark hits
    // against BOTH local players (using the synced otherPlayers position) and
    // sends { type: "damagePlayer", targetPlayerId, amount, hitType } instead
    // of calling hurt() only on its own local player object. The server just
    // needs to relay it to the room; the receiving client applies it to its
    // own local game.player if targetPlayerId matches its own myPlayerId.
    if (data.type === "damagePlayer") {
      if (!player.roomCode) return;

      const room = rooms.get(player.roomCode);

      if (!room) return;

      if (room.hostId !== playerId) return; // only host may deal boss damage

      broadcastToRoom(player.roomCode, {
        type: "damagePlayer",
        targetPlayerId: data.targetPlayerId,
        amount: data.amount,
        hitType: data.hitType || "burst"
      });

      return;
    }

    if (data.type === "selectBoss") {
      if (!player.roomCode) return;

      const room = rooms.get(player.roomCode);

      if (!room) return;

      if (room.hostId !== playerId) return;

      room.boss.type = data.bossType;

      broadcastToRoom(player.roomCode, {
        type: "bossSelected",
        bossType: room.boss.type
      });

      return;
    }

    if (data.type === "reportProgress") {
        if (!player.roomCode) return;
        const room = rooms.get(player.roomCode);
        if (!room) return;

        broadcastToRoom(player.roomCode, {
            type: "reportProgress",
            playerId: playerId,
            allCleared: !!data.allCleared
        });
        return;
    }

    if (data.type === "sfx") {
      if (!player.roomCode) return;
      const room = rooms.get(player.roomCode);
      if (!room || room.hostId !== playerId) return;
      room.players.forEach((pid) => {
        if (pid === playerId) return;
        const pl = players.get(pid);
        if (pl && pl.socket.readyState === WebSocket.OPEN) {
          pl.socket.send(JSON.stringify({ type: "sfx", key: data.key }));
        }
      });
      return;
    }

    if (data.type === "startGame") {
      if (!player.roomCode) return;

      const room = rooms.get(player.roomCode);

      if (!room) return;

      if (room.hostId !== playerId) return;
      room.gameStarted = true;
      room.players.forEach((pid) => {
        const pl = players.get(pid);
        if (pl) pl.alive = true;
      });

      broadcastToRoom(player.roomCode, {
        type: "gameStarted",
        bossType: room.boss.type
      });

      console.log(`Room ${player.roomCode} started the game`);

      return;
    }
  });

  socket.on("close", () => {
    const player = players.get(playerId);
    if (!player) return;

    if (!player.roomCode) {
      sessionsByToken.delete(player.sessionToken);
      players.delete(playerId);
      return;
    }

    player.pendingRemoval = true;
    broadcastToRoom(player.roomCode, { type: "playerDisconnected", playerId });

    player.disconnectTimer = setTimeout(() => finalizeDisconnect(playerId), 30000);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`VOID//RUSH multiplayer server running on port ${PORT}`);
});
