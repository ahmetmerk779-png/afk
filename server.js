const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mc = require('minecraft-protocol');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

const bots = {}; // Bot ID -> { client, config, startTime, status, position, scoreboard, antiAfkInterval, reconnectTimer }

io.on('connection', (socket) => {
  console.log('Bir kullanıcı panele bağlandı:', socket.id);
  updateBotCounts();

  socket.on('start-bot', (config) => {
    const { id, host, port, username, version, loginCmd, subServer, autoReconnect } = config;

    if (bots[id] && bots[id].client) {
      socket.emit('bot-log', { id, message: 'Bu ID ile zaten çalışan aktif bir bot var!' });
      return;
    }

    const connectBot = () => {
      socket.emit('bot-log', { id, message: `${username} -> ${host}:${port} sunucusuna bağlanıyor...` });

      try {
        const client = mc.createClient({
          host: host,
          port: parseInt(port) || 25565,
          username: username,
          version: version || false,
          auth: 'offline'
        });

        const startTime = bots[id] && bots[id].startTime ? bots[id].startTime : Date.now();
        
        bots[id] = { 
          client, 
          config, 
          startTime, 
          status: 'Bağlanıyor', 
          position: { x: 0, y: 0, z: 0 },
          scoreboard: { title: 'Yok' },
          antiAfkInterval: null,
          reconnectTimer: null
        };

        io.emit('bot-status', { id, status: 'Bağlanıyor' });
        updateBotCounts();

        client.on('spawn', () => {
          bots[id].status = 'Oyunda';
          io.emit('bot-status', { id, status: 'Oyunda' });
          io.emit('bot-log', { id, message: 'Oyuna başarıyla giriş yapıldı.' });

          // Giriş (Login) komutu varsa gönder
          if (loginCmd) {
            setTimeout(() => {
              try {
                client.write('chat', { message: loginCmd });
                io.emit('bot-log', { id, message: `Login komutu gönderildi: ${loginCmd}` });
              } catch (e) {}
            }, 1500);
          }

          // Alt sunucu geçişi (/gir) varsa gönder
          if (subServer) {
            setTimeout(() => {
              try {
                client.write('chat', { message: `/gir ${subServer}` });
                io.emit('bot-log', { id, message: `Alt sunucuya geçiliyor: /gir ${subServer}` });
              } catch (e) {}
            }, 3500);
          }

          // Anti-AFK (Periyodik küçük kafa hareketi)
          if (bots[id].antiAfkInterval) clearInterval(bots[id].antiAfkInterval);
          bots[id].antiAfkInterval = setInterval(() => {
            try {
              const randomYaw = Math.floor(Math.random() * 360);
              client.write('look', { yaw: randomYaw, pitch: 0, onGround: true });
            } catch (e) {}
          }, 25000);
        });

        // Paket dinleyicileri (Radar ve Scoreboard)
        client.on('packet', (data, meta) => {
          if (meta.name === 'position' || meta.name === 'player_position_and_look') {
            if (data.x !== undefined && data.z !== undefined) {
              bots[id].position = { 
                x: Math.round(data.x), 
                y: Math.round(data.y || 0), 
                z: Math.round(data.z) 
              };
              io.emit('bot-radar', { id, position: bots[id].position });
            }
          }
          if (meta.name === 'scoreboard_objective') {
            bots[id].scoreboard.title = data.displayText || data.name || 'Yok';
            io.emit('bot-scoreboard', { id, scoreboard: bots[id].scoreboard });
          }
        });

        client.on('error', (err) => {
          io.emit('bot-log', { id, message: `Hata: ${err.message}` });
        });

        client.on('end', (reason) => {
          bots[id].status = 'Bağlantı Kesildi';
          io.emit('bot-status', { id, status: 'Bağlantı Kesildi' });
          io.emit('bot-log', { id, message: `Bağlantı koptu: ${reason}` });

          if (bots[id].antiAfkInterval) clearInterval(bots[id].antiAfkInterval);

          // Oto Yeniden Bağlanma
          if (autoReconnect) {
            io.emit('bot-log', { id, message: '5 saniye sonra otomatik yeniden bağlanılacak...' });
            bots[id].reconnectTimer = setTimeout(() => {
              connectBot();
            }, 5000);
          } else {
            delete bots[id];
            updateBotCounts();
          }
        });

      } catch (e) {
        socket.emit('bot-log', { id, message: `Kritik Hata: ${e.message}` });
      }
    };

    connectBot();
  });

  socket.on('stop-bot', (id) => {
    if (bots[id]) {
      if (bots[id].reconnectTimer) clearTimeout(bots[id].reconnectTimer);
      if (bots[id].antiAfkInterval) clearInterval(bots[id].antiAfkInterval);
      if (bots[id].client) {
        try {
          bots[id].client.end('Kullanıcı isteğiyle durduruldu');
        } catch (e) {}
      }
      delete bots[id];
      io.emit('bot-status', { id, status: 'Durduruldu' });
      io.emit('bot-log', { id, message: 'Bot durduruldu.' });
      updateBotCounts();
    }
  });
});

// Uptime ve Bot Sayısı Periyodik Güncellemesi
setInterval(() => {
  const botStats = {};
  for (const id in bots) {
    if (bots[id] && bots[id].startTime) {
      const uptimeSeconds = Math.floor((Date.now() - bots[id].startTime) / 1000);
      botStats[id] = { uptime: formatUptime(uptimeSeconds), status: bots[id].status };
    }
  }
  io.emit('stats-update', { bots: botStats });
}, 1000);

function updateBotCounts() {
  io.emit('total-bots', Object.keys(bots).length);
}

function formatUptime(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return `${h}s ${m}d ${s}sn`;
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Panel çalışıyor: Port ${PORT}`);
});
