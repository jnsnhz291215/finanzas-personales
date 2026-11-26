module.exports = {
  apps: [{
    name: 'finanzas-personales',
    script: './server/index.js',
    // Carpeta de la app: ahí está el .env que carga dotenv (se busca en el directorio de trabajo) y de ahí
    // salen ./server/index.js y ./logs, aunque PM2 se lance desde otra carpeta
    cwd: __dirname,
    // fork con una sola instancia: el bot de Telegram usa polling y no puede correr en dos procesos
    // (con "instances" PM2 pasa por defecto a modo cluster, así que se fija exec_mode)
    exec_mode: 'fork',
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '500M',
    env: {
      NODE_ENV: 'production',
      PORT: 3005
    },
    error_file: './logs/err.log',
    out_file: './logs/out.log',
    log_file: './logs/combined.log',
    time: true,
    // Formato fijo de la hora en los logs: update.sh lo usa para leer solo los logs del último arranque
    log_date_format: 'YYYY-MM-DDTHH:mm:ss'
  }]
};
