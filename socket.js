const path = require('path');
const socket = require('socket.io');
const jwtAuth = require('socketio-jwt-auth');
const child_process = require('child_process');
const { config } = require('./config');

const initSocket = (server) => {
  const io = socket(server);
  if (config.auth) {
    io.use(jwtAuth.authenticate({
      secret: config.jwtsecret
    }, (payload, done) => {
      const user = {
        name: payload.name,
        group: payload.group
      };

      if (user.name === 'admin') {
        done(null, user);
      } else {
        done(null, false, '只有 admin 账号能登录管理后台');
      }
    }));
  }

  let scanner = null;

  const startScannerProcess = (scriptPath, args = []) => {
    if (!scanner) {
      scanner = child_process.fork(path.join(__dirname, scriptPath), args, { silent: false });
      scanner.on('exit', (code) => {
        scanner = null;
        if (code) {
          io.emit('SCAN_ERROR');
        }
      });

      scanner.on('message', (m) => {
        if (m.event) {
          io.emit(m.event, m.payload);
        }
      });
    }
  };

  io.on('connection', function (socket) {
    socket.emit('success', {
      message: '成功登录管理后台.',
      user: socket.request.user,
      auth: config.auth
    });

    socket.on('ON_SCANNER_PAGE', () => {
      if (scanner) {
        scanner.send({
          emit: 'SCAN_INIT_STATE'
        });
      }
    });

    socket.on('PERFORM_SCAN', () => {
      startScannerProcess('./filesystem/scanner.js');
    });

    socket.on('PERFORM_UPDATE', () => {
      startScannerProcess('./filesystem/updater.js', ['--refreshAll']);
    });

    socket.on('PERFORM_LYRIC_SCAN', () => {
      startScannerProcess('./filesystem/workFileScanner.js');
    });

    socket.on('PERFORM_REVIEW_REFRESH', () => {
      startScannerProcess('./filesystem/reviewRefresher.js');
    });

    socket.on('KILL_SCAN_PROCESS', () => {
      if (scanner) {
        scanner.send({
          exit: 1
        });
      }
    });

    socket.on('error', (err) => {
      console.error(err);
    });
  });
};

module.exports = initSocket;
