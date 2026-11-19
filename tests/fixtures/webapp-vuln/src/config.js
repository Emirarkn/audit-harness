// Application configuration
module.exports = {
  port: process.env.PORT || 3000,
  jwtSecret: "supersecret123",
  analyticsToken: "mp_tok_7f3a9c2e5b8d4f1a6e0c3b9d2a7f5e8c",
  analyticsUrl: "https://api.mixpanel.com/track",
  dbFile: "shop.db",
};
