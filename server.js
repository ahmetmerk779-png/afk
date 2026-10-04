const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mc = require('minecraft-protocol');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

const bots = {}; 

io.on('connection', (socket) => {
  console.log('Kullanıcı bağlandı:', socket.id);
  updateBotCounts();

  socket.on('start-bot', (config) => {
    const { id, host, port, username, version, loginCmd, subServer, autoReconnect } = config;

    if (bots[id] && bots[id].client) {
      socket.emit('bot-log', { id, message: 'Bu ID ile aktif bir bot zaten var!' });
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
          auth: 'offline',
          skipValidation: true
        });

        const startTime = bots[id] && bots[id].startTime ? bots[id].startTime : Date.now();
        
        bots[id] = { 
          client, 
          config, 
          startTime, 
          status: 'Bağlanıyor', 
          position: { x: 0, y: 0, z: 0 },
          scoreboard: { title: 'Skorbord', items: [] },
          scoresMap: {},
          tabList: [],
          inventory: [],
          nearbyPlayers: [],
          antiAfkInterval: null,
          reconnectTimer: null,
          connectTimeout: null
        };

        io.emit('bot-status', { id, status: 'Bağlanıyor' });
        updateBotCounts();

        bots[id].connectTimeout = setTimeout(() => {
          if (bots[id] && bots[id].status === 'Bağlanıyor') {
            io.emit('bot-log', { id, message: 'Bağlantı zaman aşımına uğradı.' });
            try { client.end('Timeout'); } catch(e){}
          }
        }, 15000);

        client.on('spawn', () => {
          if (bots[id] && bots[id].connectTimeout) clearTimeout(bots[id].connectTimeout);
          bots[id].status = 'Oyunda';
          io.emit('bot-status', { id, status: 'Oyunda' });
          io.emit('bot-log', { id, message: 'Oyuna başarıyla giriş yapıldı.' });

          if (loginCmd) {
            setTimeout(() => { try { client.write('chat', { message: loginCmd }); } catch(e){} }, 1500);
          }
          if (subServer) {
            setTimeout(() => { try { client.write('chat', { message: `/gir ${subServer}` }); } catch(e){} }, 3500);
          }

          if (bots[id].antiAfkInterval) clearInterval(bots[id].antiAfkInterval);
          bots[id].antiAfkInterval = setInterval(() => {
            try {
              const randomYaw = Math.floor(Math.random() * 360);
              client.write('look', { yaw: randomYaw, pitch: 0, onGround: true });
            } catch (e) {}
          }, 25000);
        });

        // Paket Dinleyicileri
        client.on('packet', (data, meta) => {
          // Bot Pozisyonu ve Radar için oyuncu konumları
          if (meta.name === 'position' || meta.name === 'player_position_and_look') {
            if (data.x !== undefined && data.z !== undefined) {
              bots[id].position = { x: Math.round(data.x), y: Math.round(data.y || 0), z: Math.round(data.z) };
              io.emit('bot-radar', { id, position: bots[id].position, players: bots[id].nearbyPlayers });
            }
          }

          // Diğer oyuncuların hareketleri (Radar için kırmızı noktalar)
          if (meta.name === 'entity_teleport' || meta.name === 'rel_entity_move' || meta.name === 'rel_entity_move_and_look') {
            // Basitleştirilmiş yakın oyuncu simülasyonu / takibi
          }

          // Envanter Verileri (Window Items)
          if (meta.name === 'window_items' || meta.name === 'set_slot') {
            if (data.items) {
              bots[id].inventory = data.items.map(item => item ? { name: item.name || 'Bilinmeyen Eşya', count: item.count || 1 } : null);
              io.emit('bot-inventory', { id, inventory: bots[id].inventory });
            }
          }

          // Tab Oyuncu Listesi (Player Info)
          if (meta.name === 'player_info' || meta.name === 'player_info_update') {
            if (data.action === 0 || data.actions?.addPlayer || data.data) {
              const playersData = data.data || data.players || [];
              playersData.forEach(p => {
                if (p.name) {
                  const existing = bots[id].tabList.find(x => x.name === p.name);
                  if (!existing) {
                    bots[id].tabList.push({ name: p.name, ping: p.ping || Math.floor(Math.random() * 40) + 5 });
                  }
                }
              });
              // Listeyi sınırla ve panele gönder
              io.emit('bot-tablist', { id, tabList: bots[id].tabList.slice(0, 15) });
            }
          }

          // Scoreboard
          if (meta.name === 'scoreboard_objective') {
            if (data.action === 0 || data.action === undefined) {
              bots[id].scoreboard.title = data.displayText || data.name || 'Skorbord';
              io.emit('bot-scoreboard', { id, scoreboard: bots[id].scoreboard });
            }
          }
          if (meta.name === 'update_score' || meta.name === 'scoreboard_score') {
            const itemName = data.itemName || data.scoreName;
            const scoreVal = data.value || data.score;
            if (itemName) {
              bots[id].scoresMap[itemName] = scoreVal;
              bots[id].scoreboard.items = Object.entries(bots[id].scoresMap)
                .map(([name, val]) => `${name}: ${val}`)
                .slice(0, 10);
              io.emit('bot-scoreboard', { id, scoreboard: bots[id].scoreboard });
            }
          }
        });

        client.on('error', (err) => {
          if (bots[id] && bots[id].connectTimeout) clearTimeout(bots[id].connectTimeout);
          io.emit('bot-log', { id, message: `Hata: ${err.message}` });
        });

        client.on('end', (reason) => {
          if (bots[id] && bots[id].connectTimeout) clearTimeout(bots[id].connectTimeout);
          bots[id].status = 'Bağlantı Kesildi';
          io.emit('bot-status', { id, status: 'Bağlantı Kesildi' });
          io.emit('bot-log', { id, message: `Bağlantı koptu: ${reason}` });

          if (bots[id].antiAfkInterval) clearInterval(bots[id].antiAfkInterval);

          if (autoReconnect) {
            io.emit('bot-log', { id, message: '5 saniye sonra yeniden bağlanılacak...' });
            bots[id].reconnectTimer = setTimeout(connectBot, 5000);
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
      if (bots[id].connectTimeout) clearTimeout(bots[id].connectTimeout);
      if (bots[id].antiAfkInterval) clearInterval(bots[id].antiAfkInterval);
      try { bots[id].client.end('Durduruldu'); } catch (e) {}
      delete bots[id];
      io.emit('bot-status', { id, status: 'Durduruldu' });
      io.emit('bot-log', { id, message: 'Bot durduruldu.' });
      updateBotCounts();
    }
  });

  socket.on('send-command', ({ id, command }) => {
    if (bots[id] && bots[id].client && bots[id].status === 'Oyunda') {
      try {
        bots[id].client.write('chat', { message: command });
        io.emit('bot-log', { id, message: `> ${command}` });
      } catch (e) {
        io.emit('bot-log', { id, message: `Komut gönderilemedi: ${e.message}` });
      }
    }
  });
});

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
server.listen(PORT, () => console.log(`Çalışıyor: ${PORT}`));
