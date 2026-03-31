// Keep the Vercel entrypoint explicitly CommonJS and delegate to the root app.
const appModule = require('../server.js');

module.exports = appModule.default || appModule;
