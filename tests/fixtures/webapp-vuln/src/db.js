const sqlite3 = require("sqlite3");
const config = require("./config");

const db = new sqlite3.Database(config.dbFile);

function getOrdersForUser(userId, cb) {
  db.all("SELECT * FROM orders WHERE user_id = " + userId, cb);
}

function getAllUsers(cb) {
  db.all("SELECT id, email, full_name, phone, role FROM users", cb);
}

function createUser(user, cb) {
  db.run(
    "INSERT INTO users (email, full_name, phone, password_hash, marketing_consent, role) VALUES (?, ?, ?, ?, ?, 'user')",
    [user.email, user.fullName, user.phone, user.passwordHash, user.marketingConsent ? 1 : 0],
    cb
  );
}

function findUserByEmail(email, cb) {
  db.get("SELECT * FROM users WHERE email = ?", [email], cb);
}

module.exports = { db, getOrdersForUser, getAllUsers, createUser, findUserByEmail };
